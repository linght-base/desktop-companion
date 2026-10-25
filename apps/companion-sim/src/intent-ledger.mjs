// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const MAX_LIVE_PLANS = 50;
const MAX_STEPS = 8;
const MAX_REFS = 12;
const MAX_KEPT_REVISIONS = 64;
const MAX_LIST = 50;
const MAX_TIMESTAMP = 8640000000000000;
const LIVE_STATUSES = ['planned', 'active', 'waiting'];
const PLAN_STATUSES = [...LIVE_STATUSES, 'completed', 'cancelled', 'invalidated'];
const STEP_STATUSES = ['active', 'waiting', 'completed', 'cancelled'];
const EVIDENCE_KINDS = new Set(['perception', 'episode']);
const EVIDENCE_SOURCES = new Set(['camera', 'replay']);

function text(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function timestamp(value, name = 'at') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) throw new TypeError(`Invalid ${name}`);
  return value;
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}`);
  return value;
}
function member(value, options, name) {
  if (!options.includes(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
function exact(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${name}`);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`Invalid ${name}`);
  return value;
}
function contextOf(context) {
  exact(context, ['deskId', 'personaVersion'], 'context');
  return { deskId: text(context.deskId, 'deskId', 200), personaVersion: positiveInteger(context.personaVersion, 'personaVersion') };
}
function refs(value, name) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_REFS) throw new TypeError(`Invalid ${name}`);
  const seen = new Set();
  return value.map(ref => {
    exact(ref, ['id', 'revision'], name);
    const id = text(ref.id, `${name} id`, 200);
    if (seen.has(id)) throw new TypeError(`Duplicate ${name} id`);
    seen.add(id);
    return { id, revision: positiveInteger(ref.revision, `${name} revision`) };
  });
}
function steps(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_STEPS) throw new TypeError('Invalid steps');
  const seen = new Set();
  return value.map(step => {
    exact(step, ['id', 'aim'], 'step');
    const id = text(step.id, 'step id', 200);
    if (seen.has(id)) throw new TypeError('Duplicate step id');
    seen.add(id);
    return { id, aim: text(step.aim, 'step aim', 500) };
  });
}

/**
 * Persistent intention ledger for one Pi. Plans are intentions, never facts of done actions.
 * No model, timers, network, device or body calls; action authority stays with the host.
 */
export function createIntentLedger({ path, clock = Date.now, resolveEvidence } = {}) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new TypeError('Invalid clock');
  if (typeof resolveEvidence !== 'function') throw new TypeError('Invalid resolveEvidence');
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS intent_plans (
        id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL,
        status TEXT NOT NULL, desk_id TEXT NOT NULL, persona_version INTEGER NOT NULL,
        next_at INTEGER, payload TEXT NOT NULL, PRIMARY KEY(id, revision));
      CREATE TABLE IF NOT EXISTS intent_requests (
        request_id TEXT NOT NULL, desk_id TEXT NOT NULL, persona_version INTEGER NOT NULL,
        plan_id TEXT NOT NULL, PRIMARY KEY(request_id, desk_id, persona_version));`);
  } catch (error) { db.close(); throw error; }
  const now = () => timestamp(clock(), 'clock');
  function assertOpen() {
    if (closed) throw new TypeError('Intent ledger closed');
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const unpack = row => (row ? JSON.parse(row.payload) : null);
  function get(id) {
    return unpack(db.prepare('SELECT payload FROM intent_plans WHERE id=? ORDER BY revision DESC LIMIT 1').get(id));
  }
  function put(plan) {
    db.prepare('INSERT INTO intent_plans(id,revision,at,status,desk_id,persona_version,next_at,payload) VALUES(?,?,?,?,?,?,?,?)')
      .run(plan.id, plan.revision, plan.updatedAt, plan.status, plan.deskId, plan.personaVersion, plan.nextAt, JSON.stringify(plan));
    db.prepare('DELETE FROM intent_plans WHERE id=? AND revision<=?').run(plan.id, plan.revision - MAX_KEPT_REVISIONS);
    return plan;
  }
  // A reference is a basis only while the host still holds that exact revision as live,
  // same-desk, real-source perception/episode. Machine logs, synthetic or source-less
  // records never ground a plan.
  function evidenceCurrent(ref, deskId) {
    let record;
    try { record = resolveEvidence(ref.id, { deskId }); } catch { return false; }
    return !!record && typeof record === 'object' && !Array.isArray(record)
      && record.id === ref.id && record.revision === ref.revision
      && EVIDENCE_KINDS.has(record.kind) && record.status === 'active'
      && record.deskId === deskId && EVIDENCE_SOURCES.has(record.source);
  }
  function staleRef(plan) {
    const all = [...(plan.evidenceRefs ?? []), ...(plan.steps ?? []).flatMap(step => step.resultEvidenceRefs ?? [])];
    return all.find(ref => !evidenceCurrent(ref, plan.deskId)) ?? null;
  }
  function invalidate(plan, ref) {
    return put({ ...plan, revision: plan.revision + 1, status: 'invalidated', nextAt:null, updatedAt: now(), reason: `evidence_not_current:${ref.id}` });
  }
  const LATEST = 'm.revision=(SELECT MAX(revision) FROM intent_plans WHERE id=m.id)';

  function propose(input, context) {
    assertOpen();
    const { deskId, personaVersion } = contextOf(context);
    exact(input, ['requestId', 'goal', 'evidenceRefs', 'steps', 'nextAt'], 'propose input');
    const requestId = text(input.requestId, 'requestId', 200);
    const goal = text(input.goal, 'goal', 1000);
    const evidenceRefs = refs(input.evidenceRefs, 'evidenceRefs');
    const stepList = steps(input.steps);
    const nextAt = input.nextAt === undefined ? null : timestamp(input.nextAt, 'nextAt');
    const reject = reason => ({ id: null, requestId, status: 'rejected', reason, deskId, personaVersion });
    return transaction(() => {
      const prior = db.prepare('SELECT plan_id FROM intent_requests WHERE request_id=? AND desk_id=? AND persona_version=?').get(requestId, deskId, personaVersion);
      if (prior) {
        const plan = get(prior.plan_id);
        if (plan) return { ...structuredClone(plan), duplicate: true };
        db.prepare('DELETE FROM intent_requests WHERE plan_id=?').run(prior.plan_id);
      }
      const stale = evidenceRefs.find(ref => !evidenceCurrent(ref, deskId));
      if (stale) return reject(`evidence_not_current:${stale.id}`);
      const live = db.prepare(`SELECT COUNT(*) AS n FROM intent_plans m WHERE ${LATEST} AND desk_id=? AND persona_version=? AND status IN ('planned','active','waiting')`).get(deskId, personaVersion).n;
      if (live >= MAX_LIVE_PLANS) return reject('live_plan_limit');
      const at = now();
      const plan = {
        id: randomUUID(), revision: 1, status: 'planned', deskId, personaVersion, requestId, goal,
        evidenceRefs, steps: stepList.map(step => ({ ...step, status: 'pending' })),
        nextAt, createdAt: at, updatedAt: at,
      };
      put(plan);
      db.prepare('INSERT INTO intent_requests(request_id,desk_id,persona_version,plan_id) VALUES(?,?,?,?)').run(requestId, deskId, personaVersion, plan.id);
      return structuredClone(plan);
    });
  }

  function list(input = {}) {
    assertOpen();
    exact(input, ['deskId', 'personaVersion', 'status', 'limit'], 'list input');
    const deskId = text(input.deskId, 'deskId', 200);
    const personaVersion = positiveInteger(input.personaVersion, 'personaVersion');
    const status = input.status === undefined ? null : member(input.status, PLAN_STATUSES, 'status');
    const limit = Math.min(input.limit === undefined ? 20 : positiveInteger(input.limit, 'limit'), MAX_LIST);
    return transaction(() => {
      const rows = db.prepare(`SELECT payload FROM intent_plans m WHERE ${LATEST} AND desk_id=? AND persona_version=?`).all(deskId, personaVersion);
      const plans = [];
      for (const row of rows) {
        let plan = unpack(row);
        if (!plan || plan.status === 'deleted') continue;
        // Re-verify basis revisions at query time: a corrected or retracted source
        // invalidates the plan instead of silently re-grounding it.
        if (LIVE_STATUSES.includes(plan.status)) {
          const stale = staleRef(plan);
          if (stale) plan = invalidate(plan, stale);
        }
        if (status && plan.status !== status) continue;
        plans.push(plan);
      }
      plans.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
      return plans.slice(0, limit).map(plan => structuredClone(plan));
    });
  }

  function advance(input, context) {
    assertOpen();
    const { deskId, personaVersion } = contextOf(context);
    exact(input, ['id', 'revision', 'stepId', 'status', 'nextAt', 'resultEvidenceRefs'], 'advance input');
    const id = text(input.id, 'id', 200);
    const revision = positiveInteger(input.revision, 'revision');
    const stepId = text(input.stepId, 'stepId', 200);
    const status = member(input.status, STEP_STATUSES, 'status');
    const nextAt = input.nextAt === undefined ? undefined : timestamp(input.nextAt, 'nextAt');
    const resultRefs = input.resultEvidenceRefs === undefined ? undefined : refs(input.resultEvidenceRefs, 'resultEvidenceRefs');
    const reject = (reason, current = null) => ({ id, status: 'rejected', reason, revision: current });
    return transaction(() => {
      const plan = get(id);
      if (!plan || plan.status === 'deleted') return reject('unknown_plan');
      if (plan.deskId !== deskId || plan.personaVersion !== personaVersion) return reject('scope_mismatch', plan.revision);
      if (plan.status === 'cancelled' || plan.status === 'completed') return reject('plan_terminal', plan.revision);
      if (plan.status === 'invalidated') return reject('plan_invalidated', plan.revision);
      if (plan.revision !== revision) return reject('revision_mismatch', plan.revision);
      const stale = staleRef(plan);
      if (stale) {
        invalidate(plan, stale);
        return reject('plan_invalidated', plan.revision + 1);
      }
      const index = plan.steps.findIndex(step => step.id === stepId);
      if (index < 0) return reject('unknown_step', plan.revision);
      if (plan.steps[index].status === 'completed' || plan.steps[index].status === 'cancelled') return reject('step_terminal', plan.revision);
      if (plan.steps.slice(0, index).some(step => step.status !== 'completed')) return reject('step_order', plan.revision);
      if (resultRefs) {
        const staleResult = resultRefs.find(ref => !evidenceCurrent(ref, deskId));
        if (staleResult) return reject(`result_evidence_not_current:${staleResult.id}`, plan.revision);
      }
      const at = now();
      const nextSteps = plan.steps.map(step => ({ ...step }));
      const target = nextSteps[index];
      target.status = status;
      target.updatedAt = at;
      if (nextAt !== undefined) target.nextAt = nextAt;
      // Step completion records only that the Pi closed this step's intent; it is not
      // user completion, body execution, or a real-world result.
      if (status === 'completed') {
        target.completedAt = at;
        if (resultRefs) target.resultEvidenceRefs = resultRefs;
      }
      let next;
      if (status === 'cancelled') {
        for (const step of nextSteps) if (step.status !== 'completed') step.status = 'cancelled';
        next = { ...plan, steps: nextSteps, status: 'cancelled', nextAt: null, reason: `step_cancelled:${stepId}` };
      } else {
        const currentStep = nextSteps.find(step => step.status !== 'completed');
        next = {
          ...plan, steps: nextSteps,
          status: currentStep ? { pending: 'planned', active: 'active', waiting: 'waiting' }[currentStep.status] : 'completed',
          nextAt: currentStep ? (nextAt !== undefined ? nextAt : plan.nextAt) : null,
        };
      }
      next.revision = plan.revision + 1;
      next.updatedAt = at;
      return structuredClone(put(next));
    });
  }

  function reconcileEvidence() {
    assertOpen();
    return transaction(() => {
      const rows = db.prepare(`SELECT payload FROM intent_plans m WHERE ${LATEST} AND status IN ('planned','active','waiting')`).all();
      const invalidated = [];
      for (const row of rows) {
        const plan = unpack(row);
        if (!plan) continue;
        const stale = staleRef(plan);
        if (stale) {
          invalidate(plan, stale);
          invalidated.push(plan.id);
        }
      }
      return { checked: rows.length, invalidated };
    });
  }

  function forgetEvidence(id) {
    assertOpen();
    id = text(id, 'id', 200);
    return transaction(() => {
      const referencing = new Set();
      for (const row of db.prepare('SELECT id, payload FROM intent_plans').all()) {
        if (referencing.has(row.id)) continue;
        const plan = unpack(row);
        if (!plan || plan.status === 'deleted') continue;
        if ((plan.evidenceRefs ?? []).some(ref => ref.id === id)
          || (plan.steps ?? []).some(step => (step.resultEvidenceRefs ?? []).some(ref => ref.id === id))) referencing.add(row.id);
      }
      const forgotten = [];
      for (const planId of referencing) {
        const plan = get(planId);
        if (!plan) continue;
        // Secure delete: physically erase every revision carrying goal/aim/ref text and
        // the idempotency index, leaving only a bounded tombstone without body text.
        db.prepare('DELETE FROM intent_plans WHERE id=?').run(planId);
        db.prepare('DELETE FROM intent_requests WHERE plan_id=?').run(planId);
        const at = now();
        db.prepare('INSERT INTO intent_plans(id,revision,at,status,desk_id,persona_version,next_at,payload) VALUES(?,?,?,?,?,?,?,?)')
          .run(planId, 1, at, 'deleted', plan.deskId, plan.personaVersion, null, JSON.stringify({
            id: planId, status: 'deleted', deskId: plan.deskId, personaVersion: plan.personaVersion, deletedAt: at, reason: 'evidence_forgotten',
          }));
        forgotten.push(planId);
      }
      return { evidenceId: id, forgotten };
    });
  }

  function snapshot(input = {}) {
    return {
      deskId: text(input.deskId, 'deskId', 200),
      personaVersion: positiveInteger(input.personaVersion, 'personaVersion'),
      plans: list(input),
      generatedAt: now(),
    };
  }

  return {
    propose, list, advance, reconcileEvidence, forgetEvidence, snapshot,
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
