// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Pure-data expression playback adapter on top of the expression library. It converts an activated
// recipe into a bounded ExpressionIntent (eyes/icon/gesture only — NEVER head) and, after a real
// accepted body receipt, yields one frame per host tick by re-calling library.sample. There are no
// timers, no rendering loop, no model/network/DOM access and no body/head operations: the host tick
// drives everything. Old wake-up learning evidence is NOT motion authority — every prepare/commit/
// tick re-runs the library's live gates (session, evidence, capability, revision) plus the host's
// private isCurrent() closure, and a stopped playback can never be revived or extended.
import { randomUUID } from 'node:crypto';

export const PLAYBACK_LIMITS = Object.freeze({ proposalTtlMs: 5000 });
const RECEIPT_STATUSES = new Set(['accepted', 'rejected', 'completed', 'cancelled']);
const text = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`invalid_${name}`);
  return value.trim();
};

/** createExpressionPlayback({library, clock}) — RAM-only state (one pending proposal, one active
 *  playback); close() clears it and never closes the external library. */
export function createExpressionPlayback({ library, clock = Date.now } = {}) {
  if (!library || typeof library !== 'object' || typeof library.get !== 'function' || typeof library.sample !== 'function') throw new Error('invalid_library');
  if (typeof clock !== 'function') throw new Error('invalid_clock');
  let closed = false;
  let pending = null; // {proposalId,recipeId,sessionId,basisObservationId,epoch,deskId,isCurrent,preparedAt,expiresAt,durationMs}
  let active = null;  // {playbackId,receiptId,recipeId,sessionId,epoch,deskId,isCurrent,startedAt,deadlineAt}

  const now = () => {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8.64e15) throw new Error('invalid_clock_value');
    return at;
  };
  const guard = () => { if (closed) throw new Error('playback_closed'); };
  const stopActive = reason => {
    if (!active) return null;
    const event = { kind: 'stop', receiptId: active.receiptId, reason };
    active = null;
    return event;
  };

  /** Pending proposal only — this claims nothing about playback having started. Re-checks the
   *  library gates (session/resource/evidence) and the host-private isCurrent() closure, samples
   *  frame 0 and returns a bounded intent the existing body.apply can consume (no head). */
  function prepare(request, context = {}) {
    guard();
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid_prepare_request');
    if (Object.keys(request).some(key => !['recipeId', 'sessionId', 'basisObservationId'].includes(key))) throw new Error('invalid_prepare_field');
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('invalid_prepare_context');
    if (Object.keys(context).some(key => !['epoch', 'deskId', 'isCurrent'].includes(key))) throw new Error('invalid_prepare_context_field');
    const recipeId = text(request.recipeId, 'recipe_id');
    const sessionId = text(request.sessionId, 'session_id');
    const basisObservationId = text(request.basisObservationId, 'basis_observation_id');
    if (!Number.isSafeInteger(context.epoch) || context.epoch < 0) throw new Error('invalid_epoch');
    const deskId = text(context.deskId, 'desk_id');
    if (typeof context.isCurrent !== 'function') throw new Error('invalid_isCurrent'); // host-private closure, never model input

    const loaded = library.get({ id: recipeId, sessionId });
    if (!loaded.ok) return { accepted: false, reason: `library_${loaded.reason}`, ...(loaded.detail ? { detail: loaded.detail } : {}) };
    if (loaded.deskId !== deskId) return { accepted: false, reason: 'resource_desk_mismatch' };
    const firstFrame = library.sample({ id: recipeId, sessionId, elapsedMs: 0 });
    if (!firstFrame.ok) return { accepted: false, reason: `library_${firstFrame.reason}`, ...(firstFrame.detail ? { detail: firstFrame.detail } : {}) };
    if (!context.isCurrent()) return { accepted: false, reason: 'basis_not_current' };

    const at = now();
    const proposalId = `proposal-${randomUUID()}`;
    pending = {
      proposalId, recipeId, sessionId, basisObservationId,
      epoch: context.epoch, deskId, isCurrent: context.isCurrent,
      preparedAt: at, expiresAt: at + PLAYBACK_LIMITS.proposalTtlMs, durationMs: loaded.recipe.durationMs,
    };
    const intent = {
      basisObservationId, durationMs: loaded.recipe.durationMs,
      ...(firstFrame.eyes === undefined ? {} : { eyes: structuredClone(firstFrame.eyes) }),
      ...(firstFrame.icon === undefined ? {} : { icon: firstFrame.icon }),
      ...(firstFrame.gesture === undefined ? {} : { gesture: firstFrame.gesture }),
    };
    return { accepted: true, proposalId, intent, expiresAt: pending.expiresAt };
  }

  /** Only an unexpired, still-current proposal with a real accepted body receipt becomes active.
   *  Rejected/cancelled receipts settle the proposal without playing; late or stale proposals
   *  cannot activate; arbitrary model input is never a receipt (strict shape, ids only). */
  function commit({ proposalId, receipt } = {}) {
    guard();
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || typeof receipt.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(receipt.id)
      || !RECEIPT_STATUSES.has(receipt.status)) return { accepted: false, reason: 'invalid_receipt' };
    if (!pending || pending.proposalId !== proposalId) return { accepted: false, reason: 'unknown_proposal' };
    const settle = reason => { pending = null; return { accepted: false, reason }; };
    const at = now();
    if (at >= pending.expiresAt) return settle('proposal_expired');
    if (receipt.status !== 'accepted') return settle('receipt_not_accepted');
    if (receipt.basisObservationId !== undefined && receipt.basisObservationId !== pending.basisObservationId) return settle('receipt_basis_mismatch');
    if (!Number.isSafeInteger(receipt.at) || receipt.at < 0 || receipt.at > 8.64e15
      || receipt.at < pending.preparedAt || receipt.at > at) return settle('invalid_receipt_at');
    const deadlineAt = receipt.at + pending.durationMs;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt > 8.64e15) return settle('invalid_receipt_at');
    if (at >= deadlineAt) return settle('receipt_expired');
    if (!pending.isCurrent()) return settle('basis_not_current');
    const recheck = library.get({ id: pending.recipeId, sessionId: pending.sessionId });
    if (!recheck.ok) return settle(`library_${recheck.reason}`);
    if (recheck.deskId !== pending.deskId) return settle('resource_desk_mismatch');
    active = {
      playbackId: `playback-${randomUUID()}`, receiptId: receipt.id,
      recipeId: pending.recipeId, sessionId: pending.sessionId,
      epoch: pending.epoch, deskId: pending.deskId, isCurrent: pending.isCurrent,
      startedAt: receipt.at, deadlineAt, // body receipt anchors the original deadline — never extended
    };
    pending = null; // a newly accepted body receipt supersedes any earlier active playback
    return { accepted: true, playbackId: active.playbackId };
  }

  /** One frame per host tick, or a terminal stop event. Re-verifies everything on every call:
   *  enabled/epoch/desk, that the body's current expression command is still OUR accepted receipt
   *  (a later reminder or user expression supersedes us permanently), isCurrent(), and the
   *  library's live sample gates. The original deadline cannot be extended or restarted. */
  function tick(input = {}) {
    guard();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_tick');
    if (Object.keys(input).some(key => !['enabled', 'epoch', 'deskId', 'expressionCommandId'].includes(key))) throw new Error('invalid_tick_field');
    if (typeof input.enabled !== 'boolean') throw new Error('invalid_enabled');
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) throw new Error('invalid_epoch');
    const deskId = text(input.deskId, 'desk_id');
    if (!(input.expressionCommandId === null || typeof input.expressionCommandId === 'string')) throw new Error('invalid_expressionCommandId');
    if (!active) return null;
    if (!input.enabled) return stopActive('disabled');
    if (input.epoch !== active.epoch) return stopActive('epoch_changed');
    if (input.deskId !== active.deskId) return stopActive('desk_changed');
    if (input.expressionCommandId !== active.receiptId) return stopActive('superseded');
    if (!active.isCurrent()) return stopActive('basis_stale');
    const at = now();
    if (at >= active.deadlineAt) return stopActive('finished');
    const sampled = library.sample({ id: active.recipeId, sessionId: active.sessionId, elapsedMs: at - active.startedAt });
    if (!sampled.ok) return stopActive(`library_${sampled.reason}${sampled.detail ? `:${sampled.detail}` : ''}`);
    return {
      kind: 'frame', receiptId: active.receiptId,
      frame: {
        ...(sampled.eyes === undefined ? {} : { eyes: sampled.eyes }),
        ...(sampled.icon === undefined ? {} : { icon: sampled.icon }),
        ...(sampled.gesture === undefined ? {} : { gesture: sampled.gesture }),
      },
    };
  }

  /** Withdraws only this adapter's expression receipt — never head state. Clears pending + active. */
  function stop(reason = 'stopped') {
    guard();
    const safeReason = typeof reason === 'string' && reason.trim() && reason.length <= 100 ? reason.trim() : 'stopped';
    pending = null;
    return stopActive(safeReason);
  }

  /** Bounded metadata only — no meaning/recipe/personal content is copied out of the library. */
  function snapshot() {
    guard();
    return {
      version: 1, at: now(), semanticPolicy: 'structural_check_only', limits: PLAYBACK_LIMITS,
      pending: pending ? { proposalId: pending.proposalId, recipeId: pending.recipeId, sessionId: pending.sessionId, expiresAt: pending.expiresAt, semanticStatus: 'unverified' } : null,
      active: active ? {
        playbackId: active.playbackId, receiptId: active.receiptId, recipeId: active.recipeId,
        sessionId: active.sessionId, epoch: active.epoch, deskId: active.deskId,
        startedAt: active.startedAt, deadlineAt: active.deadlineAt, semanticStatus: 'unverified',
      } : null,
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    pending = null;
    active = null;
  }

  return { prepare, commit, tick, stop, snapshot, close };
}
