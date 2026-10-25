// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {recordVisualSubjects} from './comic-characters.mjs';
import { validateVideoStream } from './contracts.mjs';

const TABLES = {
  perception: 'continuity_perception_events', episode: 'continuity_episodes',
  understanding: 'continuity_beliefs', hypothesis: 'continuity_beliefs',
  interest: 'continuity_interests', interaction: 'continuity_interactions',
};
const LIVE = new Set(['active', 'tentative']);
const STATUSES = ['active', 'tentative', 'invalidated', 'superseded', 'retracted', 'deleted', 'resolved', 'dismissed', 'paused'];
const INTERACTIONS = ['seen', 'snooze', 'done', 'dismiss', 'no_response', 'accepted', 'declined', 'explicit_feedback', 'reminder_response'];
const LEARNING_USES = ['allowed', 'test', 'holdout', 'denied', 'unknown'];
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function timestamp(value, name = 'at') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new TypeError(`Invalid ${name}`);
  return value;
}
function member(value, options, name) {
  if (!options.includes(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
function learningEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid learningVersion');
  return value;
}
function ids(value = []) {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError('Invalid evidenceIds');
  return [...new Set(value.map(id => text(id, 'evidence id', 200)))];
}
function strictKeys(value, allowed, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Invalid ${name}`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Invalid ${name}`);
}
function mergeSegments(segments) {
  const sorted = segments
    .map(segment => ({ startAt: timestamp(segment?.startAt, 'segment start'), endAt: timestamp(segment?.endAt, 'segment end') }))
    .filter(segment => segment.endAt >= segment.startAt)
    .sort((a, b) => a.startAt - b.startAt || a.endAt - b.endAt);
  const merged = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && segment.startAt <= last.endAt) last.endAt = Math.max(last.endAt, segment.endAt);
    else merged.push({ ...segment });
  }
  return merged;
}
const LEARNING_STRICTNESS = { denied: 0, holdout: 1, test: 2, unknown: 3, allowed: 4 };
// Never upgrades mixed grants: denied > holdout > test > unknown > allowed.
function deriveLearning(evidence) {
  const uses = evidence.map(item => LEARNING_USES.includes(item.learningUse) ? item.learningUse : 'unknown');
  if (uses.every(use => use === 'allowed')) {
    const versions = [...new Set(evidence.map(item => item.learningVersion))];
    if (versions.length === 1 && Number.isSafeInteger(versions[0]) && versions[0] >= 1) return { learningUse: 'allowed', learningVersion: versions[0] };
    return { learningUse: 'unknown' };
  }
  return { learningUse: uses.reduce((strictest, use) => LEARNING_STRICTNESS[use] < LEARNING_STRICTNESS[strictest] ? use : strictest) };
}
function tokens(value) {
  const normalized = value.normalize('NFKC').toLowerCase();
  const words = [...segmenter.segment(normalized)].filter(part => part.isWordLike).map(part => part.segment);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words.filter(word => word.length > 1 || /[a-z0-9]/.test(word)))];
}
const unpack = row => row ? JSON.parse(row.payload) : null;
const observationKey = (deskId,source,basis) => createHash('sha256').update(JSON.stringify([deskId,source,basis])).digest('hex');
const dayFor = at => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
function localDayBounds(day,timeZone){
  const format=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  const local=at=>{const p=Object.fromEntries(format.formatToParts(at).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
  const utc=Date.parse(`${day}T00:00:00Z`);
  const boundary=wanted=>{let lo=utc-2*86400000,hi=utc+3*86400000;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(local(mid)<wanted)lo=mid+1;else hi=mid;}return lo;};
  const next=new Date(utc+86400000).toISOString().slice(0,10);return [boundary(day),boundary(next)];
}

/** Product continuity only. Host validates issued observations and action authority. No images are retained. */
export function createContinuityStore({ path, clock = Date.now }) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new TypeError('Invalid clock');
  const db = new DatabaseSync(path);
  let closed = false,diaryCache=null;
  // Latest-revision records are mirrored in memory so reads never rescan or
  // reparse whole tables. Every mutation applies through this cache first and
  // is rolled back with its transaction; nothing outside can reach the stored
  // objects (all public reads return structured clones).
  const TABLE_LIST=[...new Set(Object.values(TABLES))];
  const currentCache=new Map(TABLE_LIST.map(table=>[table,new Map()]));
  const maxCachedRecords=20000;
  let putSeq=0,undoLog=null,cacheEnabled=true,cacheSize=0;
  function disableCache(){cacheEnabled=false;cacheSize=0;for(const bucket of currentCache.values())bucket.clear();}
  function cachePut(table,record){
    if(!cacheEnabled)return;
    const bucket=currentCache.get(table),had=bucket.get(record.id);
    if(had&&record.revision<=had.record.revision)return;
    if(!had&&cacheSize>=maxCachedRecords){disableCache();return;}
    if(!had)cacheSize++;
    bucket.set(record.id,{record,seq:++putSeq});
    undoLog?.push(()=>{if(!cacheEnabled)return;if(had===undefined){bucket.delete(record.id);cacheSize--;}else bucket.set(record.id,had);});
  }
  function cacheDelete(id){
    if(!cacheEnabled)return;
    for(const table of TABLE_LIST){
      const bucket=currentCache.get(table),had=bucket.get(id);
      if(had===undefined)continue;
      bucket.delete(id);cacheSize--;
      undoLog?.push(()=>{if(cacheEnabled){bucket.set(id,had);cacheSize++;}});
    }
  }
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;');
    for (const table of new Set(Object.values(TABLES))) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(id,revision));`);
    db.exec(`CREATE TABLE IF NOT EXISTS continuity_entities (id TEXT NOT NULL, perception_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,perception_id));
      CREATE TABLE IF NOT EXISTS continuity_profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS continuity_episode_requests (desk_id TEXT NOT NULL, request_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, episode_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(desk_id,request_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS continuity_search USING fts5(id UNINDEXED, terms, tokenize='unicode61');`);
    db.exec(`CREATE INDEX IF NOT EXISTS continuity_perception_scope_basis ON continuity_perception_events(json_extract(payload,'$.deskId'),json_extract(payload,'$.source'),json_extract(payload,'$.basisObservationId'));
      CREATE INDEX IF NOT EXISTS continuity_perception_deleted_key ON continuity_perception_events(json_extract(payload,'$.deletionKey'));`);
    // FTS5 otherwise retains deleted tokens in its own historical segments.
    db.exec("INSERT INTO continuity_search(continuity_search,rank) VALUES('secure-delete',1);");
    // Reconstruct from persisted current revisions before exposing any reads.
    // Large histories fall back to SQLite rather than growing an unbounded mirror.
    for(const table of TABLE_LIST){
      const remaining=maxCachedRecords-cacheSize;
      const {count}=db.prepare(`SELECT COUNT(*) AS count FROM (SELECT id FROM ${table} GROUP BY id LIMIT ?)`).get(remaining+1);
      if(count>remaining){disableCache();break;}
      for(const row of db.prepare(`SELECT m.payload FROM ${table} m WHERE m.revision=(SELECT MAX(revision) FROM ${table} WHERE id=m.id) ORDER BY m.rowid`).iterate())cachePut(table,unpack(row));
    }
  } catch (error) { db.close(); throw error; }
  const now = () => timestamp(clock(), 'clock');
  db.prepare("INSERT OR IGNORE INTO continuity_profiles(id,payload) VALUES('current',?)").run(JSON.stringify({
    deskId: 'desk-default', quietMode: true, curiosity: 'gentle', expressionLearning: false, learningVersion: 1, learningSince: null,
    version: 1, updatedAt: now(), source: 'product_default',
  }));
  const storedProfile = profile();
  if (storedProfile.expressionLearning === undefined || storedProfile.learningVersion === undefined || storedProfile.learningSince === undefined) {
    db.prepare("UPDATE continuity_profiles SET payload=? WHERE id='current'").run(JSON.stringify({
      expressionLearning: false, learningVersion: 1, learningSince: null, ...storedProfile,
    }));
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    const undo=[],outer=undoLog;undoLog=undo;
    try { const result = fn(); db.exec('COMMIT'); undoLog=outer; return result; }
    catch (error) {
      db.exec('ROLLBACK'); undoLog=outer;
      // The cache mirrors committed state: replay inverse operations so a
      // rolled-back write never survives in memory.
      for(let i=undo.length-1;i>=0;i--)undo[i]();
      throw error;
    }
  }
  // Ordered like the previous SQL: latest revision per id, at DESC, then
  // insertion order DESC (rowid DESC); seq follows insertion order.
  function current(table,limit) {
    if(!cacheEnabled)return db.prepare(`SELECT m.payload FROM ${table} m WHERE m.revision=(SELECT MAX(revision) FROM ${table} WHERE id=m.id) ORDER BY m.at DESC,m.rowid DESC${limit===undefined?'':' LIMIT ?'}`).all(...(limit===undefined?[]:[limit])).map(unpack);
    const entries=[...currentCache.get(table).values()].sort((a,b)=>b.record.at-a.record.at||b.seq-a.seq);
    return (limit===undefined?entries:entries.slice(0,limit)).map(entry=>entry.record);
  }
  function records() { return TABLE_LIST.flatMap(table=>current(table)); }
  function get(id) {
    for (const table of TABLE_LIST) {
      const record=cacheEnabled?currentCache.get(table).get(id)?.record:unpack(db.prepare(`SELECT payload FROM ${table} WHERE id=? ORDER BY revision DESC LIMIT 1`).get(id));
      if(record)return record;
    }
    return null;
  }
  function getAtRevision(kind, id, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    return unpack(db.prepare(`SELECT payload FROM ${TABLES[kind]} WHERE id=? AND revision=?`).get(id, revision));
  }
  function searchable(record) {
    return [record.summary, record.activity, dayFor(record.observedAt ?? record.at), ...(record.entities ?? []).flatMap(entity => [entity.key, entity.label, entity.kind, entity.location]), ...(record.entityLabels ?? [])].filter(Boolean).join(' ');
  }
  function put(record) {
    diaryCache=null;
    db.prepare(`INSERT INTO ${TABLES[record.kind]}(id,revision,at,status,payload) VALUES(?,?,?,?,?)`).run(record.id, record.revision, record.at, record.status, JSON.stringify(record));
    db.prepare('DELETE FROM continuity_search WHERE id=?').run(record.id);
    if (LIVE.has(record.status) && record.kind !== 'interest') db.prepare('INSERT INTO continuity_search(id,terms) VALUES(?,?)').run(record.id, tokens(searchable(record)).join(' '));
    cachePut(TABLES[record.kind],record);
    return record;
  }
  function grounded(evidenceIds, allowed = ['perception', 'episode']) {
    const references = ids(evidenceIds);
    if (!references.length) throw new TypeError('Semantic evidence required');
    const evidence = references.map(get);
    if (evidence.some(item => !item || !LIVE.has(item.status) || !allowed.includes(item.kind))) throw new TypeError('Current active semantic evidence required');
    if (new Set(evidence.map(item => item.deskId)).size !== 1 || new Set(evidence.map(item => item.source)).size !== 1) throw new TypeError('Evidence must share desk and source scope');
    return { references, evidence };
  }
  function derivedBase(evidence) {
    if (evidence[0].deskId !== profile().deskId) throw new TypeError('Evidence desk differs from active profile scope');
    return { source: evidence[0].source, deskId: evidence[0].deskId,
      evidenceRevisions: Object.fromEntries(evidence.map(item => [item.id, item.revision])),
      entityIds: [...new Set(evidence.flatMap(item => item.entityIds ?? []))],
      entityLabels: [...new Set(evidence.flatMap(item => (item.entities ?? []).map(entity => entity.label)))],
      observedAt: Math.min(...evidence.map(item => item.observedAt ?? item.at)),
      rawImagesRetained: false };
  }
  function invalidateDependents(changedId, reason) {
    const queue = [changedId];
    const invalidated = new Set([changedId]);
    while (queue.length) {
      const id = queue.shift();
      for (const record of records()) {
        if (invalidated.has(record.id) || !['active', 'tentative', 'paused'].includes(record.status) || !record.evidenceIds.includes(id)) continue;
        put({ ...record, revision: record.revision + 1, previousRevision: record.revision, updatedAt: now(), status: 'invalidated', reason: `Evidence ${id} revised: ${reason}` });
        invalidated.add(record.id); queue.push(record.id);
      }
    }
  }
  function affectedEvidenceIds(id) {
    text(id, 'evidence id', 200);
    if (!get(id)) return [];
    // Traverse every revision, including inactive records and superseded links.
    const history=TABLE_LIST.flatMap(table=>db.prepare(`SELECT payload FROM ${table}`).all().map(unpack));
    const removed=new Set([id]);
    let changed=true;
    while(changed){changed=false;for(const record of history){
      if(!removed.has(record.id)&&(record.evidenceIds??[]).some(id=>removed.has(id))){removed.add(record.id);changed=true;}
    }}
    return [...removed];
  }
  function deleteMemory(previous) {
    for(const id of affectedEvidenceIds(previous.id)){
      const record=get(id);
      for(const table of TABLE_LIST)db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      cacheDelete(id);
      db.prepare('DELETE FROM continuity_entities WHERE perception_id=?').run(id);
      db.prepare('DELETE FROM continuity_search WHERE id=?').run(id);
      // No summary, reason, entity labels or other personal content in tombstones.
      put({id,kind:record.kind,status:'deleted',revision:record.revision+1,at:now(),evidenceIds:[],entityIds:[],
        ...(record.kind==='perception'?{deletionKey:record.deletionKey??observationKey(record.deskId,record.source,record.basisObservationId)}:{})});
    }
    // Also discard obsolete FTS segments created by older app versions before
    // secure-delete was enabled. Rebuild reads only surviving index content.
    db.exec("INSERT INTO continuity_search(continuity_search) VALUES('rebuild');");
    return get(previous.id);
  }
  function profile() {
    return unpack(db.prepare("SELECT payload FROM continuity_profiles WHERE id='current'").get()) ?? {
      deskId: 'desk-default', quietMode: true, curiosity: 'gentle', expressionLearning: false, learningVersion: 1, learningSince: null,
      version: 1, updatedAt: now(), source: 'product_default',
    };
  }
  return {
    recordPerception({ basisObservationId, description, activity, entities = [], uncertainties = [], visualSubjects = [] }, { observation, mode, deskId = profile().deskId, learningUse = 'unknown', learningVersion } = {}) {
      if (/fixture|synthetic/i.test(mode ?? '') || !['camera', 'replay'].includes(observation?.source)) return { accepted: false, status: 'rejected', reason: 'not_supported' };
      member(learningUse, LEARNING_USES, 'learningUse');
      if (learningUse === 'allowed' || learningVersion !== undefined) learningEpoch(learningVersion);
      const basis = text(basisObservationId, 'basisObservationId', 200);
      if (observation.id !== basis) throw new TypeError('Observation evidence mismatch');
      deskId = text(deskId, 'deskId', 200);
      const source = observation.source;
      const key=observationKey(deskId,source,basis);
      const previous=unpack(db.prepare(`SELECT m.payload FROM continuity_perception_events m WHERE m.revision=(SELECT MAX(revision) FROM continuity_perception_events WHERE id=m.id) AND (json_extract(m.payload,'$.deletionKey')=? OR (json_extract(m.payload,'$.deskId')=? AND json_extract(m.payload,'$.source')=? AND json_extract(m.payload,'$.basisObservationId')=?)) ORDER BY m.at DESC,m.rowid DESC LIMIT 1`).get(key,deskId,source,basis));
      if (previous) return previous;
      const summary = text(description, 'description');
      if (!Array.isArray(observation.frames) || !observation.frames.length || observation.frames.length > 4) throw new TypeError('Invalid observation frames');
      const frameTimes = [...new Set(observation.frames.map(frame => timestamp(frame.at, 'frame time')))].sort((a,b) => a-b);
      const observedAt = timestamp(observation.at, 'observation time');
      if (!Array.isArray(entities) || entities.length > 32 || !Array.isArray(uncertainties) || uncertainties.length > 32) throw new TypeError('Invalid perceptual metadata');
      const scopedEntities = entities.map(entity => {
        const key = text(entity.key, 'entity key', 200);
        // Model keys help retrieve related descriptions; they do not prove identity.
        const id = `entity:${createHash('sha256').update(JSON.stringify([deskId, source, basis, key])).digest('hex')}`;
        return { id, key, objectKey: key, label: text(entity.label, 'entity label', 200), deskId, identityStatus: 'unconfirmed',
          ...(entity.kind === undefined ? {} : { kind: text(entity.kind, 'entity kind', 100) }),
          ...(entity.location === undefined ? {} : { location: text(entity.location, 'entity location', 500) }) };
      });
      const record = {
        id: randomUUID(), kind: 'perception', summary, description: summary, source, deskId, accepted: true,
        learningUse, ...(learningVersion === undefined ? {} : { learningVersion }),
        status: 'active', revision: 1, at: now(), observedAt, updatedAt: now(),
        basisObservationId: basis, evidenceIds: [basis], claimType: 'visual_observation',
        coverage: member(observation.coverage, ['visible', 'partial', 'unknown'], 'coverage'),
        ...(observation.stream===undefined?{}:{stream:validateVideoStream(observation.stream,{frames:observation.frames,at:observedAt})}),
        frameTimes, visibleSegments: frameTimes.map(at => ({ startAt: at, endAt: at })),
        observedDurationMs: 0, gaps: frameTimes.slice(1).map((at, i) => ({ startAt: frameTimes[i], endAt: at, reason: '采样帧之间未连续观察' })),
        visualSubjects: recordVisualSubjects(visualSubjects,{readEvidence:id=>get(id),deskId,source,observedAt}),
        entities: scopedEntities, entityIds: scopedEntities.map(entity => entity.id),
        uncertainties: uncertainties.map(value => text(value, 'uncertainty', 500)),
        rawImagesRetained: false, evidenceAvailability: '原画面未留存，无法回放核查',
        frameEvidence: observation.frames.map(frame => ({ at: frame.at, hash: createHash('sha256').update(frame.data ?? '').digest('hex'), mimeType: frame.mimeType, width: frame.width, height: frame.height })),
        ...(activity === undefined ? {} : { activity: text(activity, 'activity', 500) }),
      };
      return structuredClone(transaction(() => {
        put(record);
        for (const entity of scopedEntities) db.prepare('INSERT INTO continuity_entities(id,perception_id,payload) VALUES(?,?,?)').run(entity.id, record.id, JSON.stringify(entity));
        // Keep every sampled episode separate: temporal proximity cannot prove continuous activity.
        put({ ...record, accepted: undefined, id: randomUUID(), kind: 'episode', evidenceIds: [record.id], evidenceRevisions: { [record.id]: 1 } });
        return record;
      }));
    },
    recall({ query, deskId = profile().deskId, entityIds, limit = 6 } = {}) {
      deskId = text(deskId, 'deskId', 200);
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Invalid limit');
      limit = Math.min(limit, 50);
      const entities = ids(entityIds);
      const phrase = query === undefined || query === '' ? '' : text(query, 'query', 500).normalize('NFKC').toLowerCase();
      const queryTokens = tokens(phrase);
      let matches;
      if (phrase) {
        if (!queryTokens.length) return [];
        const expression = queryTokens.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ');
        matches = new Set(db.prepare('SELECT id FROM continuity_search WHERE continuity_search MATCH ?').all(expression).map(row => row.id));
      }
      const candidates = records().filter(record => LIVE.has(record.status) && record.deskId === deskId && record.kind !== 'interest'
        && (!matches || matches.has(record.id)) && (!entities.length || entities.some(id => record.entityIds.includes(id))));
      const ranked = candidates.map(record => {
        const content = searchable(record).normalize('NFKC').toLowerCase();
        const hits = queryTokens.filter(token => tokens(content).includes(token));
        const exact = phrase && content.includes(phrase);
        return { record, score: (exact ? 100 : 0) + hits.reduce((sum, token) => sum + token.length, 0) + (entities.length ? 50 : 0),
          matchReason: phrase ? `相关词：${hits.join('、')}${exact ? '；原文匹配' : ''}` : entities.length ? '同桌面的实体引用' : '当前桌面的有效记录' };
      }).sort((a,b) => b.score-a.score || b.record.at-a.record.at || (a.record.kind === 'perception' ? -1 : 1));
      const seen = new Set();
      const result = [];
      for (const { record, matchReason } of ranked) {
        const key = record.basisObservationId ? `${record.source}:${record.deskId}:${record.basisObservationId}:${record.summary}` : record.id;
        if (seen.has(key)) continue;
        seen.add(key); result.push({ ...structuredClone(record), matchReason });
        if (result.length === limit) break;
      }
      return result;
    },
    rememberBelief({ summary, evidenceIds, entityIds, kind = 'understanding' }) {
      member(kind, ['understanding', 'hypothesis'], 'belief kind');
      const { references, evidence } = grounded(evidenceIds);
      const base = derivedBase(evidence);
      if (entityIds !== undefined && ids(entityIds).some(id => !base.entityIds.includes(id))) throw new TypeError('Entity evidence required');
      return structuredClone(transaction(() => put({ ...base, id: randomUUID(), kind, summary: text(summary, 'summary'), at: now(), updatedAt: now(), revision: 1, status: 'tentative', evidenceIds: references, claimType: 'tentative_understanding' })));
    },
    upsertInterest({ id, question, evidenceIds, nextAt, status = 'active' }) {
      const previous = id === undefined ? null : get(text(id, 'id', 200));
      if(previous?.status==='deleted')throw new TypeError('Memory deleted');
      if (id !== undefined && (!previous || previous.kind !== 'interest')) throw new TypeError('Unknown interest id');
      const { references, evidence } = grounded(evidenceIds);
      member(status, ['active', 'paused', 'resolved', 'dismissed'], 'interest status');
      return structuredClone(transaction(() => put({ ...derivedBase(evidence), id: previous?.id ?? randomUUID(), kind: 'interest', question: text(question, 'question', 1000), summary: text(question, 'question', 1000),
        at: previous?.at ?? now(), updatedAt: now(), revision: (previous?.revision ?? 0) + 1, status, evidenceIds: references,
        ...(nextAt === undefined ? {} : { nextAt: timestamp(nextAt, 'nextAt') }) })));
    },
    recordInteraction({ kind, summary, deskId = profile().deskId, evidenceIds = [] }) {
      member(kind, INTERACTIONS, 'interaction kind');
      const references = ids(evidenceIds);
      if (references.length) {
        const { evidence } = grounded(references, ['perception', 'episode', 'interaction']);
        if (evidence[0].deskId !== deskId) throw new TypeError('Interaction evidence desk mismatch');
      }
      return structuredClone(transaction(() => put({ id: randomUUID(), kind: 'interaction', interactionKind: kind, summary: text(summary, 'summary'), deskId: text(deskId, 'deskId', 200),
        source: kind === 'no_response' ? 'observed_interaction' : 'explicit_user', at: now(), observedAt: now(), updatedAt: now(), revision: 1, status: 'active',
        evidenceIds: references, entityIds: [], learningUse: 'unknown', claimType: kind === 'no_response' ? 'no_response_detected' : 'explicit_user_choice' })));
    },
    composeEpisode(input, options = {}) {
      strictKeys(input, ['requestId', 'summary', 'activity', 'evidenceRefs', 'id', 'revision'], 'episode input');
      strictKeys(options, ['deskId'], 'composeEpisode options');
      const deskId = text(options.deskId ?? profile().deskId, 'deskId', 200);
      if (deskId !== profile().deskId) throw new TypeError('Episode desk differs from active profile scope');
      const requestId = text(input.requestId, 'requestId', 200);
      const summary = text(input.summary, 'summary', 2000);
      const activity = input.activity === undefined ? undefined : text(input.activity, 'activity', 500);
      if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length < 1 || input.evidenceRefs.length > 64) throw new TypeError('Invalid evidenceRefs');
      const references = input.evidenceRefs.map(ref => {
        strictKeys(ref, ['id', 'revision'], 'evidence ref');
        if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new TypeError('Invalid evidence revision');
        return { id: text(ref.id, 'evidence id', 200), revision: ref.revision };
      });
      if (new Set(references.map(ref => ref.id)).size !== references.length) throw new TypeError('Duplicate evidenceRefs');
      if ((input.id === undefined) !== (input.revision === undefined)) throw new TypeError('Continuation requires both id and revision');
      const continuing = input.id !== undefined;
      let targetId = null;
      if (continuing) {
        targetId = text(input.id, 'id', 200);
        if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new TypeError('Invalid revision');
      }
      const contentHash = createHash('sha256').update(JSON.stringify([deskId, requestId, summary, activity ?? null,
        references.map(ref => [ref.id, ref.revision]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
        targetId, continuing ? input.revision : null])).digest('hex');
      return structuredClone(transaction(() => {
        const prior = db.prepare('SELECT content_hash, episode_id FROM continuity_episode_requests WHERE desk_id=? AND request_id=?').get(deskId, requestId);
        if (prior) {
          if (prior.content_hash !== contentHash) throw new TypeError('Conflicting episode request');
          // Idempotent replay returns the current record (possibly invalidated or
          // deleted); it never resurrects or rewrites it.
          const existing = get(prior.episode_id);
          if (!existing) throw new TypeError('Episode request result unavailable');
          return existing;
        }
        let target = null;
        if (continuing) {
          target = get(targetId);
          if (!target || target.kind !== 'episode' || target.episodeType !== 'composed') throw new TypeError('Unknown composed episode');
          if (target.deskId !== deskId) throw new TypeError('Episode desk differs from request scope');
          if (target.status !== 'active' || target.revision !== input.revision) throw new TypeError('Episode revision is not current');
        }
        const evidence = references.map(ref => {
          const record = get(ref.id);
          if (!record || record.kind !== 'perception' || record.status !== 'active') throw new TypeError('Current active perception evidence required');
          if (record.revision !== ref.revision) throw new TypeError('Evidence revision is not current');
          return record;
        });
        if (evidence.some(item => item.deskId !== deskId)) throw new TypeError('Evidence desk differs from request scope');
        if (new Set(evidence.map(item => item.source)).size !== 1 || !['camera', 'replay'].includes(evidence[0].source)) throw new TypeError('Evidence must share one camera or replay source');
        // Host computes time, duration, coverage and identity fields from the
        // referenced records; the model only supplies summary/activity.
        const frameTimes = [...new Set(evidence.flatMap(item => item.frameTimes ?? []))].sort((a, b) => a - b);
        const sampleTimes = frameTimes.length ? frameTimes : evidence.map(item => item.observedAt ?? item.at).sort((a, b) => a - b);
        const segments = mergeSegments(evidence.flatMap(item => item.visibleSegments ?? []));
        const coverageRank = { visible: 0, partial: 1, unknown: 2 };
        const record = put({
          id: target?.id ?? randomUUID(), kind: 'episode', episodeType: 'composed', semanticStatus: 'model_summarized',
          summary, ...(activity === undefined ? {} : { activity }),
          deskId, source: evidence[0].source,
          evidenceIds: references.map(ref => ref.id), evidenceRevisions: Object.fromEntries(references.map(ref => [ref.id, ref.revision])),
          at: target?.at ?? now(), updatedAt: now(), revision: (target?.revision ?? 0) + 1,
          ...(target ? { previousRevision: target.revision } : {}),
          status: 'active',
          observedAt: sampleTimes[0], startAt: sampleTimes[0], endAt: sampleTimes[sampleTimes.length - 1],
          frameTimes, visibleSegments: segments,
          observedDurationMs: segments.reduce((sum, segment) => sum + (segment.endAt - segment.startAt), 0),
          gaps: segments.slice(1).map((segment, i) => ({ startAt: segments[i].endAt, endAt: segment.startAt, reason: '采样帧之间未连续观察' })).filter(gap => gap.endAt > gap.startAt),
          coverage: evidence.reduce((worst, item) => (coverageRank[item.coverage] ?? 2) > (coverageRank[worst] ?? 2) ? (item.coverage ?? 'unknown') : worst, 'visible'),
          entityIds: [...new Set(evidence.flatMap(item => item.entityIds ?? []))],
          entities: [...new Map(evidence.flatMap(item=>(item.entities??[]).map(entity=>[entity.id,{...entity}]))).values()],
          entityLabels: [...new Set(evidence.flatMap(item => (item.entities ?? []).map(entity => entity.label)))],
          uncertainties: [...new Set([...evidence.flatMap(item => item.uncertainties ?? []), '片段之间的时间连续性未经确认'])].slice(0, 32),
          actorStatus: 'unconfirmed', continuousDurationKnown: false, rawImagesRetained: false,
          evidenceAvailability: '原画面未留存，无法回放核查',
          ...deriveLearning(evidence),
        });
        db.prepare('INSERT INTO continuity_episode_requests(desk_id,request_id,content_hash,episode_id,created_at) VALUES(?,?,?,?,?)').run(deskId, requestId, contentHash, record.id, now());
        if (target) invalidateDependents(target.id, '整理经历续写替换了证据集合');
        return record;
      }));
    },
    listEpisodes(options = {}) {
      strictKeys(options, ['deskId', 'limit', 'status'], 'listEpisodes options');
      const deskId = text(options.deskId, 'deskId', 200);
      if (deskId !== profile().deskId) throw new TypeError('Episode desk differs from active profile scope');
      const status = member(options.status ?? 'active', ['active', 'invalidated', 'retracted'], 'episode status');
      const limit = options.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Invalid limit');
      return current(TABLES.episode)
        .filter(record => record.episodeType === 'composed' && record.deskId === deskId && record.status === status)
        .filter(record => status !== 'active' || record.evidenceIds.every(id => {
          const source = get(id);
          return source && source.status === 'active' && source.revision === record.evidenceRevisions[id];
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)
        .slice(0, Math.min(limit, 50))
        .map(record => structuredClone(record));
    },
    getProfile() { return profile(); },
    setProfile({ deskId, quietMode, curiosity, expressionLearning }) {
      const previous = profile();
      if (deskId !== undefined) deskId = text(deskId, 'deskId', 200);
      if (quietMode !== undefined && typeof quietMode !== 'boolean') throw new TypeError('Invalid quietMode');
      if (curiosity !== undefined) member(curiosity, ['minimal', 'gentle', 'exploratory'], 'curiosity');
      if (expressionLearning !== undefined && typeof expressionLearning !== 'boolean') throw new TypeError('Invalid expressionLearning');
      const deskChanged = deskId !== undefined && deskId !== previous.deskId;
      const learningEnabled = deskChanged ? false : expressionLearning ?? previous.expressionLearning;
      const learningChanged = deskChanged || learningEnabled !== previous.expressionLearning;
      const record = { ...previous, ...(deskId === undefined ? {} : { deskId }), ...(quietMode === undefined ? {} : { quietMode }),
        ...(curiosity === undefined ? {} : { curiosity }), expressionLearning: learningEnabled,
        learningVersion: learningEpoch(previous.learningVersion + (learningChanged ? 1 : 0)),
        learningSince: learningChanged ? (learningEnabled ? now() : null) : previous.learningSince,
        source: 'explicit_user', version: previous.version + 1, updatedAt: now() };
      db.prepare("INSERT INTO continuity_profiles(id,payload) VALUES('current',?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(record));
      return record;
    },
    revise(id, { summary, status, reason }) {
      text(id, 'id', 200); reason = text(reason, 'reason');
      if (summary !== undefined) summary = text(summary, 'summary');
      if (status !== undefined) member(status, STATUSES, 'status');
      const result=transaction(() => {
        const previous = get(id);
        if (!previous) throw new TypeError('Unknown memory id');
        if(status==='deleted')return deleteMemory(previous);
        if(previous.status==='deleted')throw new TypeError('Memory deleted');
        if (!LIVE.has(previous.status) && LIVE.has(status)) throw new TypeError('Invalidated evidence requires fresh grounding');
        const corrected = summary === undefined ? {} : { summary, ...(previous.description === undefined ? {} : { description: summary }), entities: [], entityIds: [], entityLabels: [], activity: undefined };
        // A text correction cannot vouch for the old extracted entities or activity.
        const record = put({ ...previous, ...corrected, ...(status === undefined ? {} : { status }),
          revision: previous.revision + 1, previousRevision: previous.revision, updatedAt: now(), reason });
        invalidateDependents(id, reason);
        return record;
      });
      // Reclaim legacy free pages created before secure_delete was enabled.
      // This only rewrites this database, never external backups/OS snapshots.
      if(status==='deleted')db.exec('VACUUM');
      return structuredClone(result);
    },
    snapshot() {
      const bounded = table => current(table,50).map(record => structuredClone(record));
      return { perceptions: bounded(TABLES.perception), episodes: bounded(TABLES.episode), beliefs: bounded(TABLES.understanding), interests: bounded(TABLES.interest), profile: profile(), learning: [] };
    },
    resolveMemory(id,{deskId=profile().deskId}={}) {
      const record=get(text(id,'memory id',200));deskId=text(deskId,'deskId',200);
      return record&&LIVE.has(record.status)&&record.deskId===deskId&&['perception','episode','interaction','understanding','hypothesis'].includes(record.kind)?structuredClone(record):null;
    },
    listPerceptions({deskId=profile().deskId,startAt,endAt,limit=24}={}) {
      deskId=text(deskId,'deskId',200);timestamp(startAt,'startAt');timestamp(endAt,'endAt');
      if(endAt<=startAt||endAt-startAt>172800000||!Number.isInteger(limit)||limit<1||limit>1000)throw new TypeError('Invalid perception range');
      const rows=records().filter(record=>record.kind==='perception'&&record.status==='active'&&record.deskId===deskId&&(record.observedAt??record.at)>=startAt&&(record.observedAt??record.at)<endAt).sort((a,b)=>(a.observedAt??a.at)-(b.observedAt??b.at)||a.id.localeCompare(b.id));
      const selected=rows.length<=limit?rows:limit===1?[rows[0]]:Array.from({length:limit},(_,i)=>rows[Math.round(i*(rows.length-1)/(limit-1))]);
      return structuredClone(selected);
    },
    getEvidence(id,{deskId=profile().deskId}={}) {
      const record=get(text(id,'evidence id',200));
      return record?.status==='active'&&record.deskId===deskId&&['perception','episode','interaction'].includes(record.kind)?structuredClone(record):null;
    },
    describeEvidence(id, { deskId = profile().deskId } = {}) {
      const record = get(text(id, 'evidence id', 200));
      deskId = text(deskId, 'deskId', 200);
      if (!record || record.status === 'deleted' || record.deskId !== deskId) return null;
      const currentProfile = profile();
      const allowed = record.status === 'active' && record.source === 'camera' && record.deskId === currentProfile.deskId
        && currentProfile.expressionLearning === true && record.learningUse === 'allowed'
        && Number.isSafeInteger(record.learningVersion) && record.learningVersion >= 1 && record.learningVersion === currentProfile.learningVersion;
      const learningUse = allowed ? 'allowed' : ['test', 'holdout', 'denied'].includes(record.learningUse) ? record.learningUse : 'unknown';
      return { id: record.id, revision: record.revision, kind: record.kind, status: record.status, source: record.source, deskId: record.deskId,
        learningUse, ...(record.learningVersion === undefined ? {} : { learningVersion: record.learningVersion }) };
    },
    affectedEvidenceIds,
    diary({ day = dayFor(now()), deskId, timeZone='Asia/Shanghai', startAt, endAt } = {}) {
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('Invalid day');
      const utc=Date.parse(`${day}T00:00:00Z`);
      if(!Number.isFinite(utc)||new Date(utc).toISOString().slice(0,10)!==day)throw new TypeError('Invalid day');
      if((startAt===undefined)!==(endAt===undefined))throw new TypeError('Invalid diary range');
      const ranged=startAt!==undefined;
      if(ranged){
        timestamp(startAt,'startAt');timestamp(endAt,'endAt');
        if(endAt<=startAt||endAt-startAt>172800000)throw new TypeError('Invalid diary range');
      }
      const [start,end]=ranged?[startAt,endAt]:localDayBounds(day,timeZone);
      const cacheKey=JSON.stringify([day,deskId??null,timeZone,startAt??null,endAt??null,profile().version]);
      if(diaryCache?.key===cacheKey)return structuredClone(diaryCache.value);
      const active = records().filter(record => record.status === 'active' && (deskId === undefined || record.deskId === deskId));
      // A composed episode belongs to this local day only when every referenced
      // sampling moment falls inside it; mixed-date compositions fall back to the
      // day's raw fragments instead of showing a cross-midnight summary.
      const eligible = active.filter(record => record.kind === 'episode' && record.episodeType === 'composed')
        .filter(record => record.evidenceIds.length > 0 && record.evidenceIds.every(id => {
          const evidence = getAtRevision('perception', id, record.evidenceRevisions?.[id]);
          if (!evidence) return false;
          const times = evidence.frameTimes?.length ? evidence.frameTimes : [evidence.observedAt ?? evidence.at];
          return times.every(at => at >= start && at < end);
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision);
      // Latest valid composition wins; overlapping compositions drop out as panels
      // so the same evidence is never summarized twice.
      const covered = new Set();
      const chosen = [];
      for (const episode of eligible) {
        if (episode.evidenceIds.some(id => covered.has(id))) continue;
        episode.evidenceIds.forEach(id => covered.add(id));
        chosen.push(episode);
      }
      const chosenIds = new Set(chosen.map(record => record.id));
      const episodeBasis = new Set(active.filter(record => record.kind === 'episode' && (record.episodeType !== 'composed' || chosenIds.has(record.id))).flatMap(record => record.evidenceIds));
      const panels = active.filter(record => {
        if (record.kind === 'interaction') return true;
        if (record.kind === 'episode' && record.episodeType === 'composed') return chosenIds.has(record.id);
        if (record.kind === 'episode') { const basis = record.evidenceIds ?? []; return basis.length === 0 || !basis.every(id => covered.has(id)); }
        return record.kind === 'perception' && !episodeBasis.has(record.id);
      })
        .filter(record => (record.observedAt ?? record.at) >= start && (record.observedAt ?? record.at) < end)
        .sort((a,b) => (a.observedAt ?? a.at) - (b.observedAt ?? b.at));
      const gaps = [];
      const scopes = new Map();
      for (const panel of panels.filter(item => item.frameTimes)) {
        const key = `${panel.deskId}:${panel.source}`;
        if (!scopes.has(key)) scopes.set(key, { deskId: panel.deskId, source: panel.source, times: [] });
        scopes.get(key).times.push(...panel.frameTimes.filter(at => at >= start && at < end));
      }
      for (const { deskId, source, times } of scopes.values()) {
        const sorted = [...new Set(times)].sort((a,b) => a-b);
        const bounds = [start, ...sorted, end];
        for (let i = 1; i < bounds.length; i++) if (bounds[i] > bounds[i-1]) gaps.push({ startAt: bounds[i-1], endAt: bounds[i], deskId, source, reason: '未连续观察，不推断期间的活动' });
      }
      if (!scopes.size) gaps.push({ startAt: start, endAt: end, deskId: deskId ?? profile().deskId, reason: '当天没有可用视觉证据' });
      const limit=100;
      // Bound context without turning the beginning of a day into the entire day.
      // Select by chronology only; the Pi still chooses semantic story content.
      const selected=panels.length<=limit?panels:Array.from({length:limit},(_,index)=>panels[Math.round(index*(panels.length-1)/(limit-1))]);
      const result={ day, startAt: start, endAt: end, panels:selected, gaps, totalPanelCount:panels.length, omittedPanelCount:panels.length-selected.length, selectionPolicy:'chronological_spread' };
      diaryCache={key:cacheKey,value:result};return structuredClone(result);
    },
    close() { if (!closed) { diaryCache=null;for(const bucket of currentCache.values())bucket.clear();db.close(); closed = true; } },
  };
}
