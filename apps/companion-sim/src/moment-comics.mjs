// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {buildComicImagePrompt} from './comic-image-provider.mjs';
import {momentCharacters} from './comic-characters.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { workdayFor } from './day-window.mjs';

export const MOMENT_INTERVAL_MS = 1800000;
const LEASE_MS = 90000, RENDER_LEASE_MS = 120000, MAX_ATTEMPTS = 2, MAX_RENDER_ATTEMPTS = 2;
const MAX_CANDIDATES = 24, MAX_REFS = 4, MAX_PROMPT_CHARS = 1000, MAX_ENCOURAGEMENT_CHARS = 50, MAX_TITLE_CHARS = 30;
const MAX_IMAGE_BYTES = 4194304, MIN_DIMENSION = 16, MAX_DIMENSION = 8192;
const VISIBLE_ITEMS = 5, MAX_JOB_METADATA = 20, MAX_SKIPS = 8;
const KINDS = new Set(['perception', 'episode']);
const SOURCES = new Set(['camera', 'replay']);
const MIMES = new Set(['image/png', 'image/jpeg']);
const decode = row => row ? JSON.parse(row.payload) : null;
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function boundedText(value, name, maxChars) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > maxChars) throw new TypeError(`Invalid ${name}`);
  return trimmed;
}
function epochValue(epoch) {
  if ((typeof epoch === 'string' && epoch.trim() && epoch.length <= 200) || (Number.isSafeInteger(epoch) && epoch >= 0)) return epoch;
  throw new TypeError('Host epoch required');
}
function keys(object, allowed, name) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !allowed.includes(key))) throw new TypeError(`Invalid ${name} fields`);
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
// Text-only candidate: pinned id+revision, no frames, keys or execution payloads.
function candidate(record) {
  return {
    id: record.id, kind: record.kind, source: record.source, revision: record.revision,
    observedAt: record.observedAt ?? record.at,
    summary: record.summary.trim().slice(0, 800),
    visualSubjects: structuredClone(record.visualSubjects??[]),
    coverage: typeof record.coverage === 'string' ? record.coverage.slice(0, 100) : 'unknown',
    uncertainties: (record.uncertainties ?? []).filter(v => typeof v === 'string').slice(0, 16).map(v => v.slice(0, 200)),
    frameGaps: (record.frameGaps ?? []).filter(v => typeof v === 'string').slice(0, 8).map(v => v.slice(0, 200)),
  };
}
function imageInfo(mimeType, bytes) {
  let width, height;
  if (mimeType === 'image/png') {
    if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mimeType === 'image/jpeg') {
    if (bytes.length < 11 || bytes.readUInt16BE(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 7) return null;
        height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break;
      }
      offset += 2 + length;
    }
  } else return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

/** Thirty-minute representative-moment comic store. Owns scheduling, claims, render handoff and the five-item circular gallery. */
export function createMomentComics({ path, clock = Date.now, readEntries, readEvidence, timeZone = 'Asia/Shanghai' }) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function' || typeof readEntries !== 'function' || typeof readEvidence !== 'function') throw new TypeError('Moment source callbacks required');
  text(timeZone, 'timeZone', 100); workdayFor(0, { timeZone });
  const db = new DatabaseSync(path);
  let closed = false;
  db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS moment_state (desk_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS moment_jobs (id TEXT PRIMARY KEY, desk_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(desk_id,start_at,end_at));
    CREATE TABLE IF NOT EXISTS moment_images (id TEXT PRIMARY KEY, desk_id TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL);`);
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid clock'); return value; };
  const getState = deskId => decode(db.prepare('SELECT payload FROM moment_state WHERE desk_id=?').get(deskId));
  const saveState = state => { db.prepare('INSERT INTO moment_state(desk_id,payload) VALUES(?,?) ON CONFLICT(desk_id) DO UPDATE SET payload=excluded.payload').run(state.deskId, JSON.stringify(state)); return state; };
  const getJob = id => decode(db.prepare('SELECT payload FROM moment_jobs WHERE id=?').get(text(id, 'jobId')));
  const allJobs = () => db.prepare('SELECT payload FROM moment_jobs ORDER BY rowid').all().map(decode);
  const jobsFor = deskId => db.prepare('SELECT payload FROM moment_jobs WHERE desk_id=? ORDER BY start_at, rowid').all(deskId).map(decode);
  const save = job => { db.prepare('INSERT INTO moment_jobs(id,desk_id,start_at,end_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id, job.deskId, job.startAt, job.endAt, JSON.stringify(job)); return job; };
  const dropTokens = job => { const { claimToken, claimEpoch, leaseUntil, renderToken, renderLeaseUntil, ...rest } = job; return rest; };
  const publicJob = job => { const { selection, ...rest } = dropTokens(job); return rest; };
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const failJob = job => save({ ...publicJob(job), status: 'failed', updatedAt: now() });
  const renderWork = job => ({ id: job.id, renderToken: job.renderToken, renderRequests: job.renderRequests ?? 0, ...(job.renderLeaseUntil ? { renderLeaseUntil: job.renderLeaseUntil } : {}), scenePrompt: job.selection.scenePrompt, encouragement: job.selection.encouragement, ...(job.selection.title === undefined ? {} : { title: job.selection.title }), evidenceRefs: job.selection.refs, characters: job.selection.characters??[] });
  function collect(deskId, startAt, endAt) {
    const entries = readEntries({ deskId, startAt, endAt });
    if (!Array.isArray(entries)) throw new TypeError('Invalid moment entries source');
    const seen = new Set();
    const records = entries.filter(r => eligible(r, { deskId, startAt, endAt }) && !seen.has(r.id) && seen.add(r.id))
      .sort((a, b) => (a.observedAt ?? a.at) - (b.observedAt ?? b.at) || a.id.localeCompare(b.id));
    const candidates = records.slice(0, MAX_CANDIDATES).map(candidate);
    const refs = candidates.map(c => ({ id: c.id, revision: c.revision }));
    return { candidates, refs, fingerprint: createHash('sha256').update(JSON.stringify(refs)).digest('hex'), truncated: records.length > MAX_CANDIDATES };
  }
  function issuedCandidates(job) {
    if (!Array.isArray(job.refs) || !job.refs.length) return null;
    const records = job.refs.map(ref => readEvidence(ref.id, { deskId: job.deskId }));
    // A job pins the candidates actually issued to Pi. Late-arriving records in
    // the same window do not revise them or silently add new selection authority.
    if (!records.every((record, index) => record?.id === job.refs[index].id && record.revision === job.refs[index].revision && eligible(record, job))) return null;
    return records.map(candidate);
  }
  function createJob({ deskId, startAt, endAt, reason }, fresh) {
    const t = now();
    const job = { id: randomUUID(), deskId, startAt, endAt, reason, fingerprint: fresh.fingerprint, refs: fresh.refs, status: 'pending', attempts: 0, renderAttempts: 0, renderRequests: 0, nextAttemptAt: 0, createdAt: t, updatedAt: t };
    db.prepare('INSERT INTO moment_jobs(id,desk_id,start_at,end_at,payload) VALUES(?,?,?,?,?) ON CONFLICT(desk_id,start_at,end_at) DO NOTHING').run(job.id, deskId, startAt, endAt, JSON.stringify(job));
    return decode(db.prepare('SELECT payload FROM moment_jobs WHERE desk_id=? AND start_at=? AND end_at=?').get(deskId, startAt, endAt));
  }
  function invalidate(job) {
    db.prepare('DELETE FROM moment_images WHERE id=?').run(job.id);
    return save({ ...publicJob(job), status: 'invalidated', updatedAt: now() });
  }
  function selectionValid(job) {
    const refs = [...(job.selection?.refs??[]),...(job.selection?.characters??[]).flatMap(c=>c.evidenceRefs)];
    return Array.isArray(refs) && refs.length >= 1 && refs.every(ref => {
      const record = readEvidence(ref.id, { deskId: job.deskId });
      return factual(record, job.deskId) && record.revision === ref.revision;
    });
  }
  function reclaim(deskId, epoch, t) {
    for (const job of jobsFor(deskId)) {
      if (job.status === 'claimed' && (job.leaseUntil <= t || job.claimEpoch !== epoch)) {
        save({ ...dropTokens(job), status: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', nextAttemptAt: t, updatedAt: t });
      }
    }
  }
  function tryClaim(job, epoch, t) {
    if (job.status !== 'pending' || job.nextAttemptAt > t) return null;
    const candidates = issuedCandidates(job);
    if (!candidates) { invalidate(job); return null; }
    save({ ...job, status: 'claimed', attempts: job.attempts + 1, claimToken: randomUUID(), claimEpoch: epoch, leaseUntil: t + LEASE_MS, updatedAt: t });
    const claimed = getJob(job.id);
    return { id: claimed.id, claimToken: claimed.claimToken, leaseUntil: claimed.leaseUntil, deskId: claimed.deskId, startAt: claimed.startAt, endAt: claimed.endAt, candidates };
  }
  function owned(job, claimToken, context) {
    if (!job || job.status !== 'claimed' || !claimToken || job.claimToken !== claimToken || job.leaseUntil <= now()) throw new TypeError('Moment claim is stale or not owned');
    if (context && (context.deskId !== job.deskId || context.epoch !== job.claimEpoch)) throw new TypeError('Moment claim epoch or desk changed');
  }
  function ownedRender(input, deskId) {
    const job = getJob(input.id);
    if (!job || job.deskId !== deskId || job.status !== 'render' || job.renderToken !== input.renderToken) throw new TypeError('Moment render token is stale or not owned');
    if (job.renderLeaseUntil !== undefined && job.renderLeaseUntil <= now()) throw new TypeError('Moment render lease expired');
    return job;
  }
  function readyRender(job, t) {
    if (job.status !== 'render') return null;
    if (!selectionValid(job)) { invalidate(job); return null; }
    if (job.renderLeaseUntil > t) return null;
    if ((job.renderRequests ?? 0) >= MAX_RENDER_ATTEMPTS) { failJob(job); return null; }
    if (job.renderLeaseUntil !== undefined) {
      const { renderLeaseUntil, ...rest } = job;
      job = save({ ...rest, renderToken: randomUUID(), updatedAt: t });
    }
    return job;
  }
  function purge(deskId) {
    const published = jobsFor(deskId).filter(j => j.status === 'published').sort((a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id));
    const purged = [];
    for (const job of published.slice(VISIBLE_ITEMS)) {
      db.prepare('DELETE FROM moment_images WHERE id=?').run(job.id);
      save({ ...publicJob(job), status: 'purged', updatedAt: now() });
      purged.push(job.id);
    }
    return purged;
  }
  // Older versions kept source-derived prose after its image became terminal.
  // Remove that prose on reopen as well as on every new terminal transition.
  for (const job of allJobs()) if (['invalidated', 'purged', 'failed'].includes(job.status) && job.selection) save(publicJob(job));
  const api = {
    poll(input) {
      keys(input, ['enabled', 'epoch', 'deskId'], 'poll');
      const deskId = text(input.deskId, 'deskId'), epoch = epochValue(input.epoch);
      if (input.enabled !== true) return null;
      const t = now();
      reclaim(deskId, epoch, t);
      // Anchored at the first enabled poll; disabled polls create no schedule.
      let state = getState(deskId) ?? saveState({ deskId, anchorAt: t, lastWindowIndex: -1, skips: [] });
      const due = Math.floor((t - state.anchorAt) / MOMENT_INTERVAL_MS) - 1;
      if (due > state.lastWindowIndex) {
        // Persist the window advance first: a restart neither repeats this bucket
        // nor backfills the windows skipped while down.
        state.lastWindowIndex = due;
        const startAt = state.anchorAt + due * MOMENT_INTERVAL_MS, endAt = startAt + MOMENT_INTERVAL_MS;
        const fresh = collect(deskId, startAt, endAt);
        if (fresh.candidates.length) createJob({ deskId, startAt, endAt, reason: 'scheduled' }, fresh);
        else state.skips = [...state.skips, { startAt, endAt, status: 'no_evidence', at: t }].slice(-MAX_SKIPS);
        saveState(state);
      }
      // Re-ground the current bucket on corrected records. The shared two-attempt
      // bound still applies, so a churning source cannot regenerate forever, and
      // older buckets stay invalidated rather than spawning out-of-window moments.
      const latestStart = state.lastWindowIndex >= 0 ? state.anchorAt + state.lastWindowIndex * MOMENT_INTERVAL_MS : null;
      for (const job of jobsFor(deskId)) {
        if (job.status !== 'invalidated' || job.attempts >= MAX_ATTEMPTS || job.startAt !== latestStart) continue;
        const fresh = collect(deskId, job.startAt, job.endAt);
        if (!fresh.candidates.length || fresh.fingerprint === job.fingerprint) continue;
        save({ ...job, refs: fresh.refs, fingerprint: fresh.fingerprint, status: 'pending', nextAttemptAt: t, updatedAt: t });
      }
      for (const job of jobsFor(deskId)) { const claim = tryClaim(job, epoch, t); if (claim) return claim; }
      return null;
    },
    requestNow(input) {
      keys(input, ['deskId', 'epoch', 'enabled'], 'requestNow');
      const deskId = text(input.deskId, 'deskId'), epoch = epochValue(input.epoch);
      if (input.enabled !== true) return null;
      const t = now();
      reclaim(deskId, epoch, t);
      const endAt = t, startAt = Math.max(0, t - MOMENT_INTERVAL_MS);
      // Reuse any active job covering the same actual facts; never duplicates a moment
      // and never touches the thirty-minute production schedule.
      let job = jobsFor(deskId).find(j => j.startAt < endAt && j.endAt > startAt && ['pending', 'claimed', 'render', 'published'].includes(j.status));
      if (!job) {
        const fresh = collect(deskId, startAt, endAt);
        if (!fresh.candidates.length) return null;
        job = createJob({ deskId, startAt, endAt, reason: 'manual' }, fresh);
      }
      return tryClaim(job, epoch, t);
    },
    select(input, context) {
      keys(input, ['jobId', 'claimToken', 'evidenceRefs', 'scenePrompt', 'encouragement', 'title'], 'select');
      keys(context, ['enabled', 'epoch', 'deskId'], 'host context');
      if (context.enabled !== true) throw new TypeError('Moment selection disabled');
      const epoch = epochValue(context.epoch), deskId = text(context.deskId, 'host deskId');
      const job = getJob(input.jobId);
      owned(job, input.claimToken, { epoch, deskId });
      const candidates = issuedCandidates(job);
      if (!candidates) { invalidate(job); throw new TypeError('Moment sources revised'); }
      if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length < 1 || input.evidenceRefs.length > MAX_REFS) throw new TypeError('Moment needs 1-4 evidence refs');
      const allowed = new Map(candidates.map(c => [c.id, c])), seen = new Set();
      const refs = input.evidenceRefs.map(ref => {
        keys(ref, ['id', 'revision'], 'evidence ref');
        const id = text(ref.id, 'evidence id');
        if (!Number.isSafeInteger(ref.revision) || ref.revision < 1 || seen.has(id)) throw new TypeError('Invalid moment evidence ref');
        seen.add(id);
        const candidate = allowed.get(id);
        if (!candidate || candidate.revision !== ref.revision) throw new TypeError('Evidence ref is not a current candidate');
        const record = readEvidence(id, { deskId: job.deskId });
        if (!factual(record, job.deskId) || record.revision !== ref.revision) { invalidate(job); throw new TypeError('Moment evidence revised'); }
        return { id, revision: ref.revision };
      });
      const scenePrompt = boundedText(input.scenePrompt, 'scenePrompt', MAX_PROMPT_CHARS);
      const encouragement = boundedText(input.encouragement, 'encouragement', MAX_ENCOURAGEMENT_CHARS);
      const title = input.title === undefined ? undefined : boundedText(input.title, 'title', MAX_TITLE_CHARS);
      const characters=momentCharacters(refs.map(ref=>readEvidence(ref.id,{deskId})),{readEvidence,deskId});
      buildComicImagePrompt(scenePrompt,characters); // Reject in the Pi selection turn; it can shorten before any image request.
      const renderToken = randomUUID(), t = now();
      save({ ...dropTokens(job), status: 'render', renderToken, renderAttempts: 1, selection: { refs, scenePrompt, encouragement, characters, ...(title === undefined ? {} : { title }) }, updatedAt: t });
      return { id: job.id, accepted: true, status: 'render', renderToken, scenePrompt, encouragement, ...(title === undefined ? {} : { title }), evidenceRefs: refs, updatedAt: t };
    },
    referenceImage({characters}, {deskId}) {
      if(characters?.length!==1)return null;
      const characterId=characters[0].characterId;
      const jobs=jobsFor(deskId).filter(j=>j.status==='published'&&j.selection?.characters?.length===1&&j.selection.characters[0].characterId===characterId).sort((a,b)=>a.publishedAt-b.publishedAt);
      for(const job of jobs){
        if(!selectionValid(job)){invalidate(job);continue;}
        const image=api.readImage(job.id,{deskId});
        if(image)return {...image,imageId:job.id};
      }
      return null;
    },
    pendingRender(input) {
      keys(input, ['deskId'], 'pendingRender');
      const deskId = text(input.deskId, 'deskId');
      const result = [];
      for (const job of jobsFor(deskId)) {
        const ready = readyRender(job, now());
        if (ready) result.push(renderWork(ready));
      }
      return result;
    },
    claimRender(input, context) {
      keys(input, ['id', 'renderToken'], 'claimRender');
      keys(context, ['deskId'], 'host context');
      const deskId = text(context.deskId, 'host deskId');
      return transaction(() => {
        const job = getJob(input.id);
        if (!job || job.deskId !== deskId || job.status !== 'render' || job.renderToken !== input.renderToken) return null;
        const t = now(), ready = readyRender(job, t);
        if (!ready) return null;
        const claimed = save({ ...ready, renderToken: randomUUID(), renderRequests: (ready.renderRequests ?? 0) + 1, renderLeaseUntil: t + RENDER_LEASE_MS, updatedAt: t });
        return renderWork(claimed);
      });
    },
    completeImage(input, context) {
      keys(input, ['id', 'renderToken', 'mimeType', 'bytes'], 'completeImage');
      keys(context, ['deskId', 'isCurrent'], 'host context');
      if (typeof context.isCurrent !== 'function') throw new TypeError('isCurrent callback required');
      const deskId = text(context.deskId, 'host deskId');
      const job = ownedRender(input, deskId);
      if (context.isCurrent() !== true) {
        failJob(job);
        return { id: job.id, accepted: false, status: 'failed', reason: 'stale_context' };
      }
      if (!selectionValid(job)) { invalidate(job); return { id: job.id, accepted: false, status: 'invalidated', reason: 'sources_revised' }; }
      if (!MIMES.has(input.mimeType)) throw new TypeError('Invalid moment image type');
      const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : input.bytes instanceof Uint8Array ? Buffer.from(input.bytes) : null;
      if (!bytes || bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) throw new TypeError('Invalid moment image bytes');
      const info = imageInfo(input.mimeType, bytes);
      if (!info) throw new TypeError('Invalid moment image headers');
      const t = now();
      db.prepare('INSERT INTO moment_images(id,desk_id,mime,bytes) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes').run(job.id, deskId, input.mimeType, bytes);
      save({ ...dropTokens(job), status: 'published', publishedAt: t, mimeType: input.mimeType, byteSize: bytes.length, width: info.width, height: info.height, updatedAt: t });
      return { id: job.id, accepted: true, status: 'published', publishedAt: t, mimeType: input.mimeType, byteSize: bytes.length, width: info.width, height: info.height, purged: purge(deskId) };
    },
    failRender(input, context) {
      keys(input, ['id', 'renderToken', 'reason', 'retryable'], 'failRender');
      keys(context, ['deskId'], 'host context');
      text(input.reason, 'reason', 500); // Scheduler diagnostic; caller text is never persisted.
      if (input.retryable !== undefined && typeof input.retryable !== 'boolean') throw new TypeError('Invalid render retryability');
      const deskId = text(context.deskId, 'host deskId');
      const job = ownedRender(input, deskId);
      if (input.retryable === false || job.renderAttempts >= MAX_RENDER_ATTEMPTS || (job.renderRequests ?? 0) >= MAX_RENDER_ATTEMPTS) {
        failJob(job);
        return { id: job.id, status: 'failed', renderAttempts: job.renderAttempts };
      }
      const renderAttempts = job.renderAttempts + 1;
      const { renderLeaseUntil, ...rest } = job;
      save({ ...rest, renderToken: randomUUID(), renderAttempts, updatedAt: now() });
      return { id: job.id, status: 'render', renderAttempts };
    },
    release(id, { claimToken, reason } = {}) {
      const job = getJob(id); owned(job, claimToken);
      text(reason, 'release reason', 500);
      return save({ ...dropTokens(job), status: job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', nextAttemptAt: now() + Math.min(30000, 1000 * 2 ** job.attempts), updatedAt: now() });
    },
    snapshot(input) {
      keys(input, ['deskId'], 'snapshot');
      const deskId = text(input.deskId, 'deskId');
      const t = now();
      const day = workdayFor(t, { timeZone });
      const items = [];
      for (const job of jobsFor(deskId)) {
        if (job.status !== 'published') continue;
        // A corrected or retracted source removes its artifact from the gallery on read.
        if (!selectionValid(job)) { invalidate(job); continue; }
        items.push({ id: job.id, ...(job.selection?.title === undefined ? {} : { title: job.selection.title }), encouragement: job.selection?.encouragement, evidenceRefs: job.selection?.refs ?? job.refs, characters: job.selection?.characters??[], startAt: job.startAt, endAt: job.endAt, publishedAt: job.publishedAt, mimeType: job.mimeType, width: job.width, height: job.height, byteSize: job.byteSize });
      }
      items.sort((a, b) => b.publishedAt - a.publishedAt || b.id.localeCompare(a.id));
      const state = getState(deskId);
      return {
        items: items.slice(0, VISIBLE_ITEMS),
        jobs: jobsFor(deskId).map(publicJob).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_JOB_METADATA),
        nextAt: state ? state.anchorAt + (state.lastWindowIndex + 2) * MOMENT_INTERVAL_MS : null,
        intervalMs: MOMENT_INTERVAL_MS, day, skips: state?.skips ?? [],
      };
    },
    readImage(id, context) {
      keys(context, ['deskId'], 'host context');
      const deskId = text(context.deskId, 'host deskId');
      const job = getJob(id);
      if (!job || job.deskId !== deskId || job.status !== 'published') return null;
      if (!selectionValid(job)) { invalidate(job); return null; }
      const row = db.prepare('SELECT mime, bytes FROM moment_images WHERE id=?').get(job.id);
      return row ? { bytes: Buffer.from(row.bytes), mimeType: row.mime } : null;
    },
    reconcileEvidence() {
      return transaction(() => {
        const invalidated = [];
        for (const job of allJobs()) {
          const refs = [...(job.selection?.refs??job.refs??[]),...(job.selection?.characters??[]).flatMap(c=>c.evidenceRefs)];
          if (!refs.some(ref => { const record = readEvidence(ref.id, { deskId: job.deskId }); return !factual(record, job.deskId) || record.revision !== ref.revision; })) continue;
          if (job.status !== 'invalidated' || job.selection) { invalidate(job); invalidated.push(job.id); }
        }
        return { invalidated };
      });
    },
    forgetEvidence(id) {
      id = text(id, 'evidence id');
      return transaction(() => {
        const invalidated = [];
        for (const job of allJobs()) {
          if (![...(job.refs ?? []), ...(job.selection?.refs ?? []),...(job.selection?.characters??[]).flatMap(c=>c.evidenceRefs)].some(ref => ref.id === id)) continue;
          invalidate({ ...job, refs: (job.refs ?? []).filter(ref => ref.id !== id) });
          invalidated.push(job.id);
        }
        return { invalidated };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
  return api;
}
