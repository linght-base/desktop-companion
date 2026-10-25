// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Expression demand ledger (PRD5.4): when Pi finds its expression library insufficient it keeps
// the basic interaction going and records a bounded, evidence-grounded demand here — it never
// fabricates a recipe and never claims resources are available. The same Pi later claims due
// demands in low-priority background time and completes them against the expression library;
// the library itself owns activation on the next wake. The module is a pure ledger: no network,
// no model, no timers, no device calls, and it never copies the event queue or the plan ledger.
//
// Honesty rules baked in: meaning/reason are untrusted reference text, never permissions; only
// currently active perception/episode evidence from camera/replay on the same desk with
// learningUse 'allowed' and a valid learningVersion can ground a demand — test/holdout/denied/
// unknown material is always refused; a 'ready' demand only proves a structurally checked
// library candidate exists (semanticStatus stays 'unverified', nothing was played); a clock
// regression revokes the running claim and refuses stale-clock execution until a new epoch
// recovers; forgetEvidence physically deletes derived personal content, including history.
// Resource weighting and scheduling authority always belong to the external controller.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const LIMITS = Object.freeze({
  maxActivePerScope: 30, maxTotalPerScope: 200, maxRequests: 500,
  maxAttempts: 3, leaseMs: 30000, failureBackoffMs: 60000,
  listDefault: 10, listMax: 50, snapshotDemands: 20,
  maxRefs: 8, maxMeaningLength: 500, maxReasonLength: 500, maxRequestIdLength: 200,
});
const STATUSES = new Set(['pending', 'reviewing', 'ready', 'abandoned', 'failed', 'invalidated']);
const ACTIVE = new Set(['pending', 'reviewing']);
const TERMINAL = new Set(['ready', 'abandoned', 'failed', 'invalidated']);
const LIVE = new Set(['pending', 'reviewing', 'ready']);
const DEMAND_KINDS = new Set(['perception', 'episode']);
const DEMAND_SOURCES = new Set(['camera', 'replay']);
const EVIDENCE_STATUSES = new Set(['active', 'tentative', 'invalidated', 'retracted', 'deleted']);
const LEARNING_USES = new Set(['allowed', 'test', 'holdout', 'denied', 'unknown']);

function fields(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`invalid_${name}`);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`invalid_${name}_field`);
}
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`invalid_${name}`);
  return value.trim();
}
function scopeOf(value) {
  fields(value, ['deskId', 'personaVersion'], 'scope');
  const deskId = text(value.deskId, 'desk_id', 200);
  if (!Number.isSafeInteger(value.personaVersion) || value.personaVersion < 1 || value.personaVersion > 1e9) throw new TypeError('invalid_persona_version');
  return { deskId, personaVersion: value.personaVersion };
}
function epochOf(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() && value.length <= 200 && !value.includes('\0')) return value.trim();
  throw new TypeError('invalid_epoch');
}
const epochKey = epoch => `${typeof epoch === 'number' ? 'n' : 's'}:${epoch}`;
function contextOf(value) {
  fields(value, ['epoch', 'enabled', 'deskId', 'personaVersion'], 'context');
  const epoch = epochOf(value.epoch);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new TypeError('invalid_enabled');
  const { deskId, personaVersion } = scopeOf({ deskId: value.deskId, personaVersion: value.personaVersion });
  return { epoch, enabled: value.enabled, deskId, personaVersion };
}
function validateRefs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.maxRefs) throw new TypeError('invalid_evidence_refs');
  const seen = new Set();
  return value.map(ref => {
    fields(ref, ['id', 'revision'], 'evidence_ref');
    if (typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 200 || ref.id.includes('\0')) throw new TypeError('invalid_evidence_ref');
    if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new TypeError('invalid_evidence_ref');
    if (seen.has(ref.id)) throw new TypeError('duplicate_evidence_ref');
    seen.add(ref.id);
    return { id: ref.id.trim(), revision: ref.revision };
  });
}
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** All timestamps are Unix milliseconds from the injectable clock. */
export function createExpressionDemandStore({ path, clock = Date.now, resolveEvidence, resolveCandidate } = {}) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new TypeError('invalid_clock');
  if (resolveEvidence !== undefined && typeof resolveEvidence !== 'function') throw new TypeError('invalid_resolveEvidence');
  if (resolveCandidate !== undefined && typeof resolveCandidate !== 'function') throw new TypeError('invalid_resolveCandidate');

  const db = new DatabaseSync(path);
  let closed = false;
  try {
    // secure_delete zeroes freed pages so a forgotten demand leaves no personal bytes behind.
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS expression_demand_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expression_demand_demands(
        id TEXT PRIMARY KEY, desk_id TEXT NOT NULL, persona_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
        meaning TEXT NOT NULL, reason TEXT, evidence_refs TEXT NOT NULL,
        attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, candidate_id TEXT,
        claim_token TEXT, claim_epoch TEXT, lease_until INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS expression_demand_demands_scope
        ON expression_demand_demands(desk_id, persona_version, status, next_at);
      CREATE TABLE IF NOT EXISTS expression_demand_requests(
        desk_id TEXT NOT NULL, persona_version INTEGER NOT NULL, request_id TEXT NOT NULL,
        demand_id TEXT NOT NULL, content_hash TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(desk_id, persona_version, request_id));`);
    const stored = db.prepare("SELECT value FROM expression_demand_meta WHERE key='schema_version'").get();
    if (!stored) db.prepare("INSERT INTO expression_demand_meta(key,value) VALUES('schema_version','1')").run();
    else if (stored.value !== '1') throw new Error(`unsupported_schema_version:${stored.value}`);
    // Recovery: a restart never keeps execution authority. Claims that were in flight return to
    // pending with their persisted attempt counts and schedule; exhausted ones settle as failed.
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8.64e15) throw new TypeError('invalid_clock_value');
    db.prepare(`UPDATE expression_demand_demands SET status='failed', claim_token=NULL, claim_epoch=NULL, lease_until=NULL, revision=revision+1, updated_at=? WHERE status='reviewing' AND attempts>=?`).run(at, LIMITS.maxAttempts);
    db.prepare(`UPDATE expression_demand_demands SET status='pending', next_at=MAX(next_at,?), claim_token=NULL, claim_epoch=NULL, lease_until=NULL, revision=revision+1, updated_at=? WHERE status='reviewing'`).run(at+LIMITS.failureBackoffMs,at);
  } catch (error) { db.close(); throw error; }

  const now = () => {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8.64e15) throw new TypeError('invalid_clock_value');
    return at;
  };
  const guard = () => { if (closed) throw new Error('expression_demand_store_closed'); };
  const rejection = reason => ({ accepted: false, status: 'rejected', reason });

  const getMeta = key => db.prepare('SELECT value FROM expression_demand_meta WHERE key=?').get(key)?.value ?? null;
  const setMeta = (key, value) => db.prepare('INSERT INTO expression_demand_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  const delMeta = key => db.prepare('DELETE FROM expression_demand_meta WHERE key=?').run(key);

  // Clock monotonicity is part of lease safety: a backwards jump revokes every running claim and
  // stalls the epoch that was executing until the host presents a new epoch (recovery).
  function checkClock(epoch) {
    const at = now();
    const highRaw = getMeta('clock_high');
    const high = highRaw === null ? null : Number(highRaw);
    const stall = getMeta('clock_stall_epoch');
    const key = epochKey(epoch);
    if (high !== null && at < high) {
      for (const row of db.prepare("SELECT id FROM expression_demand_demands WHERE status='reviewing'").all()) {
        db.prepare(`UPDATE expression_demand_demands SET status='pending', claim_token=NULL, claim_epoch=NULL, lease_until=NULL, next_at=?, revision=revision+1, updated_at=? WHERE id=?`).run(high, high, row.id);
      }
      if (stall === null || stall === key) {
        if (stall === null) setMeta('clock_stall_epoch', key);
        return { at, stalled: true };
      }
      delMeta('clock_stall_epoch');
      setMeta('clock_high', at); // the new epoch's clock becomes authoritative again
      return { at, stalled: false };
    }
    if (stall !== null) {
      if (stall === key) return { at, stalled: true };
      delMeta('clock_stall_epoch');
    }
    setMeta('clock_high', at);
    return { at, stalled: false };
  }

  const loadRaw = id => db.prepare('SELECT * FROM expression_demand_demands WHERE id=?').get(id);
  const toDemand = row => row && ({
    id: row.id, revision: row.revision, status: row.status, meaning: row.meaning, reason: row.reason,
    evidenceRefs: JSON.parse(row.evidence_refs), deskId: row.desk_id, personaVersion: row.persona_version,
    attempts: row.attempts, nextAt: row.next_at, ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  });

  function evidenceIssue(ref, deskId) {
    if (typeof resolveEvidence !== 'function') return 'evidence_resolution_unavailable';
    let descriptor = null;
    try { descriptor = resolveEvidence(ref.id); } catch { descriptor = null; }
    if (descriptor === null || descriptor === undefined) return 'unknown_evidence';
    if (typeof descriptor !== 'object' || Array.isArray(descriptor)
      || typeof descriptor.id !== 'string' || !descriptor.id || descriptor.id.length > 200
      || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 1
      || typeof descriptor.kind !== 'string' || descriptor.kind.length > 40
      || typeof descriptor.status !== 'string' || descriptor.status.length > 40
      || typeof descriptor.source !== 'string' || descriptor.source.length > 40
      || typeof descriptor.deskId !== 'string' || !descriptor.deskId || descriptor.deskId.length > 200
      || typeof descriptor.learningUse !== 'string' || descriptor.learningUse.length > 40) return 'evidence_descriptor_invalid';
    if (descriptor.id !== ref.id) return 'evidence_id_mismatch';
    if (descriptor.revision !== ref.revision) return 'evidence_revision_stale';
    if (!DEMAND_KINDS.has(descriptor.kind)) return 'evidence_kind_unsupported';
    if (!EVIDENCE_STATUSES.has(descriptor.status)) return 'evidence_status_invalid';
    if (descriptor.status !== 'active') return `evidence_status_${descriptor.status}`;
    if (!DEMAND_SOURCES.has(descriptor.source)) return 'evidence_source_unsupported';
    if (!LEARNING_USES.has(descriptor.learningUse)) return 'evidence_learning_invalid';
    if (descriptor.learningUse !== 'allowed') return `evidence_learning_${descriptor.learningUse}`;
    if (!Number.isSafeInteger(descriptor.learningVersion) || descriptor.learningVersion < 1) return 'evidence_learning_version_invalid';
    if (descriptor.deskId !== deskId) return 'evidence_desk_mismatch';
    return null;
  }
  function evidenceIssueForRefs(refs, deskId) {
    for (const ref of refs) {
      const issue = evidenceIssue(ref, deskId);
      if (issue) return issue;
    }
    return null;
  }
  // A demand may only complete 'ready' against a real library candidate: structurally checked,
  // same scope, and covering every original evidence ref at its exact revision. The model cannot
  // supply its own recipe object to bypass the library — candidateId is the only reference.
  function candidateIssue(candidateId, demand, { required }) {
    if (typeof resolveCandidate !== 'function') return required ? 'candidate_resolution_unavailable' : null;
    let candidate = null;
    try { candidate = resolveCandidate(candidateId); } catch { candidate = null; }
    if (candidate === null || candidate === undefined) return 'unknown_candidate';
    if (typeof candidate !== 'object' || Array.isArray(candidate)) return 'candidate_descriptor_invalid';
    if (candidate.id !== candidateId) return 'candidate_id_mismatch';
    if (candidate.status !== 'ready') return 'candidate_not_ready';
    if (!candidate.structuralCheck || typeof candidate.structuralCheck !== 'object' || candidate.structuralCheck.status !== 'passed') return 'candidate_structure_failed';
    if (candidate.deskId !== demand.deskId || candidate.personaVersion !== demand.personaVersion) return 'candidate_scope_mismatch';
    if (!Array.isArray(candidate.evidenceRefs)) return 'candidate_descriptor_invalid';
    const covered = new Map();
    for (const ref of candidate.evidenceRefs) {
      if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision)) return 'candidate_descriptor_invalid';
      covered.set(ref.id, ref.revision);
    }
    for (const ref of demand.evidenceRefs) if (covered.get(ref.id) !== ref.revision) return 'candidate_evidence_gap';
    return null;
  }

  // Invalidation never rewrites refs to a newer revision: the demand dies and a fresh proposal
  // must re-ground itself. Any running claim is cancelled and any candidate link removed.
  function invalidateRow(row, at) {
    db.prepare(`UPDATE expression_demand_demands SET status='invalidated', candidate_id=NULL, claim_token=NULL, claim_epoch=NULL, lease_until=NULL, revision=revision+1, updated_at=? WHERE id=?`).run(at, row.id);
  }
  function pruneRequestAliases() {
    db.prepare('DELETE FROM expression_demand_requests WHERE demand_id NOT IN (SELECT id FROM expression_demand_demands)').run();
    let count = db.prepare('SELECT COUNT(*) AS n FROM expression_demand_requests').get().n;
    if (count <= LIMITS.maxRequests) return;
    // Bounded globally; the oldest idempotency links are dropped first so proposals never block.
    db.prepare(`DELETE FROM expression_demand_requests WHERE rowid IN (SELECT rowid FROM expression_demand_requests ORDER BY at, rowid LIMIT ?)`).run(count - LIMITS.maxRequests);
  }

  function propose(input, scopeInput) {
    guard();
    fields(input, ['requestId', 'meaning', 'reason', 'evidenceRefs', 'nextAt'], 'proposal');
    const scope = scopeOf(scopeInput);
    const requestId = text(input.requestId, 'request_id', LIMITS.maxRequestIdLength);
    const meaning = text(input.meaning, 'meaning', LIMITS.maxMeaningLength);
    const reason = input.reason === undefined ? null : text(input.reason, 'reason', LIMITS.maxReasonLength);
    const evidenceRefs = validateRefs(input.evidenceRefs);
    const nextAt = input.nextAt === undefined ? null : input.nextAt;
    if (nextAt !== null && (!Number.isSafeInteger(nextAt) || nextAt < 0 || nextAt > 8.64e15)) throw new TypeError('invalid_next_at');
    const at = now();

    // requestId is scoped per desk+persona: a retry replays its original result, a conflicting
    // retry is refused, and no information crosses scope boundaries.
    const recorded = db.prepare('SELECT * FROM expression_demand_requests WHERE desk_id=? AND persona_version=? AND request_id=?').get(scope.deskId, scope.personaVersion, requestId);
    const contentHash = createHash('sha256').update(stableStringify({ deskId: scope.deskId, personaVersion: scope.personaVersion, meaning, reason, evidenceRefs })).digest('hex');
    if (recorded) {
      if (recorded.content_hash !== contentHash) return rejection('request_conflict');
      const existing = loadRaw(recorded.demand_id);
      if (existing) return { accepted: true, status: existing.status, replayed: true, demand: toDemand(existing) };
      db.prepare('DELETE FROM expression_demand_requests WHERE desk_id=? AND persona_version=? AND request_id=?').run(scope.deskId, scope.personaVersion, requestId); // defensive: demand pruned or forgotten
    }

    for (const ref of evidenceRefs) {
      const issue = evidenceIssue(ref, scope.deskId);
      if (issue) return rejection(issue); // non-personal, stale or foreign evidence never enters the ledger.
    }

    // Identical content already in flight merges instead of accumulating a duplicate.
    const duplicate = db.prepare(`SELECT * FROM expression_demand_demands WHERE desk_id=? AND persona_version=? AND content_hash=? AND status IN ('pending','reviewing') ORDER BY rowid`).get(scope.deskId, scope.personaVersion, contentHash);
    if (duplicate) {
      db.prepare('INSERT OR REPLACE INTO expression_demand_requests(desk_id,persona_version,request_id,demand_id,content_hash,at) VALUES(?,?,?,?,?,?)').run(scope.deskId, scope.personaVersion, requestId, duplicate.id, contentHash, at);
      pruneRequestAliases();
      return { accepted: true, status: duplicate.status, merged: true, demand: toDemand(duplicate) };
    }

    const activeCount = db.prepare(`SELECT COUNT(*) AS n FROM expression_demand_demands WHERE desk_id=? AND persona_version=? AND status IN ('pending','reviewing')`).get(scope.deskId, scope.personaVersion).n;
    if (activeCount >= LIMITS.maxActivePerScope) return rejection('active_budget');
    const total = db.prepare('SELECT COUNT(*) AS n FROM expression_demand_demands WHERE desk_id=? AND persona_version=?').get(scope.deskId, scope.personaVersion).n;
    if (total >= LIMITS.maxTotalPerScope) {
      // Growth policy: reclaim the oldest terminal rows first; live demands are never evicted.
      const excess = total - LIMITS.maxTotalPerScope + 1;
      const prunable = db.prepare(`SELECT id FROM expression_demand_demands WHERE desk_id=? AND persona_version=? AND status IN ('ready','abandoned','failed','invalidated') ORDER BY updated_at, rowid LIMIT ?`).all(scope.deskId, scope.personaVersion, excess);
      for (const row of prunable) {
        db.prepare('DELETE FROM expression_demand_demands WHERE id=?').run(row.id);
        db.prepare('DELETE FROM expression_demand_requests WHERE demand_id=?').run(row.id);
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM expression_demand_demands WHERE desk_id=? AND persona_version=?').get(scope.deskId, scope.personaVersion).n >= LIMITS.maxTotalPerScope) return rejection('demand_budget');
    }

    const id = `demand-${randomUUID()}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO expression_demand_demands(id,desk_id,persona_version,content_hash,revision,status,meaning,reason,evidence_refs,attempts,next_at,candidate_id,claim_token,claim_epoch,lease_until,created_at,updated_at)
        VALUES(?,?,?,?,1,'pending',?,?,?,0,?,NULL,NULL,NULL,NULL,?,?)`).run(id, scope.deskId, scope.personaVersion, contentHash, meaning, reason, JSON.stringify(evidenceRefs), nextAt ?? at, at, at);
      db.prepare('INSERT OR REPLACE INTO expression_demand_requests(desk_id,persona_version,request_id,demand_id,content_hash,at) VALUES(?,?,?,?,?,?)').run(scope.deskId, scope.personaVersion, requestId, id, contentHash, at);
      pruneRequestAliases();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { accepted: true, status: 'pending', demand: toDemand(loadRaw(id)) };
  }

  function list(input = {}, scopeInput) {
    guard();
    fields(input, ['status', 'limit'], 'list');
    const scope = scopeOf(scopeInput);
    if (input.status !== undefined && !STATUSES.has(input.status)) throw new TypeError('invalid_status');
    let limit = LIMITS.listDefault;
    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new TypeError('invalid_limit');
      limit = Math.min(input.limit, LIMITS.listMax);
    }
    const at = now();
    const rows = db.prepare('SELECT * FROM expression_demand_demands WHERE desk_id=? AND persona_version=? ORDER BY next_at, updated_at DESC, rowid DESC').all(scope.deskId, scope.personaVersion);
    const result = [];
    for (const row of rows) {
      let current = row;
      if (LIVE.has(row.status) && typeof resolveEvidence === 'function') {
        // Reads re-verify sources: a record whose grounding died is invalidated on the spot and
        // is never exposed again with its old semantics presented as a valid reference.
        let issue = evidenceIssueForRefs(JSON.parse(row.evidence_refs), scope.deskId);
        if (!issue && row.status === 'ready' && row.candidate_id) issue = candidateIssue(row.candidate_id, toDemand(row), { required: false });
        if (issue) { invalidateRow(row, at); current = loadRaw(row.id); }
      }
      if (input.status !== undefined && current.status !== input.status) continue;
      result.push(toDemand(current));
      if (result.length >= limit) break;
    }
    return result;
  }

  function claimDue(input) {
    guard();
    fields(input, ['enabled', 'epoch', 'deskId', 'personaVersion', 'allowBackground'], 'claim_due');
    if (typeof input.enabled !== 'boolean') throw new TypeError('invalid_enabled');
    if (typeof input.allowBackground !== 'boolean') throw new TypeError('invalid_allow_background');
    const epoch = epochOf(input.epoch);
    const scope = scopeOf({ deskId: input.deskId, personaVersion: input.personaVersion });
    if (input.enabled !== true || input.allowBackground !== true) return null; // background work only runs when the host explicitly allows it.
    const clockState = checkClock(epoch);
    if (clockState.stalled) return rejection('clock_regressed');
    const at = clockState.at;
    const key = epochKey(epoch);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare(`SELECT * FROM expression_demand_demands WHERE desk_id=? AND persona_version=? AND status='reviewing'`).all(scope.deskId, scope.personaVersion)) {
        if (row.lease_until > at && row.claim_epoch === key) { db.exec('COMMIT'); return null; } // one live claim per scope at a time
        // Expired or old-epoch leases are reclaimed; the persisted attempt count decides whether
        // the demand may retry after the failure backoff or is exhausted.
        const status = row.attempts >= LIMITS.maxAttempts ? 'failed' : 'pending';
        db.prepare(`UPDATE expression_demand_demands SET status=?, next_at=?, claim_token=NULL, claim_epoch=NULL, lease_until=NULL, revision=revision+1, updated_at=? WHERE id=?`).run(status, at + LIMITS.failureBackoffMs, at, row.id);
      }
      const due = db.prepare(`SELECT * FROM expression_demand_demands WHERE desk_id=? AND persona_version=? AND status='pending' AND next_at<=? ORDER BY next_at, updated_at, rowid`).all(scope.deskId, scope.personaVersion, at);
      for (const row of due) {
        if (row.attempts >= LIMITS.maxAttempts) {
          db.prepare(`UPDATE expression_demand_demands SET status='failed', revision=revision+1, updated_at=? WHERE id=?`).run(at, row.id);
          continue;
        }
        const issue = evidenceIssueForRefs(JSON.parse(row.evidence_refs), scope.deskId);
        if (issue) { invalidateRow(row, at); continue; } // only currently legal sources may be worked on
        const claimToken = randomUUID();
        const leaseUntil = at + LIMITS.leaseMs;
        db.prepare(`UPDATE expression_demand_demands SET status='reviewing', attempts=attempts+1, claim_token=?, claim_epoch=?, lease_until=?, revision=revision+1, updated_at=? WHERE id=?`).run(claimToken, key, leaseUntil, at, row.id);
        db.exec('COMMIT');
        return { accepted: true, status: 'reviewing', id: row.id, claimToken, leaseUntil, demand: toDemand(loadRaw(row.id)) };
      }
      db.exec('COMMIT');
      return null;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function authorizeClaim(input,contextInput){
    guard();fields(input,['id','claimToken'],'authorize_claim');
    const id=text(input.id,'demand_id',200),claimToken=text(input.claimToken,'claim_token',200),context=contextOf(contextInput);
    if(context.enabled!==true)return rejection('disabled');
    const clockState=checkClock(context.epoch);if(clockState.stalled)return rejection('clock_regressed');
    const row=loadRaw(id);
    if(!row||row.desk_id!==context.deskId||row.persona_version!==context.personaVersion)return rejection('unknown_demand');
    if(row.status!=='reviewing'||row.claim_token!==claimToken||row.claim_epoch!==epochKey(context.epoch)||row.lease_until<=clockState.at)return rejection('claim_stale');
    const issue=evidenceIssueForRefs(JSON.parse(row.evidence_refs),context.deskId);
    if(issue){invalidateRow(row,clockState.at);return rejection(issue);}
    return {accepted:true,status:'authorized',demand:toDemand(row),leaseUntil:row.lease_until};
  }

  function complete(input, contextInput) {
    guard();
    fields(input, ['id', 'claimToken', 'outcome', 'candidateId'], 'complete');
    const id = text(input.id, 'demand_id', 200);
    const claimToken = text(input.claimToken, 'claim_token', 200);
    if (!['ready', 'unnecessary'].includes(input.outcome)) throw new TypeError('invalid_outcome');
    const candidateId = input.candidateId === undefined ? null : text(input.candidateId, 'candidate_id', 200);
    const context = contextOf(contextInput);
    if (context.enabled !== true) return rejection('disabled');
    const clockState = checkClock(context.epoch);
    if (clockState.stalled) return rejection('clock_regressed');
    const at = clockState.at;
    const row = loadRaw(id);
    if (!row || row.desk_id !== context.deskId || row.persona_version !== context.personaVersion) return rejection('unknown_demand');
    // Only the current short lease may settle the demand: stale, expired or foreign claims can
    // never silently modify new work.
    if (row.status !== 'reviewing' || row.claim_token !== claimToken || row.claim_epoch !== epochKey(context.epoch) || row.lease_until <= at) return rejection('claim_stale');

    if (input.outcome === 'unnecessary') {
      db.prepare(`UPDATE expression_demand_demands SET status='abandoned', claim_token=NULL, claim_epoch=NULL, lease_until=NULL, revision=revision+1, updated_at=? WHERE id=?`).run(at, id);
      return { accepted: true, status: 'abandoned', demand: toDemand(loadRaw(id)) };
    }
    if (candidateId === null) throw new TypeError('invalid_candidate_id');
    const demand = toDemand(row);
    const issue = candidateIssue(candidateId, demand, { required: true }) ?? evidenceIssueForRefs(demand.evidenceRefs, row.desk_id);
    if (issue) return rejection(issue);
    // 'ready' only certifies that a structurally checked library candidate exists for the demand;
    // semanticStatus stays 'unverified' and nothing here played or activated the expression.
    db.prepare(`UPDATE expression_demand_demands SET status='ready', candidate_id=?, claim_token=NULL, claim_epoch=NULL, lease_until=NULL, revision=revision+1, updated_at=? WHERE id=?`).run(candidateId, at, id);
    return { accepted: true, status: 'ready', demand: toDemand(loadRaw(id)) };
  }

  function release(input, contextInput) {
    guard();
    fields(input, ['id', 'claimToken', 'reason'], 'release');
    const id = text(input.id, 'demand_id', 200);
    const claimToken = text(input.claimToken, 'claim_token', 200);
    // Release reasons are scheduler diagnostics only: validated for shape, never persisted, so no
    // stack traces or secrets can enter the ledger through them.
    if (input.reason !== undefined) text(input.reason, 'release_reason', 200);
    const context = contextOf(contextInput);
    const clockState = checkClock(context.epoch);
    if (clockState.stalled) return rejection('clock_regressed');
    const at = clockState.at;
    const row = loadRaw(id);
    if (!row || row.desk_id !== context.deskId || row.persona_version !== context.personaVersion) return rejection('unknown_demand');
    // A paused old epoch may still settle its own claim with the original context, but an expired
    // or superseded token can never touch a newer claim.
    if (row.status !== 'reviewing' || row.claim_token !== claimToken || row.claim_epoch !== epochKey(context.epoch) || row.lease_until <= at) return rejection('claim_stale');
    const status = row.attempts >= LIMITS.maxAttempts ? 'failed' : 'pending';
    db.prepare(`UPDATE expression_demand_demands SET status=?, next_at=?, claim_token=NULL, claim_epoch=NULL, lease_until=NULL, revision=revision+1, updated_at=? WHERE id=?`).run(status, at + LIMITS.failureBackoffMs, at, id);
    return { accepted: true, status, demand: toDemand(loadRaw(id)) };
  }

  function reconcileEvidence() {
    guard();
    if (typeof resolveEvidence !== 'function') return { invalidatedIds: [], checkedCount: 0, reason: 'evidence_resolution_unavailable' };
    const at = now();
    const rows = db.prepare(`SELECT * FROM expression_demand_demands WHERE status IN ('pending','reviewing','ready')`).all();
    const invalidatedIds = [];
    for (const row of rows) {
      let issue = evidenceIssueForRefs(JSON.parse(row.evidence_refs), row.desk_id);
      if (!issue && row.status === 'ready' && row.candidate_id) issue = candidateIssue(row.candidate_id, toDemand(row), { required: false });
      if (!issue) continue;
      invalidateRow(row, at);
      invalidatedIds.push(row.id);
    }
    return { invalidatedIds, checkedCount: rows.length };
  }

  function forgetEvidence(id) {
    guard();
    const evidenceId = text(id, 'evidence_id', 200);
    const doomed = db.prepare('SELECT * FROM expression_demand_demands').all()
      .filter(row => JSON.parse(row.evidence_refs).some(ref => ref.id === evidenceId));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of doomed) {
        // True deletion removes the demand, its idempotency links and every derived personal
        // string — including terminal history; a bare 'deleted' status text would not suffice.
        db.prepare('DELETE FROM expression_demand_demands WHERE id=?').run(row.id);
        db.prepare('DELETE FROM expression_demand_requests WHERE demand_id=?').run(row.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { deletedDemandIds: doomed.map(row => row.id) }; // the root cancels queued work against these ids
  }

  function snapshot(scopeInput) {
    guard();
    const scope = scopeOf(scopeInput);
    const rows = db.prepare('SELECT * FROM expression_demand_demands WHERE desk_id=? AND persona_version=? ORDER BY updated_at DESC, rowid DESC').all(scope.deskId, scope.personaVersion);
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    return {
      version: 1, at: now(), deskId: scope.deskId, personaVersion: scope.personaVersion,
      limits: LIMITS,
      counts: {
        total: rows.length,
        active: rows.filter(row => ACTIVE.has(row.status)).length,
        byStatus,
        requests: db.prepare('SELECT COUNT(*) AS n FROM expression_demand_requests WHERE desk_id=? AND persona_version=?').get(scope.deskId, scope.personaVersion).n,
      },
      // Tokenless working metadata only — claim tokens and lease internals never leave the store.
      demands: rows.slice(0, LIMITS.snapshotDemands).map(toDemand),
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  return { propose, list, claimDue, authorizeClaim, complete, release, reconcileEvidence, forgetEvidence, snapshot, close };
}

export { LIMITS };
