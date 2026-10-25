// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_TIME = 8_640_000_000_000_000;
const DEFAULTS = Object.freeze({
  reviewMinIntervalMs: 30_000,
  reviewRetryDelayMs: 30_000,
  maxInterestAttempts: 3,
  maxInterests: 64,
  maxInterestStates: 128,
  maxClaimRecords: 256,
  invitationWindowMs: 3_600_000,
  invitationLimit: 3,
  restrictedInvitationLimit: 1,
  noResponseCooldownMs: 900_000,
  invitationLeaseMaxMs: 5_000,
  maxInvitations: 512,
  maxDeskBudgets: 128,
  snapshotLimit: 20,
});
const TERMINAL_INTEREST = new Set(['completed', 'stale', 'exhausted', 'cancelled', 'invalidated']);
const INTEREST_OUTCOMES = new Set(['completed', 'aborted', 'failed', 'stale']);
const ACTIVE_INTEREST = new Set(['active', 'paused', 'resolved', 'dismissed', 'invalidated']);
const CURIOSITY = new Set(['minimal', 'gentle', 'exploratory']);

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`invalid_${name}`);
  return value;
}
function fields(value, allowed, name) {
  object(value, name);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`unknown_${name}_field`);
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`invalid_${name}`);
  return value;
}
function identifier(value, name = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) throw new TypeError(`invalid_${name}`);
  return value;
}
function deskIdentifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || value.includes('\0')) throw new TypeError('invalid_desk_id');
  return value;
}
function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`invalid_${name}`);
  return value;
}
function pathValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new TypeError('invalid_path');
  return value;
}
function profileValue(value, deskId) {
  fields(value, ['deskId', 'quietMode', 'curiosity', 'version', 'updatedAt', 'source'], 'profile');
  deskIdentifier(value.deskId);
  if (value.deskId !== deskId) return false;
  boolean(value.quietMode, 'quiet_mode');
  if (!CURIOSITY.has(value.curiosity)) throw new TypeError('invalid_curiosity');
  integer(value.version, 1, Number.MAX_SAFE_INTEGER, 'profile_version');
  return true;
}
function parsePolicy(value) {
  fields(value, Object.keys(DEFAULTS), 'policy');
  const policy = { ...DEFAULTS, ...value };
  integer(policy.reviewMinIntervalMs, 0, 86_400_000, 'reviewMinIntervalMs');
  integer(policy.reviewRetryDelayMs, 0, 604_800_000, 'reviewRetryDelayMs');
  integer(policy.maxInterestAttempts, 1, 10, 'maxInterestAttempts');
  integer(policy.maxInterests, 1, 256, 'maxInterests');
  integer(policy.maxInterestStates, policy.maxInterests, 4096, 'maxInterestStates');
  integer(policy.maxClaimRecords, 1, 4096, 'maxClaimRecords');
  integer(policy.invitationWindowMs, 1, 604_800_000, 'invitationWindowMs');
  integer(policy.invitationLimit, 1, 100, 'invitationLimit');
  integer(policy.restrictedInvitationLimit, 1, policy.invitationLimit, 'restrictedInvitationLimit');
  integer(policy.noResponseCooldownMs, 0, 604_800_000, 'noResponseCooldownMs');
  integer(policy.invitationLeaseMaxMs, 1, 60_000, 'invitationLeaseMaxMs');
  integer(policy.maxInvitations, policy.invitationLimit, 4096, 'maxInvitations');
  integer(policy.maxDeskBudgets, 1, 4096, 'maxDeskBudgets');
  integer(policy.snapshotLimit, 1, 50, 'snapshotLimit');
  return Object.freeze(policy);
}
function interestValue(value) {
  object(value, 'interest');
  identifier(value.id, 'interest_id');
  if (value.kind !== 'interest') throw new TypeError('invalid_interest_kind');
  deskIdentifier(value.deskId);
  if (!ACTIVE_INTEREST.has(value.status)) throw new TypeError('invalid_interest_status');
  integer(value.revision, 1, Number.MAX_SAFE_INTEGER, 'interest_revision');
  if (value.nextAt !== undefined && value.nextAt !== null) integer(value.nextAt, 0, MAX_TIME, 'interest_nextAt');
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length < 1 || value.evidenceIds.length > 32) throw new TypeError('invalid_interest_evidence');
  const ids = value.evidenceIds.map(id => identifier(id, 'evidence_id'));
  if (new Set(ids).size !== ids.length) throw new TypeError('invalid_interest_evidence');
  object(value.evidenceRevisions, 'evidence_revisions');
  if (Object.keys(value.evidenceRevisions).length !== ids.length) throw new TypeError('invalid_interest_evidence');
  const refs = ids.sort().map(id => [id, integer(value.evidenceRevisions[id], 1, Number.MAX_SAFE_INTEGER, 'evidence_revision')]);
  return { id: value.id, deskId: value.deskId, status: value.status, revision: value.revision,
    nextAt: value.nextAt ?? null, source: value.source, evidenceKey: JSON.stringify(refs) };
}
function observationValue(value) {
  if (value === null || value === undefined) return null;
  fields(value, ['id', 'at', 'source', 'coverage'], 'observation');
  identifier(value.id, 'observation_id');
  integer(value.at, 0, MAX_TIME, 'observation_at');
  if (!['camera', 'replay', 'synthetic'].includes(value.source)) throw new TypeError('invalid_observation_source');
  if (!['visible', 'partial', 'unknown'].includes(value.coverage)) throw new TypeError('invalid_observation_coverage');
  return { id: value.id, at: value.at, source: value.source, coverage: value.coverage };
}
function contextValue(input) {
  fields(input, ['enabled', 'epoch', 'deskId', 'mode', 'profile', 'observation', 'interests', 'inferenceBusy', 'allowReplay'], 'poll');
  boolean(input.enabled, 'enabled');
  boolean(input.inferenceBusy, 'inferenceBusy');
  if (input.allowReplay !== undefined) boolean(input.allowReplay, 'allowReplay');
  deskIdentifier(input.deskId);
  if (!['cloud', 'fixture'].includes(input.mode)) throw new TypeError('invalid_mode');
  if (profileValue(input.profile, input.deskId) !== true) throw new TypeError('profile_desk_mismatch');
  if (!Array.isArray(input.interests)) throw new TypeError('invalid_interests');
  const observation = observationValue(input.observation);
  const interests = input.interests.map(interestValue);
  const keys = interests.map(item => `${item.deskId}\0${item.id}`);
  if (new Set(keys).size !== keys.length) throw new TypeError('duplicate_interest');
  return { ...input, epochValid: Number.isSafeInteger(input.epoch) && input.epoch >= 0,
    observation, interests, allowReplay: input.allowReplay === true };
}
function invitationValue(input) {
  fields(input, ['requestId', 'deskId', 'epoch', 'interestId', 'durationMs'], 'invitation');
  identifier(input.requestId, 'request_id');
  deskIdentifier(input.deskId);
  if (input.interestId !== undefined) identifier(input.interestId, 'interest_id');
  integer(input.durationMs, 1, 60_000, 'durationMs');
  return input;
}
function receiptValue(value) {
  fields(value, ['id', 'status', 'at'], 'receipt');
  identifier(value.id, 'receipt_id');
  if (value.status !== 'accepted') throw new TypeError('invalid_receipt_status');
  integer(value.at, 0, MAX_TIME, 'receipt_at');
  return value;
}
function sameInterestState(state, item) {
  return state && state.desk_id === item.deskId && state.interest_id === item.id && state.revision === item.revision && state.next_at === item.nextAt;
}
function interestSourceAllowed(item, allowReplay) {
  return item.source === 'camera' || (item.source === 'replay' && allowReplay);
}

/**
 * Persistent timing, claims and ordinary-invitation budgets only.
 * The host owns observations, interests, Pi runs, expressions and reminders.
 */
export function createAutonomyCoordinator({ path, clock = Date.now, policy: policyInput = {} } = {}) {
  pathValue(path);
  if (typeof clock !== 'function') throw new TypeError('invalid_clock');
  const policy = parsePolicy(policyInput);
  const db = new DatabaseSync(path);
  let closed = false;
  let lastNow = 0;
  try {
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS autonomy_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS autonomy_interest_states(
        desk_id TEXT NOT NULL,interest_id TEXT NOT NULL,revision INTEGER NOT NULL,next_at INTEGER,
        evidence_key TEXT NOT NULL,attempts INTEGER NOT NULL,status TEXT NOT NULL,next_eligible_at INTEGER,
        last_claim_id TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(desk_id,interest_id));
      CREATE TABLE IF NOT EXISTS autonomy_interest_claims(
        id TEXT PRIMARY KEY,claim_token TEXT UNIQUE,desk_id TEXT NOT NULL,interest_id TEXT NOT NULL,
        revision INTEGER NOT NULL,next_at INTEGER NOT NULL,evidence_key TEXT NOT NULL,epoch INTEGER NOT NULL,
        basis_observation_id TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,next_eligible_at INTEGER);
      CREATE INDEX IF NOT EXISTS autonomy_interest_claim_status ON autonomy_interest_claims(status,updated_at);
      CREATE TABLE IF NOT EXISTS autonomy_invitations(
        lease_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,desk_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        interest_id TEXT,duration_ms INTEGER NOT NULL,budget_limit INTEGER NOT NULL,status TEXT NOT NULL,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,delivered_at INTEGER,
        receipt_id TEXT,receipt_at INTEGER,response_action TEXT,response_at INTEGER);
      CREATE INDEX IF NOT EXISTS autonomy_invitation_delivery ON autonomy_invitations(desk_id,status,delivered_at);
      CREATE TABLE IF NOT EXISTS autonomy_desk_budgets(
        desk_id TEXT PRIMARY KEY,cooldown_until INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
    const version = db.prepare("SELECT value FROM autonomy_meta WHERE key='schema_version'").get()?.value;
    if (version !== undefined && version !== '1') throw new Error('unsupported_autonomy_schema');
    db.prepare("INSERT OR IGNORE INTO autonomy_meta(key,value) VALUES('schema_version','1')").run();
    lastNow = Number(db.prepare("SELECT value FROM autonomy_meta WHERE key='last_now'").get()?.value ?? 0);
  } catch (error) { db.close(); throw error; }

  function meta(key) { return db.prepare('SELECT value FROM autonomy_meta WHERE key=?').get(key)?.value; }
  function setMeta(key, value) {
    db.prepare('INSERT INTO autonomy_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  function deleteMeta(key) { db.prepare('DELETE FROM autonomy_meta WHERE key=?').run(key); }
  function tick() {
    const raw = integer(clock(), 0, MAX_TIME, 'clock');
    const rollback = raw < lastNow;
    if (raw > lastNow) { lastNow = raw; setMeta('last_now', lastNow); }
    return { raw, at: lastNow, rollback };
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function currentEpoch() { const value = meta('current_epoch'); return value === undefined ? null : Number(value); }
  function activeClaim() { return db.prepare("SELECT * FROM autonomy_interest_claims WHERE status='claimed' ORDER BY created_at DESC LIMIT 1").get(); }
  function stateFor(item) {
    return db.prepare('SELECT * FROM autonomy_interest_states WHERE desk_id=? AND interest_id=?').get(item.deskId, item.id);
  }
  function putState(item, values, at) {
    db.prepare(`INSERT INTO autonomy_interest_states
      (desk_id,interest_id,revision,next_at,evidence_key,attempts,status,next_eligible_at,last_claim_id,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(desk_id,interest_id) DO UPDATE SET revision=excluded.revision,next_at=excluded.next_at,
      evidence_key=excluded.evidence_key,attempts=excluded.attempts,status=excluded.status,
      next_eligible_at=excluded.next_eligible_at,last_claim_id=excluded.last_claim_id,updated_at=excluded.updated_at`)
      .run(item.deskId, item.id, item.revision, item.nextAt, item.evidenceKey, values.attempts, values.status,
        values.nextEligibleAt ?? null, values.claimId ?? null, at);
  }
  function updateClaimStatus(claim, status, at, nextEligibleAt = null) {
    db.prepare('UPDATE autonomy_interest_claims SET status=?,updated_at=?,next_eligible_at=? WHERE id=?').run(status, at, nextEligibleAt, claim.id);
  }
  function invalidateClaim(claim, at, status = 'invalidated') {
    updateClaimStatus(claim, status, at);
    db.prepare(`UPDATE autonomy_interest_states SET status=?,next_eligible_at=NULL,updated_at=?
      WHERE desk_id=? AND interest_id=? AND last_claim_id=?`).run(status, at, claim.desk_id, claim.interest_id, claim.id);
  }
  function recoverClaim(claim, at, claimStatus = 'cancelled') {
    const nextEligibleAt = Math.max(claim.next_eligible_at ?? 0, claim.created_at + policy.reviewMinIntervalMs);
    updateClaimStatus(claim, claimStatus, at, nextEligibleAt);
    db.prepare(`UPDATE autonomy_interest_states SET status='recovered',next_eligible_at=?,updated_at=?
      WHERE desk_id=? AND interest_id=? AND last_claim_id=?`).run(nextEligibleAt, at, claim.desk_id, claim.interest_id, claim.id);
  }
  function advanceEpoch(epoch, at) {
    const previous = currentEpoch();
    if (previous === epoch) return;
    if (previous !== null && epoch < previous) return;
    const claim = activeClaim();
    if (claim) recoverClaim(claim, at);
    db.prepare("UPDATE autonomy_invitations SET status='cancelled',updated_at=? WHERE status='reserved'").run(at);
    setMeta('current_epoch', epoch);
  }
  function pruneClaims() {
    const rows = db.prepare('SELECT id,status FROM autonomy_interest_claims ORDER BY updated_at DESC,rowid DESC').all();
    const remove = rows.slice(policy.maxClaimRecords).filter(row => row.status !== 'claimed');
    for (const row of remove) db.prepare('DELETE FROM autonomy_interest_claims WHERE id=?').run(row.id);
  }
  function pruneInvitations(at, reserveSlots = 0) {
    const rows = db.prepare('SELECT lease_id,status,delivered_at FROM autonomy_invitations ORDER BY updated_at DESC,rowid DESC').all();
    const keep = new Set(rows.filter(row => row.status === 'reserved' ||
      (row.status === 'delivered' && row.delivered_at > at - policy.invitationWindowMs)).map(row => row.lease_id));
    const target = Math.max(keep.size, policy.maxInvitations - reserveSlots);
    for (const row of rows) if (keep.size < target) keep.add(row.lease_id);
    for (const row of rows) if (!keep.has(row.lease_id)) db.prepare('DELETE FROM autonomy_invitations WHERE lease_id=?').run(row.lease_id);
  }
  function expireReserved(at) {
    db.prepare("UPDATE autonomy_invitations SET status='expired',updated_at=? WHERE status='reserved' AND expires_at<=?").run(at, at);
  }
  function deliveredCount(deskId, at) {
    return db.prepare("SELECT COUNT(*) AS count FROM autonomy_invitations WHERE desk_id=? AND status='delivered' AND delivered_at>? AND delivered_at<=?")
      .get(deskId, at - policy.invitationWindowMs, at).count;
  }
  function reject(status) { return { accepted: false, status }; }

  // Recovery preserves accounting but revokes every outstanding process authority.
  transaction(() => {
    const at = tick().at;
    for (const claim of db.prepare("SELECT * FROM autonomy_interest_claims WHERE status='claimed'").all()) {
      const nextEligibleAt = Math.max(claim.next_eligible_at ?? 0, claim.created_at + policy.reviewMinIntervalMs);
      updateClaimStatus(claim, 'recovered', at, nextEligibleAt);
      db.prepare(`UPDATE autonomy_interest_states SET status='recovered',next_eligible_at=?,updated_at=?
        WHERE desk_id=? AND interest_id=? AND last_claim_id=?`).run(nextEligibleAt, at, claim.desk_id, claim.interest_id, claim.id);
    }
    db.prepare("UPDATE autonomy_invitations SET status='expired',updated_at=? WHERE status='reserved'").run(at);
    deleteMeta('current_epoch');
  });

  function poll(input) {
    if (closed) return { events: [], reason: 'closed' };
    if (Array.isArray(input?.interests) && input.interests.length > policy.maxInterests)
      return { events: [], reason: 'interest_budget_exceeded' };
    const context = contextValue(input);
    if (!context.epochValid) return { events: [], reason: 'invalid_epoch' };
    const time = tick();
    return transaction(() => {
      if (time.rollback) return { events: [], reason: 'clock_rollback' };
      const previousEpoch = currentEpoch();
      if (previousEpoch !== null && context.epoch < previousEpoch) return { events: [], reason: 'stale_epoch' };
      advanceEpoch(context.epoch, time.at);
      const claim = activeClaim();
      if (claim) {
        const current = context.interests.find(item => item.deskId === claim.desk_id && item.id === claim.interest_id);
        let invalid = null;
        if (!context.enabled) invalid = 'disabled';
        else if (context.mode !== 'cloud') invalid = 'not_cloud';
        else if (claim.desk_id !== context.deskId || claim.epoch !== context.epoch) invalid = 'scope_changed';
        else if (!current || current.deskId !== claim.desk_id || current.revision !== claim.revision ||
          current.nextAt !== claim.next_at || current.evidenceKey !== claim.evidence_key || current.status !== 'active' ||
          !interestSourceAllowed(current, context.allowReplay)) invalid = 'interest_changed';
        if (invalid) {
          if (invalid === 'interest_changed') invalidateClaim(claim, time.at);
          else recoverClaim(claim, time.at);
          return { events: [], reason: 'claim_invalidated' };
        }
        return { events: [], reason: 'claim_in_flight' };
      }
      if (!context.enabled) return { events: [], reason: 'disabled' };
      if (context.mode !== 'cloud') return { events: [], reason: 'not_cloud' };
      if (!context.observation) return { events: [], reason: 'missing_observation' };
      if (context.observation.at > time.raw) return { events: [], reason: 'future_observation' };
      if (time.raw - context.observation.at > 10_000) return { events: [], reason: 'stale_observation' };
      if (context.observation.source === 'synthetic') return { events: [], reason: 'unsupported_observation_source' };
      if (context.observation.source === 'replay' && !context.allowReplay) return { events: [], reason: 'replay_not_allowed' };
      if (context.inferenceBusy) return { events: [], reason: 'inference_busy' };

      const candidates = [];
      let retryPending = false;
      let sourceBlocked = false;
      for (const item of context.interests) {
        if (item.deskId !== context.deskId || item.status !== 'active' || item.nextAt === null || item.nextAt > time.at) continue;
        if (!interestSourceAllowed(item, context.allowReplay)) { sourceBlocked = true; continue; }
        const state = stateFor(item);
        if (state && state.revision > item.revision) continue;
        if (sameInterestState(state, item)) {
          if (TERMINAL_INTEREST.has(state.status) || state.status === 'claimed') continue;
          if (state.attempts >= policy.maxInterestAttempts) continue;
          if (state.next_eligible_at !== null && time.at < state.next_eligible_at) { retryPending = true; continue; }
        }
        candidates.push({ item, state });
      }
      if (!candidates.length) return { events: [], reason: sourceBlocked ? 'interest_source_not_allowed' : retryPending ? 'retry_cooldown' : 'no_due_interest' };
      const lastClaimAt = Number(meta('last_interest_claim_at') ?? -Infinity);
      if (time.at - lastClaimAt < policy.reviewMinIntervalMs) return { events: [], reason: 'review_cooldown' };
      candidates.sort((a, b) => a.item.nextAt - b.item.nextAt || a.item.revision - b.item.revision || a.item.id.localeCompare(b.item.id));
      const { item, state } = candidates[0];
      if (!state && db.prepare('SELECT COUNT(*) AS count FROM autonomy_interest_states').get().count >= policy.maxInterestStates)
        return { events: [], reason: 'interest_state_budget_exceeded' };
      const attempt = sameInterestState(state, item) ? state.attempts + 1 : 1;
      const id = randomUUID();
      const claimToken = randomUUID();
      db.prepare(`INSERT INTO autonomy_interest_claims
        (id,claim_token,desk_id,interest_id,revision,next_at,evidence_key,epoch,basis_observation_id,attempt,status,created_at,updated_at,next_eligible_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'claimed',?,?,NULL)`)
        .run(id, claimToken, item.deskId, item.id, item.revision, item.nextAt, item.evidenceKey, context.epoch,
          context.observation.id, attempt, time.at, time.at);
      putState(item, { attempts: attempt, status: 'claimed', claimId: id }, time.at);
      setMeta('last_interest_claim_at', time.at);
      pruneClaims();
      return { events: [{ id, kind: 'interest', at: time.at, claimToken,
        payload: { interestId: item.id, interestRevision: item.revision, deskId: item.deskId,
          basisObservationId: context.observation.id, reason: 'interest_due' } }], reason: null };
    });
  }

  function settle(input) {
    if (closed) return { accepted: false, status: 'closed' };
    fields(input, ['id', 'claimToken', 'outcome'], 'settle');
    identifier(input.id, 'claim_id'); identifier(input.claimToken, 'claim_token');
    if (!INTEREST_OUTCOMES.has(input.outcome)) throw new TypeError('invalid_settle_outcome');
    const time = tick();
    return transaction(() => {
      const claim = db.prepare('SELECT * FROM autonomy_interest_claims WHERE id=?').get(input.id);
      if (!claim) return reject('unknown_claim');
      if (claim.status !== 'claimed' || claim.claim_token !== input.claimToken) return reject('claim_not_active');
      const item = { deskId: claim.desk_id, id: claim.interest_id, revision: claim.revision, nextAt: claim.next_at, evidenceKey: claim.evidence_key };
      let nextEligibleAt;
      let stateStatus = input.outcome;
      if (input.outcome === 'aborted' || input.outcome === 'failed') {
        if (claim.attempt < policy.maxInterestAttempts) nextEligibleAt = time.at + policy.reviewRetryDelayMs;
        else stateStatus = 'exhausted';
      }
      updateClaimStatus(claim, input.outcome, time.at, nextEligibleAt);
      putState(item, { attempts: claim.attempt, status: stateStatus, nextEligibleAt, claimId: claim.id }, time.at);
      pruneClaims();
      return { accepted: true, status: input.outcome, ...(nextEligibleAt === undefined ? {} : { nextEligibleAt }) };
    });
  }

  function reserveInvitation(input, context) {
    if (closed) return { accepted: false, reason: 'closed' };
    const request = invitationValue(input);
    fields(context, ['enabled', 'profile'], 'invitation_context');
    boolean(context.enabled, 'enabled');
    if (profileValue(context.profile, request.deskId) !== true) return { accepted: false, reason: 'desk_mismatch' };
    integer(request.durationMs, 1, policy.invitationLeaseMaxMs, 'durationMs');
    if (!Number.isSafeInteger(request.epoch) || request.epoch < 0) return { accepted: false, reason: 'invalid_epoch' };
    const time = tick();
    return transaction(() => {
      if (time.rollback) return { accepted: false, reason: 'clock_rollback' };
      if (!context.enabled) return { accepted: false, reason: 'disabled' };
      const previousEpoch = currentEpoch();
      if (previousEpoch !== null && request.epoch < previousEpoch) return { accepted: false, reason: 'stale_epoch' };
      advanceEpoch(request.epoch, time.at);
      expireReserved(time.at);
      const duplicate = db.prepare('SELECT * FROM autonomy_invitations WHERE request_id=?').get(request.requestId);
      if (duplicate) {
        if (duplicate.desk_id !== request.deskId || duplicate.epoch !== request.epoch ||
          duplicate.interest_id !== (request.interestId ?? null) || duplicate.duration_ms !== request.durationMs)
          return { accepted: false, reason: 'request_id_conflict' };
        if (duplicate.status === 'reserved' && duplicate.expires_at > time.at)
          return { accepted: true, leaseId: duplicate.lease_id, expiresAt: duplicate.expires_at, reason: 'reserved' };
        return { accepted: false, reason: duplicate.status === 'expired' ? 'lease_expired' : 'request_already_settled' };
      }
      if (db.prepare("SELECT lease_id FROM autonomy_invitations WHERE status='reserved' LIMIT 1").get())
        return { accepted: false, reason: 'invitation_in_flight' };
      const cooldown = db.prepare('SELECT cooldown_until FROM autonomy_desk_budgets WHERE desk_id=?').get(request.deskId)?.cooldown_until;
      if (cooldown !== undefined && time.at < cooldown) return { accepted: false, reason: 'no_response_cooldown' };
      const limited = context.profile.quietMode || context.profile.curiosity === 'minimal';
      const budgetLimit = limited ? policy.restrictedInvitationLimit : policy.invitationLimit;
      if (deliveredCount(request.deskId, time.at) >= budgetLimit) return { accepted: false, reason: 'invitation_budget_exhausted' };
      pruneInvitations(time.at, 1);
      if (db.prepare('SELECT COUNT(*) AS count FROM autonomy_invitations').get().count >= policy.maxInvitations)
        return { accepted: false, reason: 'invitation_storage_exhausted' };
      const leaseId = randomUUID();
      const expiresAt = time.at + request.durationMs;
      db.prepare(`INSERT INTO autonomy_invitations
        (lease_id,request_id,desk_id,epoch,interest_id,duration_ms,budget_limit,status,created_at,expires_at,updated_at,
        delivered_at,receipt_id,receipt_at,response_action,response_at)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?,?,NULL,NULL,NULL,NULL,NULL)`)
        .run(leaseId, request.requestId, request.deskId, request.epoch, request.interestId ?? null,
          request.durationMs, budgetLimit, time.at, expiresAt, time.at);
      pruneInvitations(time.at);
      return { accepted: true, leaseId, expiresAt, reason: 'reserved' };
    });
  }

  function settleInvitation(input) {
    if (closed) return { accepted: false, status: 'closed' };
    fields(input, ['leaseId', 'epoch', 'outcome', 'receipt'], 'invitation_settle');
    identifier(input.leaseId, 'lease_id');
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) return reject('invalid_epoch');
    if (!['delivered', 'rejected', 'aborted'].includes(input.outcome)) throw new TypeError('invalid_invitation_outcome');
    if (input.outcome === 'delivered') receiptValue(input.receipt);
    else if (input.receipt !== undefined) receiptValue(input.receipt);
    const time = tick();
    return transaction(() => {
      const lease = db.prepare('SELECT * FROM autonomy_invitations WHERE lease_id=?').get(input.leaseId);
      if (!lease) return reject('unknown_lease');
      if (currentEpoch() === null || input.epoch !== currentEpoch() || input.epoch !== lease.epoch) return reject('stale_epoch');
      if (lease.status === 'delivered') {
        if (input.outcome === 'delivered' && lease.receipt_id === input.receipt.id && lease.receipt_at === input.receipt.at)
          return { accepted: true, status: 'delivered' };
        return reject('already_delivered');
      }
      if (lease.status !== 'reserved') return reject(`lease_${lease.status}`);
      if (time.at >= lease.expires_at) {
        db.prepare("UPDATE autonomy_invitations SET status='expired',updated_at=? WHERE lease_id=?").run(time.at, lease.lease_id);
        return reject('lease_expired');
      }
      if (input.outcome !== 'delivered') {
        db.prepare('UPDATE autonomy_invitations SET status=?,updated_at=? WHERE lease_id=?').run(input.outcome, time.at, lease.lease_id);
        return { accepted: true, status: input.outcome };
      }
      if (time.rollback) return reject('clock_rollback');
      const receipt = input.receipt;
      if (receipt.at < lease.created_at || receipt.at > time.raw || receipt.at > lease.expires_at) return reject('invalid_receipt');
      const reused = db.prepare('SELECT lease_id FROM autonomy_invitations WHERE receipt_id=? AND lease_id<>?').get(receipt.id, lease.lease_id);
      if (reused) return reject('receipt_reused');
      if (deliveredCount(lease.desk_id, time.at) >= lease.budget_limit) {
        db.prepare("UPDATE autonomy_invitations SET status='budget_exhausted',updated_at=? WHERE lease_id=?").run(time.at, lease.lease_id);
        return reject('invitation_budget_exhausted');
      }
      db.prepare(`UPDATE autonomy_invitations SET status='delivered',delivered_at=?,receipt_id=?,receipt_at=?,updated_at=? WHERE lease_id=?`)
        .run(receipt.at, receipt.id, receipt.at, time.at, lease.lease_id);
      return { accepted: true, status: 'delivered' };
    });
  }

  function noteResponse(input) {
    if (closed) return { accepted: false, status: 'closed' };
    fields(input, ['leaseId', 'action'], 'response');
    identifier(input.leaseId, 'lease_id');
    if (!['noticed', 'declined', 'no_response_detected'].includes(input.action)) throw new TypeError('invalid_response_action');
    const time = tick();
    return transaction(() => {
      const lease = db.prepare('SELECT * FROM autonomy_invitations WHERE lease_id=?').get(input.leaseId);
      if (!lease) return reject('unknown_lease');
      if (lease.status !== 'delivered') return reject('not_delivered');
      if (lease.response_action === input.action) return { accepted: true, status: input.action };
      if (lease.response_action !== null) return reject('response_already_recorded');
      if (time.rollback) return reject('clock_rollback');
      let cooldownUntil = null;
      if (input.action === 'no_response_detected') {
        db.prepare('DELETE FROM autonomy_desk_budgets WHERE cooldown_until<=?').run(time.at);
        const previous = db.prepare('SELECT cooldown_until FROM autonomy_desk_budgets WHERE desk_id=?').get(lease.desk_id)?.cooldown_until;
        const count = db.prepare('SELECT COUNT(*) AS count FROM autonomy_desk_budgets').get().count;
        if (previous === undefined && count >= policy.maxDeskBudgets) return reject('budget_storage_exhausted');
        cooldownUntil = Math.max(previous ?? 0, time.at + policy.noResponseCooldownMs);
      }
      db.prepare('UPDATE autonomy_invitations SET response_action=?,response_at=?,updated_at=? WHERE lease_id=?')
        .run(input.action, time.at, time.at, lease.lease_id);
      if (cooldownUntil !== null) {
        db.prepare(`INSERT INTO autonomy_desk_budgets(desk_id,cooldown_until,updated_at) VALUES(?,?,?)
          ON CONFLICT(desk_id) DO UPDATE SET cooldown_until=excluded.cooldown_until,updated_at=excluded.updated_at`)
          .run(lease.desk_id, cooldownUntil, time.at);
      }
      return { accepted: true, status: input.action };
    });
  }

  function cancel(input) {
    if (closed) return;
    fields(input, ['epoch', 'reason'], 'cancel');
    integer(input.epoch, 0, Number.MAX_SAFE_INTEGER, 'epoch');
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 200) throw new TypeError('invalid_cancel_reason');
    const time = tick();
    transaction(() => {
      const current = currentEpoch();
      if (current === null || input.epoch < current) return;
      if (input.epoch > current) advanceEpoch(input.epoch, time.at);
      const claim = activeClaim();
      if (claim) recoverClaim(claim, time.at);
      db.prepare("UPDATE autonomy_invitations SET status='cancelled',updated_at=? WHERE status='reserved' AND epoch=?").run(time.at, input.epoch);
    });
  }

  function snapshot() {
    if (closed) return { closed: true };
    const time = tick();
    const inFlightRow = activeClaim();
    const inFlight = inFlightRow ? { id: inFlightRow.id, interestId: inFlightRow.interest_id,
      interestRevision: inFlightRow.revision, deskId: inFlightRow.desk_id, epoch: inFlightRow.epoch,
      basisObservationId: inFlightRow.basis_observation_id, createdAt: inFlightRow.created_at } : null;
    const interestStates = db.prepare('SELECT * FROM autonomy_interest_states ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(policy.snapshotLimit)
      .map(row => ({ interestId: row.interest_id, deskId: row.desk_id, revision: row.revision, nextAt: row.next_at,
        attempts: row.attempts, status: row.status, nextEligibleAt: row.next_eligible_at, updatedAt: row.updated_at }));
    const invitations = db.prepare('SELECT * FROM autonomy_invitations ORDER BY updated_at DESC,rowid DESC LIMIT ?').all(policy.snapshotLimit)
      .map(row => ({ leaseId: row.lease_id, requestId: row.request_id, deskId: row.desk_id, epoch: row.epoch,
        interestId: row.interest_id, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
        deliveredAt: row.delivered_at, receiptId: row.receipt_id, responseAction: row.response_action, responseAt: row.response_at }));
    const deliveredByDesk = db.prepare("SELECT desk_id,COUNT(*) AS count FROM autonomy_invitations WHERE status='delivered' AND delivered_at>? AND delivered_at<=? GROUP BY desk_id ORDER BY desk_id")
      .all(time.at - policy.invitationWindowMs, time.at).map(row => ({ deskId: row.desk_id, count: row.count, windowStartAt: time.at - policy.invitationWindowMs + 1 }));
    const cooldowns = db.prepare('SELECT desk_id,cooldown_until FROM autonomy_desk_budgets WHERE cooldown_until>? ORDER BY desk_id').all(time.at)
      .map(row => ({ deskId: row.desk_id, until: row.cooldown_until }));
    return { version: 1, at: time.at, inFlight,
      interestStateCount: db.prepare('SELECT COUNT(*) AS count FROM autonomy_interest_states').get().count,
      interestStates,
      invitationCount: db.prepare('SELECT COUNT(*) AS count FROM autonomy_invitations').get().count,
      invitations, deliveredByDesk, cooldowns };
  }

  return {
    poll, settle, reserveInvitation, settleInvitation, noteResponse, cancel, snapshot,
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
