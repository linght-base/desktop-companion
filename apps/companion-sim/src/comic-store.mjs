// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { validClock, workdayBounds, workdayFor } from './day-window.mjs';

const SOURCES = new Set(['camera', 'replay', 'user', 'explicit_user', 'observed_interaction']);
const KINDS = new Set(['perception', 'episode', 'interaction']);
const MAX_BYTES = 49152, LEASE_MS = 60000, MAX_ATTEMPTS = 3;
const WINDOW_KEYS = ['timeZone', 'dayStart', 'startAt', 'endAt', 'closeAt'];
const decode = row => row ? JSON.parse(row.payload) : null;
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function dayValue(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new TypeError('Invalid day');
  return day;
}
function keys(object, allowed, name) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !allowed.includes(key))) throw new TypeError(`Invalid ${name} fields`);
}
function number(value, min, max, name) {
  if (!Number.isFinite(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`);
  return value;
}
function factual(record, deskId) {
  return !!record && record.status === 'active' && KINDS.has(record.kind) && SOURCES.has(record.source)
    && !/fixture|synthetic/i.test(`${record.mode ?? ''} ${record.provenance ?? ''}`) && record.deskId === deskId;
}
function eligible(record, { deskId, startAt, endAt }) {
  const at = record ? record.observedAt ?? record.at : undefined;
  return factual(record, deskId)
    && typeof record.summary === 'string' && record.summary.trim() && record.summary.length <= 2000
    && Number.isSafeInteger(record.revision) && record.revision > 0 && Number.isSafeInteger(at)
    && at >= startAt && at < endAt;
}
function publicSource(record) {
  return { id:record.id, kind:record.kind, revision:record.revision, deskId:record.deskId, source:record.source, status:record.status,
    summary:record.summary, observedAt:record.observedAt ?? record.at, coverage:record.coverage ?? 'unknown',
    uncertainties:(record.uncertainties ?? []).filter(v => typeof v === 'string').slice(0,32).map(v => v.slice(0,500)),
    entities:(record.entities ?? []).filter(e => typeof e.id === 'string' && typeof e.label === 'string').slice(0,32).map(e => ({id:e.id,label:e.label.slice(0,200),identityStatus:e.identityStatus ?? 'unconfirmed',...(e.kind === undefined ? {} : {kind:String(e.kind).slice(0,100)})})),
    evidenceIds:(record.evidenceIds ?? []).filter(id => typeof id === 'string').slice(0,32),
    evidenceRevisions:Object.fromEntries(Object.entries(record.evidenceRevisions ?? {}).filter(([id,revision]) => typeof id==='string' && Number.isSafeInteger(revision)).slice(0,32)), evidenceAvailability:record.evidenceAvailability ?? '原画面未留存，无法回放核查' };
}

/** Persists only reference/revision metadata and whitelisted layouts. Facts resolve from current continuity records. */
export function createComicStore({ path, clock = Date.now, readDiary, readEvidence }) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function' || typeof readDiary !== 'function' || typeof readEvidence !== 'function') throw new TypeError('Comic source callbacks required');
  const db = new DatabaseSync(path);
  let closed = false;
  db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS comic_settings (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_jobs (id TEXT PRIMARY KEY, day TEXT NOT NULL, desk_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(day,desk_id,fingerprint));
    CREATE TABLE IF NOT EXISTS comic_plans (job_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_scheduled (day TEXT NOT NULL, desk_id TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,desk_id));`);
  if (!db.prepare('PRAGMA table_info(comic_scheduled)').all().some(column=>column.name==='published')) {
    // Legacy markers cannot distinguish an invalidated publication from an
    // unpublished attempt. Preserve their prior automatic suppression policy;
    // only markers created after this migration may recover automatically.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('ALTER TABLE comic_scheduled ADD COLUMN published INTEGER NOT NULL DEFAULT 0; UPDATE comic_scheduled SET published=1; COMMIT;');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  db.prepare("INSERT OR IGNORE INTO comic_settings(id,payload) VALUES('current',?)").run(JSON.stringify({enabled:true,closeTime:'21:00',timeZone:'Asia/Shanghai',dayStart:'00:00'}));
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid clock'); return value; };
  const settings = () => ({dayStart:'00:00',...decode(db.prepare("SELECT payload FROM comic_settings WHERE id='current'").get())});
  const getJob = id => decode(db.prepare('SELECT payload FROM comic_jobs WHERE id=?').get(text(id,'jobId')));
  const scheduledState = (day, deskId) => db.prepare('SELECT published FROM comic_scheduled WHERE day=? AND desk_id=?').get(day,deskId);
  const jobs = (day, deskId) => db.prepare('SELECT payload FROM comic_jobs WHERE day=? AND desk_id=? ORDER BY rowid DESC').all(day,deskId).map(decode);
  function save(job) { db.prepare('INSERT INTO comic_jobs(id,day,desk_id,fingerprint,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id,job.day,job.deskId,job.fingerprint,JSON.stringify(job)); return job; }
  function withoutClaim(job) { const {claimToken,claimEpoch,leaseUntil,...rest}=job; return rest; }
  function boundsFor(day, config) { return workdayBounds(day, {dayStart:config.dayStart,timeZone:config.timeZone,closeTime:config.closeTime}); }
  function scope(input = {}) {
    const config=settings();
    const day=dayValue(input.day ?? workdayFor(now(),{dayStart:config.dayStart,timeZone:config.timeZone}));
    return {...boundsFor(day,config),deskId:text(input.deskId,'deskId'),frozen:true};
  }
  function scopeForJob(job) {
    if (Number.isSafeInteger(job.startAt) && Number.isSafeInteger(job.endAt)) {
      return {day:job.day,deskId:job.deskId,timeZone:job.timeZone,dayStart:job.dayStart,startAt:job.startAt,endAt:job.endAt,closeAt:job.closeAt,frozen:job.legacyFingerprint!==true};
    }
    const config=settings();
    return {...workdayBounds(job.day,{dayStart:'00:00',timeZone:config.timeZone,closeTime:config.closeTime}),deskId:job.deskId,frozen:false};
  }
  function recoveryScope(input) {
    if (WINDOW_KEYS.every(key => input[key] === undefined)) return null;
    if (WINDOW_KEYS.some(key => input[key] === undefined)) throw new TypeError('Incomplete comic window');
    const day=dayValue(input.day);
    let probe;
    try {
      validClock(input.dayStart);
      probe=workdayBounds(day,{dayStart:input.dayStart,timeZone:input.timeZone,closeTime:input.dayStart});
    } catch { throw new TypeError('Invalid comic window'); }
    const {startAt,endAt,closeAt}=input;
    if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || !Number.isSafeInteger(closeAt)
      || startAt!==probe.startAt || endAt!==probe.endAt || closeAt<startAt || closeAt>endAt) throw new TypeError('Invalid comic window');
    return {day,deskId:text(input.deskId,'deskId'),timeZone:input.timeZone,dayStart:input.dayStart,startAt,endAt,closeAt,frozen:true};
  }
  function references(record, deskId, seen = new Set()) {
    if (!factual(record, deskId)) return null;
    if (seen.has(record.id)) return [];
    seen.add(record.id);
    const result=[{id:record.id,revision:record.revision}];
    for (const [id,revision] of Object.entries(record.evidenceRevisions ?? {})) {
      const basis=readEvidence(id,{deskId});
      if (!basis || basis.status !== 'active' || basis.deskId !== deskId || basis.revision !== revision || !SOURCES.has(basis.source)) return null;
      const nested=references(basis,deskId,seen); if (!nested) return null; result.push(...nested);
    }
    return result;
  }
  function sources(scoped) {
    const diary=readDiary({day:scoped.day,deskId:scoped.deskId,timeZone:scoped.timeZone,startAt:scoped.startAt,endAt:scoped.endAt});
    if (!diary || !Array.isArray(diary.panels) || !Array.isArray(diary.gaps)) throw new TypeError('Invalid diary source');
    const seen=new Set();
    const panels=diary.panels.filter(r => eligible(r,scoped)).map(r => readEvidence(r.id,{deskId:scoped.deskId}))
      .filter(r => eligible(r,scoped) && references(r,scoped.deskId) && !seen.has(r.id) && seen.add(r.id))
      .sort((a,b) => (a.observedAt ?? a.at)-(b.observedAt ?? b.at) || a.id.localeCompare(b.id)).slice(0,100);
    const gaps=diary.gaps.filter(g => (!g.deskId || g.deskId===scoped.deskId) && Number.isFinite(g.startAt) && Number.isFinite(g.endAt) && g.endAt >= g.startAt)
      .slice(0,100).map(g => ({startAt:g.startAt,endAt:g.endAt,reason:typeof g.reason==='string'?g.reason.slice(0,500):'未连续观察，不推断期间的活动',...(g.source===undefined?{}:{source:SOURCES.has(g.source)?g.source:'unknown'})}));
    const refs=panels.map(r => references(r,scoped.deskId));
    const refsFingerprint=createHash('sha256').update(JSON.stringify(refs)).digest('hex');
    // Frozen windows join the fingerprint so a settings change never aliases an
    // older book's identical facts; legacy jobs keep the refs-only fingerprint.
    const fingerprint=scoped.frozen
      ? createHash('sha256').update(JSON.stringify({window:{timeZone:scoped.timeZone,dayStart:scoped.dayStart,startAt:scoped.startAt,endAt:scoped.endAt},refs})).digest('hex')
      : refsFingerprint;
    return {panels,gaps,fingerprint,refsFingerprint};
  }
  function invalidate(job) {
    db.prepare('DELETE FROM comic_plans WHERE job_id=?').run(job.id);
    return save({...withoutClaim(job),status:'invalidated',updatedAt:now()});
  }
  function reconcile(job) {
    const plan=decode(db.prepare('SELECT payload FROM comic_plans WHERE job_id=?').get(job.id));
    if (plan && plan.refs.some(ref => {const r=readEvidence(ref.id,{deskId:job.deskId});return !r || r.status!=='active' || r.revision!==ref.revision || r.deskId!==job.deskId;})) return invalidate(job);
    return job;
  }
  function bookFor(job) {
    job=reconcile(job);
    const scoped=scopeForJob(job), fresh=sources(scoped);
    const plan=decode(db.prepare('SELECT payload FROM comic_plans WHERE job_id=?').get(job.id));
    const panels=(plan?.panels ?? []).map(panel => {
      const r=readEvidence(panel.basisId,{deskId:job.deskId});
      if (!eligible(r,scoped) || r.revision!==panel.revision) return null;
      const source=publicSource(r);
      return {basisId:r.id,revision:r.revision,summary:source.summary,source:source.source,observedAt:source.observedAt,coverage:source.coverage,uncertainties:source.uncertainties,entities:source.entities,evidenceAvailability:source.evidenceAvailability,objects:panel.objects,robot:panel.robot};
    }).filter(Boolean);
    return {id:job.id,jobId:job.id,day:job.day,deskId:job.deskId,timeZone:scoped.timeZone,dayStart:scoped.dayStart,startAt:scoped.startAt,endAt:scoped.endAt,closeAt:scoped.closeAt,status:job.status==='published'?'published':job.status==='invalidated'?'invalidated':'draft',panels,gaps:fresh.gaps,updatedAt:job.updatedAt};
  }
  function request(input) {
    keys(input,['day','deskId','reason',...WINDOW_KEYS],'request');
    const scoped=recoveryScope(input) ?? scope(input); if (!['manual','scheduled'].includes(input.reason)) throw new TypeError('Invalid comic reason');
    for (const job of jobs(scoped.day,scoped.deskId)) reconcile(job);
    const fresh=sources(scoped);
    const existing=jobs(scoped.day,scoped.deskId).find(job=>{
      const old=scopeForJob(job);
      return old.startAt===scoped.startAt&&old.endAt===scoped.endAt&&old.timeZone===scoped.timeZone&&job.fingerprint===(old.frozen?fresh.fingerprint:fresh.refsFingerprint);
    });
    if (existing) return withoutClaim(existing);
    return save({id:randomUUID(),day:scoped.day,deskId:scoped.deskId,reason:input.reason,fingerprint:fresh.fingerprint,timeZone:scoped.timeZone,dayStart:scoped.dayStart,startAt:scoped.startAt,endAt:scoped.endAt,closeAt:scoped.closeAt,status:fresh.panels.length?'pending':'blank',attempts:0,nextAttemptAt:now(),createdAt:now(),updatedAt:now()});
  }
  function owned(job, claimToken, context) {
    if (!job || job.status!=='claimed' || !claimToken || job.claimToken!==claimToken || job.leaseUntil<=now()) throw new TypeError('Comic claim is stale or not owned');
    if (context && (context.deskId!==job.deskId || context.epoch!==job.claimEpoch)) throw new TypeError('Comic claim epoch or desk changed');
  }
  // Freeze legacy natural days while their original settings are still known.
  // Retain their refs-only fingerprints so pending claims and published books
  // survive the migration; subsequent settings changes cannot reinterpret them.
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const row of db.prepare('SELECT payload FROM comic_jobs').all()){
      const job=decode(row);if(Number.isSafeInteger(job.startAt)&&Number.isSafeInteger(job.endAt))continue;
      const legacy=scopeForJob(job);save({...job,timeZone:legacy.timeZone,dayStart:'00:00',startAt:legacy.startAt,endAt:legacy.endAt,closeAt:legacy.closeAt,legacyFingerprint:true});
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
  const api={
    settings,
    scopeForDay(input = {}) {
      keys(input,['day','deskId'],'scopeForDay');
      const config=settings();
      const day=dayValue(input.day ?? workdayFor(now(),{dayStart:config.dayStart,timeZone:config.timeZone}));
      return {...boundsFor(day,config),deskId:text(input.deskId,'deskId')};
    },
    configure(input) {
      keys(input,['enabled','closeTime','timeZone','dayStart'],'settings'); const next={...settings(),...input};
      if (typeof next.enabled!=='boolean' || typeof next.closeTime!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.closeTime)
        || typeof next.dayStart!=='string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(next.dayStart)) throw new TypeError('Invalid comic settings');
      text(next.timeZone,'timeZone'); workdayFor(now(),{dayStart:next.dayStart,timeZone:next.timeZone});
      db.prepare("UPDATE comic_settings SET payload=? WHERE id='current'").run(JSON.stringify(next)); return next;
    },
    request,
    claimDue({enabled,epoch,deskId}) {
      deskId=text(deskId,'deskId'); if (epoch===undefined || (typeof epoch!=='string' && !Number.isSafeInteger(epoch))) throw new TypeError('Host epoch required');
      const config=settings();
      if (enabled!==true || !config.enabled) return null;
      const day=workdayFor(now(),{dayStart:config.dayStart,timeZone:config.timeZone});
      const bounds=boundsFor(day,config);
      const daily=jobs(day,deskId);
      const scheduledAttempts=daily.filter(job=>job.reason==='scheduled').reduce((sum,job)=>sum+job.attempts,0);
      const published=scheduledState(day,deskId)?.published || daily.some(job=>job.status==='published');
      const composing=daily.some(job=>job.status==='claimed' && job.leaseUntil>now() && job.claimEpoch===epoch);
      // A marker suppresses duplicate publication, not recovery before any publication.
      // Replacement jobs share a persisted three-claim daily budget across restarts.
      if (now()>=bounds.closeAt && !published && !composing && scheduledAttempts<MAX_ATTEMPTS) {
        request({day,deskId,reason:'scheduled'});
        db.prepare('INSERT OR IGNORE INTO comic_scheduled(day,desk_id) VALUES(?,?)').run(day,deskId);
      }
      const pending=db.prepare('SELECT payload FROM comic_jobs WHERE desk_id=? ORDER BY rowid').all(deskId).map(decode);
      for (let job of pending) {
        job=reconcile(job);
        if (job.status==='claimed' && (job.leaseUntil<=now() || job.claimEpoch!==epoch)) {
          job=save({...withoutClaim(job),status:job.attempts>=MAX_ATTEMPTS?'failed':'pending',nextAttemptAt:now(),updatedAt:now()});
        }
        if (job.status!=='pending' || job.nextAttemptAt>now()) continue;
        if (job.reason==='scheduled') {
          const dayJobs=jobs(job.day,job.deskId);
          if (scheduledState(job.day,job.deskId)?.published || dayJobs.some(item=>item.status==='published')) {invalidate(job);continue;}
          if (dayJobs.filter(item=>item.reason==='scheduled').reduce((sum,item)=>sum+item.attempts,0)>=MAX_ATTEMPTS) {save({...withoutClaim(job),status:'failed',updatedAt:now()});continue;}
        }
        const fresh=sources(scopeForJob(job));
        if (fresh.fingerprint!==job.fingerprint) {invalidate(job);continue;}
        job=save({...job,status:'claimed',attempts:job.attempts+1,claimToken:randomUUID(),claimEpoch:epoch,leaseUntil:now()+LEASE_MS,updatedAt:now()});
        return {...job};
      }
      return null;
    },
    candidates(jobId) {
      const job=getJob(jobId); if (!job) throw new TypeError('Unknown comic job');
      const fresh=sources(scopeForJob(job));const result={jobId:job.id,day:job.day,deskId:job.deskId,fingerprint:fresh.fingerprint,panels:[],gaps:[],truncated:false};
      // Reserve room for unknown intervals before filling the model's evidence budget.
      for (const gap of fresh.gaps) {result.gaps.push(gap);if(Buffer.byteLength(JSON.stringify(result))>8192){result.gaps.pop();result.truncated=true;break;}}
      for (const panel of fresh.panels) {
        const p={...publicSource(panel),metadataTruncated:false};
        while (Buffer.byteLength(JSON.stringify(p))>18000 && (p.entities.length>1 || p.uncertainties.length>1)) {
          if (p.entities.length>1) p.entities.pop();
          if (p.uncertainties.length>1) p.uncertainties.pop();
          p.metadataTruncated=true;
        }
        result.panels.push(p);
        if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES){result.panels.pop();result.truncated=true;break;}
      }
      return result;
    },
    publish(input,context) {
      keys(input,['jobId','claimToken','panels'],'publish');
      keys(context,['epoch','deskId'],'host context');
      if ((!Number.isSafeInteger(context.epoch) || context.epoch<0) && (typeof context.epoch!=='string' || !context.epoch.trim() || context.epoch.length>200)) throw new TypeError('Host epoch required');
      text(context.deskId,'host deskId');
      const job=getJob(input.jobId); owned(job,input.claimToken,context);
      if (job.reason==='scheduled' && scheduledState(job.day,job.deskId)?.published) {invalidate(job);throw new TypeError('Daily scheduled comic already published');}
      const scoped=scopeForJob(job), fresh=sources(scoped);
      if (fresh.fingerprint!==job.fingerprint) {invalidate(job);throw new TypeError('Comic sources revised');}
      if (!Array.isArray(input.panels) || input.panels.length<1 || input.panels.length>6) throw new TypeError('Comic needs 1–6 panels');
      const allowed=new Map(fresh.panels.map(p=>[p.id,p]));const seen=new Set();let previous=-Infinity;const refs=new Map();
      const panels=input.panels.map(panel=>{
        keys(panel,['basisId','objects','robot'],'panel');const basisId=text(panel.basisId,'basisId');const r=allowed.get(basisId);
        if (!r || seen.has(basisId) || (r.observedAt??r.at)<previous) throw new TypeError('Invalid or out-of-order comic evidence');
        seen.add(basisId);previous=r.observedAt??r.at;
        for (const ref of references(r,job.deskId)) refs.set(ref.id,ref);
        const entities=new Set((r.entities??[]).map(e=>e.id));const objects=panel.objects??[];
        if (!Array.isArray(objects)||objects.length>16) throw new TypeError('Invalid comic objects');
        const layout=objects.map(object=>{
          keys(object,['entityId','shape','x','y','width','height','rotation'],'object');
          if (!entities.has(object.entityId)||!['rect','ellipse'].includes(object.shape)) throw new TypeError('Entity evidence required');
          const x=number(object.x,0,1,'x'), y=number(object.y,0,1,'y'), width=number(object.width,0.01,1,'width'), height=number(object.height,0.01,1,'height');
          if (x+width>1||y+height>1) throw new TypeError('Object exceeds panel');
          return {entityId:object.entityId,shape:object.shape,x,y,width,height,...(object.rotation===undefined?{}:{rotation:number(object.rotation,-180,180,'rotation')})};
        });
        const robot=panel.robot??{};keys(robot,['gazeX','gazeY','openness','tilt'],'robot');const expression={};
        for (const [key,value] of Object.entries(robot)) expression[key]=number(value,key==='openness'?0:key==='tilt'?-30:-1,key==='openness'?1:key==='tilt'?30:1,key);
        return {basisId,revision:r.revision,objects:layout,robot:expression};
      });
      db.prepare('INSERT INTO comic_plans(job_id,payload) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload').run(job.id,JSON.stringify({panels,refs:[...refs.values()]}));
      db.prepare('INSERT INTO comic_scheduled(day,desk_id,published) VALUES(?,?,1) ON CONFLICT(day,desk_id) DO UPDATE SET published=1').run(job.day,job.deskId);
      return bookFor(save({...withoutClaim(job),status:'published',updatedAt:now()}));
    },
    release(jobId,{claimToken,reason}) {
      const job=getJob(jobId);owned(job,claimToken);text(reason,'release reason',500);
      // Reasons are scheduler diagnostics; never persist caller text or generated factual prose.
      return save({...withoutClaim(job),status:job.attempts>=MAX_ATTEMPTS?'failed':'pending',nextAttemptAt:now()+Math.min(60000,1000*2**job.attempts),updatedAt:now()});
    },
    invalidateEvidence(id) {
      text(id,'evidence id');const affected=[],scopes=new Map();
      for (const row of db.prepare('SELECT job_id,payload FROM comic_plans').all()) {
        const plan=JSON.parse(row.payload);if (plan.refs.some(ref=>ref.id===id)) {
          const job=invalidate(getJob(row.job_id));affected.push(job.id);
          const scoped=scopeForJob(job);
          scopes.set(JSON.stringify([job.day,job.deskId,scoped.startAt]),{day:job.day,deskId:job.deskId,timeZone:scoped.timeZone,dayStart:scoped.dayStart,startAt:scoped.startAt,endAt:scoped.endAt,closeAt:scoped.closeAt});
        }
      }
      return {invalidatedJobIds:affected,invalidatedScopes:[...scopes.values()]};
    },
    current(input) {const scoped=scope(input);const job=jobs(scoped.day,scoped.deskId)[0];return job?bookFor(job):null;},
    snapshot(input) {const scoped=scope(input);const book=api.current(scoped);return {book,jobs:jobs(scoped.day,scoped.deskId).map(withoutClaim),settings:settings()};},
    close() {if(!closed){db.close();closed=true;}},
  };
  return api;
}
