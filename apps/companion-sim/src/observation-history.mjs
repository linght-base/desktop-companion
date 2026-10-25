// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { validateObservation, validateVideoObservation } from './contracts.mjs';
import { createHash } from 'node:crypto';

const MAX_FUTURE_MS = 1_000;
const MAX_LIST_LIMIT = 32;
const DEFAULT_LIST_LIMIT = 16;
const OMITTED_CAP = 1e9;
const CONTEXT_KEYS = ['enabled', 'epoch', 'deskId', 'learningUse', 'learningVersion'];
const LEARNING_USES = new Set(['unknown', 'allowed', 'test', 'holdout']);
const SOURCES = new Set(['camera', 'replay']);
const REASONS = Object.freeze([
  'invalid_query', 'invalid_context', 'invalid_observation', 'unsupported_source',
  'disabled', 'not_initialized', 'scope_mismatch', 'stale_epoch',
  'stale_observation', 'future_observation', 'too_large', 'conflict',
  'not_found', 'stale_cursor', 'clock_fault', 'closed', 'capacity_evicted',
]);

function rejected(reason) {
  if (!REASONS.includes(reason)) throw new Error(`unknown_reason:${reason}`);
  return { accepted: false, status: 'rejected', reason };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function deskId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && !value.includes('\0');
}

export function createObservationHistory({ clock = Date.now, maxAgeMs = 120_000, maxBytes = 24_000_000, maxEntries = 240 } = {}) {
  if (typeof clock !== 'function') throw new TypeError('invalid_clock');
  for (const [name, value] of [['maxAgeMs', maxAgeMs], ['maxBytes', maxBytes], ['maxEntries', maxEntries]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid_${name}`);
  }
  let status = 'ready'; // ready | clock_fault | closed
  let scope = null; // {epoch, deskId}, host-established via reset
  const entries = new Map(); // id -> {observation, reference, at, seq, bytes, content, grant}
  let sequence = 0;
  let bytes = 0;
  let omittedAge = 0;
  let omittedCapacity = 0;
  let lastClock = null;

  const saturate = value => Math.min(value + 1, OMITTED_CAP);
  function fault() {
    entries.clear();
    bytes = 0;
    status = 'clock_fault';
  }
  function readClock() {
    let now;
    try { now = clock(); } catch { fault(); return null; }
    if (!Number.isSafeInteger(now) || now < 0 || (lastClock !== null && now < lastClock)) { fault(); return null; }
    lastClock = now;
    return now;
  }
  function expire(now) {
    for (const [id, entry] of entries) {
      if (now - entry.at > maxAgeMs) { entries.delete(id); bytes -= entry.bytes; omittedAge = saturate(omittedAge); }
    }
  }
  function evictOldest() {
    let oldest = null;
    for (const entry of entries.values()) {
      if (!oldest || entry.at < oldest.at || (entry.at === oldest.at && entry.seq < oldest.seq)) oldest = entry;
    }
    entries.delete(oldest.observation.id);
    bytes -= oldest.bytes;
    omittedCapacity = saturate(omittedCapacity);
  }
  function checkContext(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) return 'invalid_context';
    for (const key of Object.keys(context)) if (!CONTEXT_KEYS.includes(key)) return 'invalid_context';
    if (typeof context.enabled !== 'boolean') return 'invalid_context';
    if (!Number.isSafeInteger(context.epoch) || context.epoch < 0) return 'invalid_context';
    if (!deskId(context.deskId)) return 'invalid_context';
    if (context.learningVersion !== undefined && (!Number.isSafeInteger(context.learningVersion) || context.learningVersion < 1)) return 'invalid_context';
    if (context.learningUse === 'allowed' && context.learningVersion === undefined) return 'invalid_context';
    if (context.enabled !== true) return 'disabled';
    if (!scope) return 'not_initialized';
    if (context.epoch !== scope.epoch || context.deskId !== scope.deskId) return 'scope_mismatch';
    return null;
  }
  function buildReference(context, observation) {
    const reference = {
      type: 'observation', at: observation.at, source: observation.source,
      epoch: context.epoch, deskId: context.deskId,
      learningUse: LEARNING_USES.has(context.learningUse) ? context.learningUse : 'unknown',
    };
    if (context.learningVersion !== undefined) reference.learningVersion = context.learningVersion;
    return reference;
  }
  function guard() {
    if (status === 'closed') return 'closed';
    if (status === 'clock_fault') return 'clock_fault';
    return null;
  }

  function reset(args) {
    if (status === 'closed') return rejected('closed');
    if (!args || typeof args !== 'object' || Array.isArray(args)) return rejected('invalid_query');
    for (const key of Object.keys(args)) if (!['epoch', 'deskId'].includes(key)) return rejected('invalid_query');
    if (!Number.isSafeInteger(args.epoch) || args.epoch < 0) return rejected('invalid_query');
    if (!deskId(args.deskId)) return rejected('invalid_query');
    if (scope && args.epoch <= scope.epoch) return rejected('stale_epoch');
    scope = { epoch: args.epoch, deskId: args.deskId };
    entries.clear();
    bytes = 0;
    omittedAge = 0;
    omittedCapacity = 0;
    lastClock = null;
    status = 'ready';
    if (readClock() === null) return rejected('clock_fault');
    return { accepted: true, epoch: scope.epoch, deskId: scope.deskId };
  }

  function capture(observation, context) {
    const blocked = guard();
    if (blocked) return rejected(blocked);
    const contextError = checkContext(context);
    if (contextError) return rejected(contextError);
    const now = readClock();
    if (now === null) return rejected('clock_fault');
    let validated;
    try {
      validated = observation && typeof observation === 'object' && 'stream' in observation
        ? validateVideoObservation(observation) : validateObservation(observation);
    } catch { return rejected('invalid_observation'); }
    if (!SOURCES.has(validated.source)) return rejected('unsupported_source');
    if (now - validated.at > maxAgeMs) return rejected('stale_observation');
    if (validated.at - now > MAX_FUTURE_MS) return rejected('future_observation');
    const reference = buildReference(context, validated);
    const grant = canonical({ epoch: reference.epoch, deskId: reference.deskId, learningUse: reference.learningUse, learningVersion: reference.learningVersion ?? null });
    const content = createHash('sha256').update(canonical(validated)).digest('hex');
    const existing = entries.get(validated.id);
    if (existing) {
      if (existing.content === content && existing.grant === grant) return { accepted: true, id: existing.observation.id, duplicate: true };
      return rejected('conflict');
    }
    const itemBytes = Buffer.byteLength(JSON.stringify({ observation: validated, reference }));
    if (itemBytes > maxBytes) { omittedCapacity = saturate(omittedCapacity); return rejected('too_large'); }
    expire(now);
    entries.set(validated.id, { observation: validated, reference, at: validated.at, seq: sequence++, bytes: itemBytes, content, grant });
    bytes += itemBytes;
    while (entries.size > maxEntries || bytes > maxBytes) evictOldest();
    if (!entries.has(validated.id)) return rejected('capacity_evicted');
    return { accepted: true, id: validated.id, bytes: itemBytes };
  }

  function get(id, context) {
    const blocked = guard();
    if (blocked) return rejected(blocked);
    const contextError = checkContext(context);
    if (contextError) return rejected(contextError);
    if (typeof id !== 'string' || !id || id.length > 100) return rejected('invalid_query');
    const now = readClock();
    if (now === null) return rejected('clock_fault');
    expire(now);
    const entry = entries.get(id);
    if (!entry) return rejected('not_found');
    return { accepted: true, observation: structuredClone(entry.observation), reference: structuredClone(entry.reference) };
  }

  function list(query, context) {
    const blocked = guard();
    if (blocked) return rejected(blocked);
    const contextError = checkContext(context);
    if (contextError) return rejected(contextError);
    if (query === undefined) query = {};
    if (!query || typeof query !== 'object' || Array.isArray(query)) return rejected('invalid_query');
    for (const key of Object.keys(query)) if (!['limit', 'cursor'].includes(key)) return rejected('invalid_query');
    let limit = query.limit === undefined ? DEFAULT_LIST_LIMIT : query.limit;
    if (!Number.isSafeInteger(limit) || limit < 1) return rejected('invalid_query');
    limit = Math.min(limit, MAX_LIST_LIMIT);
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor)) return rejected('invalid_query');
    const now = readClock();
    if (now === null) return rejected('clock_fault');
    expire(now);
    const ordered = [...entries.values()].sort((a, b) => b.at - a.at || b.seq - a.seq);
    let start = 0;
    if (query.cursor !== undefined) {
      const index = ordered.findIndex(entry => entry.observation.id === query.cursor);
      if (index < 0) return rejected('stale_cursor');
      start = index + 1;
    }
    const page = ordered.slice(start, start + limit);
    return {
      accepted: true,
      entries: page.map(entry => ({
        id: entry.observation.id, at: entry.observation.at, source: entry.observation.source,
        coverage: entry.observation.coverage, frameTimes: entry.observation.frames.map(frame => frame.at), frameCount: entry.observation.frames.length,
      })),
      nextCursor: page.length && start + limit < ordered.length ? page[page.length - 1].observation.id : null,
      count: page.length,
      omittedAge,
      omittedCapacity,
    };
  }

  function summary() {
    let oldestAt = null;
    let newestAt = null;
    for (const entry of entries.values()) {
      if (oldestAt === null || entry.at < oldestAt) oldestAt = entry.at;
      if (newestAt === null || entry.at > newestAt) newestAt = entry.at;
    }
    return { status, count: entries.size, bytes, oldestAt, newestAt, maxAgeMs, maxBytes, maxEntries, omittedAge, omittedCapacity };
  }
  function snapshot() {
    return sweep();
  }
  function sweep() {
    if (status === 'ready') {
      const now = readClock();
      if (now !== null) expire(now);
    }
    return summary();
  }
  function close() {
    if (status !== 'closed') {
      entries.clear();
      bytes = 0;
      status = 'closed';
    }
    return { accepted: true };
  }

  return Object.freeze({ capture, list, get, reset, sweep, snapshot, close });
}
