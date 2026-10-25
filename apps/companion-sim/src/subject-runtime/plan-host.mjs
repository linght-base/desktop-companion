// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const LIVE_STATUSES = new Set(['planned', 'active', 'waiting']);
const EVIDENCE_KINDS = new Set(['perception', 'episode']);
const EVIDENCE_SOURCES = new Set(['camera', 'replay']);
const MAX_INTERESTS = 50;
const MAX_INTEREST_EVIDENCE = 32;
const MAX_TIMESTAMP = 8640000000000000;

function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}`);
  return value;
}
function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
function hostContext(context) {
  plainObject(context, 'context');
  return { deskId: text(context.deskId, 'deskId'), personaVersion: positiveInteger(context.personaVersion, 'personaVersion') };
}
// The host owns desk/persona scope; model-supplied copies are dropped, never trusted.
function stripScope(input, name) {
  plainObject(input, name);
  const copy = { ...input };
  delete copy.deskId;
  delete copy.personaVersion;
  return copy;
}

/**
 * Projects the host-injected intent ledger into plan proposals and autonomy
 * interests. Intent status is never a fact of body execution or user
 * completion; action authority and scheduling decisions stay with the host.
 */
export function createPlanHostAdapter({ ledger, resolveEvidence, clock = Date.now } = {}) {
  plainObject(ledger, 'ledger');
  for (const method of ['propose', 'advance', 'list', 'forgetEvidence']) {
    if (typeof ledger[method] !== 'function') throw new TypeError(`Invalid ledger ${method}`);
  }
  if (typeof resolveEvidence !== 'function') throw new TypeError('Invalid resolveEvidence');
  if (typeof clock !== 'function') throw new TypeError('Invalid clock');
  let closed = false;
  function assertOpen() {
    if (closed) throw new TypeError('Plan host adapter closed');
  }
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) throw new TypeError('Invalid clock');
    return value;
  }
  function resolveCurrent(ref, deskId) {
    let record;
    try { record = resolveEvidence(ref.id, { deskId }); } catch { return null; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.id !== ref.id || record.revision !== ref.revision) return null;
    if (!EVIDENCE_KINDS.has(record.kind) || record.status !== 'active') return null;
    if (record.deskId !== deskId || !EVIDENCE_SOURCES.has(record.source)) return null;
    return record;
  }
  function basisRefs(plan) {
    const seen = new Set();
    const all = [];
    for (const ref of [...(plan.evidenceRefs ?? []), ...(plan.steps ?? []).flatMap(step => step.resultEvidenceRefs ?? [])]) {
      if (!ref || typeof ref.id !== 'string' || seen.has(ref.id)) continue;
      seen.add(ref.id);
      all.push(ref);
    }
    return all;
  }

  function propose(input, context) {
    assertOpen();
    return ledger.propose(stripScope(input, 'propose input'), hostContext(context));
  }

  function advance(input, context) {
    assertOpen();
    return ledger.advance(stripScope(input, 'advance input'), hostContext(context));
  }

  function list(query = {}, context) {
    assertOpen();
    const { deskId, personaVersion } = hostContext(context);
    return ledger.list({ ...stripScope(query, 'list query'), deskId, personaVersion });
  }

  function livePlans(deskId,personaVersion){
    return [...LIVE_STATUSES].flatMap(status=>ledger.list({deskId,personaVersion,status,limit:MAX_INTERESTS})).sort((a,b)=>(a.nextAt??Infinity)-(b.nextAt??Infinity)||b.updatedAt-a.updatedAt).slice(0,MAX_INTERESTS);
  }

  function interests(context) {
    assertOpen();
    const { deskId, personaVersion } = hostContext(context);
    const plans = livePlans(deskId,personaVersion);
    const records = [];
    for (const plan of plans) {
      if (records.length >= MAX_INTERESTS) break;
      if (!LIVE_STATUSES.has(plan.status)) continue;
      if (!Number.isSafeInteger(plan.nextAt) || plan.nextAt < 0 || plan.nextAt > MAX_TIMESTAMP) continue;
      const refs = basisRefs(plan);
      if (!refs.length || refs.length > MAX_INTEREST_EVIDENCE) continue;
      const evidenceIds = [];
      const evidenceRevisions = {};
      const sources = new Set();
      let current = true;
      for (const ref of refs) {
        const record = resolveCurrent(ref, deskId);
        if (!record) { current = false; break; }
        evidenceIds.push(ref.id);
        evidenceRevisions[ref.id] = ref.revision;
        sources.add(record.source);
      }
      if (!current) continue;
      records.push({
        id: plan.id, kind: 'interest', status: 'active', revision: plan.revision, deskId,
        nextAt: plan.nextAt, evidenceIds, evidenceRevisions,
        source: sources.has('replay') ? 'replay' : 'camera',
      });
    }
    return records;
  }

  function resolveEvent(event, context) {
    assertOpen();
    const { deskId, personaVersion } = hostContext(context);
    plainObject(event, 'event');
    if (event.kind !== 'interest') return null;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    if (typeof payload.interestId !== 'string' || !Number.isSafeInteger(payload.interestRevision)) return null;
    if (payload.deskId !== deskId) return null;
    const plan = livePlans(deskId,personaVersion).find(candidate => candidate.id === payload.interestId);
    if (!plan || plan.revision !== payload.interestRevision) return null;
    if (!LIVE_STATUSES.has(plan.status)) return null;
    return plan;
  }

  function forgetEvidence(id) {
    assertOpen();
    return ledger.forgetEvidence(text(id, 'id'));
  }

  function snapshot(context) {
    assertOpen();
    const { deskId, personaVersion } = hostContext(context);
    const plans = ledger.list({ deskId, personaVersion, limit: MAX_INTERESTS });
    const counts = {};
    return {
      deskId,
      personaVersion,
      generatedAt: now(),
      plans: plans.map(plan => {
        counts[plan.status] = (counts[plan.status] ?? 0) + 1;
        return {
          id: plan.id,
          revision: plan.revision,
          status: plan.status,
          nextAt: plan.nextAt ?? null,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          steps: (plan.steps ?? []).map(step => ({ id: step.id, status: step.status })),
          evidenceIds: basisRefs(plan).map(ref => ref.id),
        };
      }),
      counts,
    };
  }

  function close() {
    closed = true;
  }

  return { propose, advance, list, interests, resolveEvent, forgetEvidence, snapshot, close };
}
