// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAutonomyCoordinator } from './index.mjs';

const ACTIVE_INTEREST_STATUSES = new Set(['active', 'paused', 'resolved', 'dismissed', 'invalidated']);

function deskValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || value.includes('\0')) {
    throw new TypeError('invalid_desk_id');
  }
  return value.trim();
}

function hostEpochValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid_epoch');
  return value;
}

function projectProfile(profile, deskId) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError('invalid_profile');
  return {
    deskId: deskValue(profile.deskId ?? deskId),
    quietMode: profile.quietMode,
    curiosity: profile.curiosity,
    version: profile.version,
  };
}

function projectObservation(observation) {
  if (observation === null || observation === undefined) return null;
  if (typeof observation !== 'object' || Array.isArray(observation)) throw new TypeError('invalid_observation');
  return {
    id: observation.id,
    at: observation.at,
    source: observation.source,
    coverage: observation.coverage,
  };
}

function validEvidence(record, id, revision, deskId) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    record.id === id && record.revision === revision && record.status === 'active' && record.deskId === deskId;
}

/**
 * Projects host-owned records into the reference-only scheduler. This module
 * never reads continuity/reminder tables and never persists callback results.
 */
export function createAutonomyHostAdapter({ path, clock = Date.now, policy = {}, resolveEvidence } = {}) {
  if (typeof resolveEvidence !== 'function') throw new TypeError('invalid_evidence_resolver');
  const coordinator = createAutonomyCoordinator({ path, clock, policy });
  const db = new DatabaseSync(path);
  const processId = randomUUID();
  const maxInterests = policy.maxInterests ?? 64;
  const claimTokens = new Map();
  let closed = false;
  let currentHostEpoch = null;
  let currentInternalEpoch = null;

  try {
    db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS autonomy_host_epochs(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),process_id TEXT NOT NULL,
        host_epoch INTEGER NOT NULL,internal_epoch INTEGER NOT NULL);`);
  } catch (error) {
    db.close();
    coordinator.close();
    throw error;
  }

  function mapEpoch(value) {
    const hostEpoch = hostEpochValue(value);
    if (currentHostEpoch !== null && hostEpoch < currentHostEpoch) return null;
    const stored = db.prepare('SELECT * FROM autonomy_host_epochs WHERE singleton=1').get();
    if (currentHostEpoch !== null && stored?.process_id !== processId) return null;
    let internalEpoch;
    if (currentInternalEpoch !== null && hostEpoch === currentHostEpoch) {
      internalEpoch = currentInternalEpoch;
    } else if (!stored) {
      internalEpoch = 0;
    } else {
      if (stored.internal_epoch >= Number.MAX_SAFE_INTEGER) throw new Error('host_epoch_storage_exhausted');
      internalEpoch = stored.internal_epoch + 1;
    }
    if (!stored) {
      db.prepare('INSERT INTO autonomy_host_epochs(singleton,process_id,host_epoch,internal_epoch) VALUES(1,?,?,?)')
        .run(processId, hostEpoch, internalEpoch);
    } else if (stored.process_id !== processId || stored.host_epoch !== hostEpoch || stored.internal_epoch !== internalEpoch) {
      db.prepare('UPDATE autonomy_host_epochs SET process_id=?,host_epoch=?,internal_epoch=? WHERE singleton=1')
        .run(processId, hostEpoch, internalEpoch);
    }
    if (currentInternalEpoch !== internalEpoch) claimTokens.clear();
    currentHostEpoch = hostEpoch;
    currentInternalEpoch = internalEpoch;
    return internalEpoch;
  }

  function projectInterest(input) {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIVE_INTEREST_STATUSES.has(input.status)) return null;
      if (!Array.isArray(input.evidenceIds) || input.evidenceIds.length < 1 || input.evidenceIds.length > 32) return null;
      if (!input.evidenceRevisions || typeof input.evidenceRevisions !== 'object' || Array.isArray(input.evidenceRevisions)) return null;
      const deskId = deskValue(input.deskId);
      const evidenceIds = [...input.evidenceIds];
      const evidenceRevisions = {};
      for (const id of evidenceIds) {
        const revision = input.evidenceRevisions[id];
        let record;
        try { record = resolveEvidence(id, { deskId }); } catch { return null; }
        if (!validEvidence(record, id, revision, deskId)) return null;
        evidenceRevisions[id] = revision;
      }
      return {
        id: input.id,
        kind: input.kind,
        deskId,
        status: input.status,
        revision: input.revision,
        nextAt: input.nextAt,
        evidenceIds,
        evidenceRevisions,
        source: input.source,
      };
    } catch {
      return null;
    }
  }

  function poll(input) {
    if (closed) return { events: [], reason: 'closed' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_poll');
    if (Array.isArray(input.interests) && input.interests.length > maxInterests) return { events: [], reason: 'interest_budget_exceeded' };
    const deskId = deskValue(input.deskId);
    const epoch = mapEpoch(input.epoch);
    if (epoch === null) return { events: [], reason: 'stale_epoch' };
    const result = coordinator.poll({
      enabled: input.enabled,
      epoch,
      deskId,
      mode: input.mode,
      profile: projectProfile(input.profile, deskId),
      observation: projectObservation(input.observation),
      interests: Array.isArray(input.interests) ? input.interests.map(projectInterest).filter(Boolean) : input.interests,
      inferenceBusy: input.inferenceBusy,
      allowReplay: input.allowReplay === true,
    });
    const events = result.events.map(event => {
      const { claimToken, ...publicEvent } = event;
      if (claimToken !== undefined) claimTokens.set(event.id, claimToken);
      return publicEvent;
    });
    if (events.length) {
      const currentIds = new Set(events.map(event => event.id));
      for (const id of claimTokens.keys()) if (!currentIds.has(id)) claimTokens.delete(id);
    } else if (result.reason !== 'claim_in_flight') {
      claimTokens.clear();
    }
    return { ...result, events };
  }

  function settle(input) {
    if (closed) return { accepted: false, status: 'closed' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_settle');
    const claimToken = input.claimToken ?? claimTokens.get(input.id);
    if (claimToken === undefined) return { accepted: false, status: 'claim_not_active' };
    const result = coordinator.settle({ id: input.id, claimToken, outcome: input.outcome });
    if (result.accepted || result.status === 'unknown_claim') claimTokens.delete(input.id);
    return result;
  }

  function reserveInvitation(request, context) {
    if (closed) return { accepted: false, reason: 'closed' };
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('invalid_invitation');
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('invalid_invitation_context');
    const deskId = deskValue(request.deskId);
    const epoch = mapEpoch(request.epoch);
    if (epoch === null) return { accepted: false, reason: 'stale_epoch' };
    return coordinator.reserveInvitation({
      requestId: request.requestId,
      deskId,
      epoch,
      interestId: request.interestId,
      durationMs: request.durationMs,
    }, { enabled: context.enabled, profile: projectProfile(context.profile, deskId) });
  }

  function projectReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new TypeError('invalid_receipt');
    return { id: receipt.id, status: receipt.status, at: receipt.at };
  }

  function settleInvitation(input) {
    if (closed) return { accepted: false, status: 'closed' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_invitation_settle');
    if (input.outcome === 'delivered' && input.receipt?.status !== 'accepted') {
      return { accepted: false, status: 'invalid_receipt_status' };
    }
    const epoch = mapEpoch(input.epoch);
    if (epoch === null) return { accepted: false, status: 'stale_epoch' };
    return coordinator.settleInvitation({
      leaseId: input.leaseId,
      epoch,
      outcome: input.outcome,
      ...(input.receipt === undefined ? {} : { receipt: projectReceipt(input.receipt) }),
    });
  }

  function noteResponse(input) {
    if (closed) return { accepted: false, status: 'closed' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_response');
    return coordinator.noteResponse({ leaseId: input.leaseId, action: input.action });
  }

  function cancel(input) {
    if (closed) return;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_cancel');
    const epoch = mapEpoch(input.epoch);
    if (epoch === null) return;
    coordinator.cancel({ epoch, reason: input.reason });
    claimTokens.clear();
  }

  function snapshot() {
    if (closed) return { closed: true };
    const value = coordinator.snapshot();
    const externalEpoch = internalEpoch => internalEpoch === currentInternalEpoch ? currentHostEpoch : null;
    return {
      ...value,
      inFlight: value.inFlight ? { ...value.inFlight, epoch: externalEpoch(value.inFlight.epoch) } : null,
      invitations: value.invitations.map(invitation => ({ ...invitation, epoch: externalEpoch(invitation.epoch) })),
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    claimTokens.clear();
    try { coordinator.close(); } finally { db.close(); }
  }

  return { poll, settle, reserveInvitation, settleInvitation, noteResponse, cancel, snapshot, close };
}
