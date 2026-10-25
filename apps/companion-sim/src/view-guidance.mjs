// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { fields, identifier, OBSERVATION_MAX_AGE } from './contracts.mjs';

const QUALITIES = new Set(['adequate', 'limited', 'blocked', 'unknown']);
const GLYPHS = new Set(['left', 'right', 'up', 'down', 'nearer', 'farther']);
const WINDOW_MS = 600_000, CUE_MS = 8_000, LIMIT = 3, DESK_LIMIT = 64;

/** One Pi supplies the assessment; this host gate owns finite placement cues. */
export function createViewGuidance({clock = Date.now} = {}) {
  let closed = false, scope = null, current = null, prior = null, cue = null;
  let stoppedReason = 'not_assessed';
  const desks = new Map();

  function now() {
    const value = clock();
    if (!Number.isFinite(value) || value < 0) throw new Error('invalid_clock');
    return value;
  }
  function validContext(context, at, basis) {
    if (closed || context?.enabled !== true) return 'disabled';
    if (!Number.isSafeInteger(context.epoch) || context.epoch < 0) return 'invalid_epoch';
    if (typeof context.deskId !== 'string' || !context.deskId.trim() || context.deskId.length > 200) return 'invalid_desk';
    const observation = context.observation;
    if (!observation || observation.source !== 'camera') return 'real_observation_required';
    if (observation.deskId !== undefined && observation.deskId !== context.deskId) return 'desk_mismatch';
    if (basis !== undefined && observation.id !== basis) return 'observation_mismatch';
    if (!Number.isFinite(observation.at) || observation.at > at + 1000 || at - observation.at > OBSERVATION_MAX_AGE) return 'stale_observation';
    if (typeof context.isCurrent !== 'function') return 'current_authority_required';
    try { if (context.isCurrent() !== true) return 'observation_not_current'; }
    catch { return 'observation_not_current'; }
    return null;
  }
  function clear(reason) {
    cue = null; current = null; prior = null; stoppedReason = reason;
  }
  function bind(context) {
    if (!scope || scope.epoch !== context.epoch || scope.deskId !== context.deskId) {
      clear('scope_changed');
      scope = {epoch:context.epoch, deskId:context.deskId};
    }
  }
  function budget(deskId, at, create = false) {
    for (const [id, entry] of desks) {
      entry.times = entry.times.filter(time => time > at - WINDOW_MS);
      if (!entry.times.length && id !== deskId) desks.delete(id);
    }
    if (!desks.has(deskId) && create && desks.size < DESK_LIMIT) desks.set(deskId, {times:[]});
    return desks.get(deskId);
  }
  function view(at) {
    if (cue && (at >= cue.expiresAt || at < cue.startedAt)) cue = null;
    const times = scope ? budget(scope.deskId, at)?.times ?? [] : [];
    return {
      status:current?.status ?? 'stopped',
      ...(current ? structuredClone(current) : {reason:stoppedReason}),
      ...(prior ? {priorLimitation:structuredClone(prior)} : {}),
      ...(cue ? {cue:structuredClone(cue)} : {}),
      suggestions:{used:times.length, limit:LIMIT, windowMs:WINDOW_MS,
        ...(times.length >= LIMIT ? {nextAllowedAt:times[0] + WINDOW_MS} : {})}
    };
  }

  function assess(request, context) {
    const at = now();
    try {
      fields(request, ['basisObservationId', 'quality', 'reason', 'suggestion'], 'view_assessment');
      identifier(request.basisObservationId, 'observation_id');
      if (!QUALITIES.has(request.quality)) throw new Error('invalid_view_quality');
      if (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 300) throw new Error('invalid_view_reason');
      if (request.suggestion !== undefined && !GLYPHS.has(request.suggestion)) throw new Error('invalid_view_suggestion');
    } catch (error) { return {accepted:false, reason:error.message}; }
    const failure = validContext(context, at, request.basisObservationId);
    if (failure) { cue = null; return {accepted:false, reason:failure}; }
    bind(context);
    // Re-reading the same frame cannot renew a display lease or spend another invitation.
    if (current?.basisObservationId === request.basisObservationId) return {accepted:true, duplicate:true, ...view(at)};
    const observationAt = context.observation.at;
    if (current && observationAt <= current.observationAt) return {accepted:false, reason:'observation_not_newer'};
    cue = null;
    current = {status:request.quality, quality:request.quality,
      basisObservationId:request.basisObservationId, observationAt, assessedAt:at, reason:request.reason.trim()};
    if (request.quality === 'adequate') {
      if (prior?.suggestedAt !== undefined && observationAt > prior.observationAt && observationAt > prior.suggestedAt) current.status = 'improved';
    } else if (request.quality === 'limited' || request.quality === 'blocked') {
      const earlierSuggestion = prior?.suggestedAt;
      prior = {basisObservationId:request.basisObservationId, quality:request.quality, observationAt, assessedAt:at,
        ...(earlierSuggestion !== undefined ? {suggestedAt:earlierSuggestion} : {})};
      if (request.suggestion) {
        const entry = budget(scope.deskId, at, true);
        if (entry && entry.times.length < LIMIT) {
          entry.times.push(at);
          cue = {id:randomUUID(), glyph:request.suggestion, startedAt:at, expiresAt:at + CUE_MS};
          prior.suggestedAt = at;
          current.status = 'awaiting_check';
        } else current.cueSuppressed = entry ? 'invitation_limit' : 'budget_capacity';
      }
    }
    return {accepted:true, ...view(at)};
  }

  function snapshot(context) {
    const at = now(), failure = validContext(context, at);
    if (failure) { clear(failure); return view(at); }
    bind(context);
    // Missing, older, or withdrawn camera evidence cannot keep a cue alive.
    if (current && context.observation.at < current.observationAt) clear('observation_not_current');
    return view(at);
  }
  function stop(reason = 'stopped') {
    clear(typeof reason === 'string' ? reason.slice(0, 100) : 'stopped');
    scope = null;
    return {status:'stopped', reason:stoppedReason};
  }
  function close() { if (closed) return; stop('closed'); closed = true; desks.clear(); }
  return {assess, snapshot, stop, close};
}
