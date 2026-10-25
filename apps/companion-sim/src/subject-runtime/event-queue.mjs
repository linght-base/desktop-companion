// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID,createHash } from 'node:crypto';

const OUTCOMES = new Set(['completed', 'failed', 'aborted']);
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_ID_LENGTH = 128;
const MAX_KIND_LENGTH = 64;
const MAX_COALESCE_KEY_LENGTH = 128;
const MAX_REASON_LENGTH = 200;
const MAX_FRAMES = 4;

function boundedString(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !value.includes('\0');
}

function safeTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function epochValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid_epoch');
  return value;
}

function stableStringify(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertPureJson(value, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('invalid_payload');
    return;
  }
  if (type !== 'object') throw new TypeError('invalid_payload');
  if (seen.has(value)) throw new TypeError('circular_payload');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertPureJson(item, seen);
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('invalid_payload');
    for (const key of Object.keys(value)) {
      if (POLLUTION_KEYS.has(key)) throw new TypeError('polluting_payload_key');
      assertPureJson(value[key], seen);
    }
  }
  seen.delete(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('invalid_event');
  if (!boundedString(event.id, MAX_ID_LENGTH)) throw new TypeError('invalid_event_id');
  if (!boundedString(event.kind, MAX_KIND_LENGTH)) throw new TypeError('invalid_event_kind');
  if (!safeTime(event.at)) throw new TypeError('invalid_event_time');
  if (event.payload === undefined) throw new TypeError('invalid_payload');
  assertPureJson(event.payload, new Set());
  if (Array.isArray(event.payload?.frames) && event.payload.frames.length > MAX_FRAMES) {
    throw new TypeError('too_many_frames');
  }
  return event;
}

function validateContext(hostContext) {
  if (!hostContext || typeof hostContext !== 'object' || Array.isArray(hostContext)) {
    throw new TypeError('invalid_host_context');
  }
  const epoch = epochValue(hostContext.epoch);
  if (typeof hostContext.priority !== 'number' || !Number.isFinite(hostContext.priority)) {
    throw new TypeError('invalid_priority');
  }
  if (hostContext.expiresAt !== undefined && !safeTime(hostContext.expiresAt)) {
    throw new TypeError('invalid_expiry');
  }
  if (hostContext.runExpiresAt !== undefined && !safeTime(hostContext.runExpiresAt)) {
    throw new TypeError('invalid_run_expiry');
  }
  if (hostContext.runExpiresAt !== undefined && hostContext.expiresAt !== undefined &&
    hostContext.runExpiresAt < hostContext.expiresAt) {
    throw new TypeError('invalid_run_expiry');
  }
  if (hostContext.coalesceKey !== undefined && !boundedString(hostContext.coalesceKey, MAX_COALESCE_KEY_LENGTH)) {
    throw new TypeError('invalid_coalesce_key');
  }
  if (hostContext.interruptible !== undefined && typeof hostContext.interruptible !== 'boolean') {
    throw new TypeError('invalid_interruptible');
  }
  return hostContext;
}

function meta(entry, status, reason) {
  const value = {
    id: entry.id,
    kind: entry.kind,
    at: entry.at,
    epoch: entry.epoch,
    priority: entry.priority,
    deadline: entry.expiresAt ?? null,
    runDeadline: entry.runExpiresAt ?? null,
    status,
  };
  if (entry.coalesceKey !== undefined) value.coalesceKey = entry.coalesceKey;
  if (reason !== undefined) value.reason = reason;
  return value;
}

/**
 * Host-owned bounded in-memory work queue for the subject runtime. The queue
 * only manages work lifecycle: it never calls the model, the body, timers, or
 * the network. Priority, epoch, and deadlines are injected by the host per
 * enqueue; payload self-reports are never trusted. The model only ever sees
 * the event handed out by take(); the leaseId is host-only.
 *
 * Release notifications (coalesced replacements, expiries, stale-epoch
 * revocations) are each delivered exactly once: implicit sweeps inside
 * enqueue/take buffer them, and the next enqueue/take/sweep/interrupt receipt
 * drains the buffer. interrupt() returns its own revocations directly instead
 * of buffering them.
 */
export function createAgentEventQueue({ clock = Date.now, maxPending = 40, maxBytes = 1800000 } = {}) {
  if (typeof clock !== 'function') throw new TypeError('invalid_clock');
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new TypeError('invalid_max_pending');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid_max_bytes');
  const maxSeenIds = Math.max(65536, maxPending * 8);

  let closed = false;
  let currentEpoch = 0;
  let hasEpoch = false;
  let lastNow = 0;
  let sequence = 0;
  let totalBytes = 0;
  const pending = [];
  let active = null;
  const seen = new Map();
  let releaseBuffer = [];
  let clockFaulted=false;

  function now() {
    const value=clock();
    if(!safeTime(value)||value<lastNow){
      if(active){releaseBuffer.push(meta(active,'active','clock_regressed'));totalBytes-=active.bytes;rememberConsumed(active);active=null;}
      for(const entry of [...pending]){dropEntry(entry);rememberConsumed(entry);releaseBuffer.push(meta(entry,'queued','clock_regressed'));}
      clockFaulted=true;
    }
    if(safeTime(value))lastNow=value;
    return lastNow;
  }

  function advanceEpoch(epoch) {
    if (!hasEpoch || epoch > currentEpoch) {
      currentEpoch = epoch;
      hasEpoch = true;clockFaulted=false;
      for (const [id, record] of seen) {
        if (record.state === 'consumed' && record.epoch < epoch) seen.delete(id);
      }
    }
  }

  function rememberConsumed(entry) {
    const record = seen.get(entry.id);
    if (record && record.state !== 'consumed') {
      seen.set(entry.id, { hash: record.hash, state: 'consumed', epoch: entry.epoch });
    }
  }

  function dropEntry(entry) {
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
    totalBytes -= entry.bytes;
  }

  function sweepInternal(at) {
    if(active){const activeDeadline=active.runExpiresAt!==undefined?active.runExpiresAt:active.expiresAt;
      if(active.epoch<currentEpoch||activeDeadline!==undefined&&activeDeadline<=at){const ended=active;active=null;totalBytes-=ended.bytes;rememberConsumed(ended);releaseBuffer.push(meta(ended,'active',ended.epoch<currentEpoch?'stale_epoch':'expired'));}}
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      const expired = entry.expiresAt !== undefined && entry.expiresAt <= at;
      const stale = entry.epoch < currentEpoch;
      if (!expired && !stale) continue;
      dropEntry(entry);
      rememberConsumed(entry);
      releaseBuffer.push(meta(entry, 'queued', expired ? 'expired' : 'stale_epoch'));
    }
  }

  function drainReleases() {
    if (!releaseBuffer.length) return [];
    const drained = releaseBuffer;
    releaseBuffer = [];
    return drained;
  }

  function entryBytes(id, kind, payloadText) {
    return Buffer.byteLength(payloadText, 'utf8') + Buffer.byteLength(id, 'utf8') + Buffer.byteLength(kind, 'utf8');
  }

  function enqueue(event, hostContext) {
    if (closed) return { accepted: false, status: 'closed', released: drainReleases() };
    validateEvent(event);
    validateContext(hostContext);
    const at = now();
    if (hasEpoch && hostContext.epoch < currentEpoch) {
      return { accepted: false, status: 'stale_epoch', id: event.id, released: drainReleases() };
    }
    advanceEpoch(hostContext.epoch);
    if(clockFaulted)return {accepted:false,status:'clock_regressed',released:drainReleases()};
    sweepInternal(at);
    const payloadText = stableStringify(event.payload);
    const hash = createHash('sha256').update(stableStringify({ at: event.at, id: event.id, kind: event.kind, payload: event.payload })).digest('hex');
    const known = seen.get(event.id);
    if (known) {
      if (known.hash === hash) {
        return { accepted: true, status: 'duplicate', id: event.id, state: known.state, released: drainReleases() };
      }
      return { accepted: false, status: 'conflict', id: event.id, released: drainReleases() };
    }
    if (seen.size >= maxSeenIds) {
      return { accepted: false, status: 'dedup_budget_exceeded', id: event.id, released: drainReleases() };
    }
    if (hostContext.expiresAt !== undefined && hostContext.expiresAt <= at) {
      return { accepted: false, status: 'expired', id: event.id, released: drainReleases() };
    }
    if (hostContext.runExpiresAt !== undefined && hostContext.runExpiresAt <= at) {
      return { accepted: false, status: 'run_expired', id: event.id, released: drainReleases() };
    }
    const bytes = entryBytes(event.id, event.kind, payloadText);
    if (bytes > maxBytes || totalBytes + bytes > maxBytes) {
      return { accepted: false, status: 'byte_budget_exceeded', id: event.id, released: drainReleases() };
    }
    let replaced = null;
    if (hostContext.coalesceKey !== undefined) {
      const index = pending.findIndex(entry =>
        entry.epoch === hostContext.epoch && entry.coalesceKey === hostContext.coalesceKey);
      if (index >= 0) {
        replaced = pending[index];
        dropEntry(replaced);
        rememberConsumed(replaced);
      } else if (pending.length >= maxPending) {
        return { accepted: false, status: 'queue_full', id: event.id, released: drainReleases() };
      }
    } else if (pending.length >= maxPending) {
      return { accepted: false, status: 'queue_full', id: event.id, released: drainReleases() };
    }
    const entry = {
      id: event.id,
      kind: event.kind,
      at: event.at,
      payload: deepFreeze(JSON.parse(payloadText)),
      bytes,
      epoch: hostContext.epoch,
      priority: hostContext.priority,
      expiresAt: hostContext.expiresAt,
      runExpiresAt: hostContext.runExpiresAt,
      coalesceKey: hostContext.coalesceKey,
      interruptible: hostContext.interruptible,
      sequence: sequence += 1,
    };
    pending.push(entry);
    totalBytes += bytes;
    seen.set(entry.id, { hash, state: 'pending', epoch: entry.epoch });
    sweepInternal(at);
    return {
      accepted: true,
      status: replaced ? 'coalesced' : 'enqueued',
      id: entry.id,
      replaced: replaced ? meta(replaced, 'queued', 'coalesced') : null,
      released: drainReleases(),
    };
  }

  function take(input) {
    if (closed) return { taken: false, reason: 'closed', released: drainReleases() };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_take');
    const epoch = epochValue(input.epoch);
    if (hasEpoch && epoch < currentEpoch) {
      return { taken: false, reason: 'stale_epoch', released: drainReleases() };
    }
    advanceEpoch(epoch);
    const at = now();
    sweepInternal(at);
    if(clockFaulted)return {taken:false,reason:'clock_regressed',released:drainReleases()};
    if (input.enabled !== true) return { taken: false, reason: 'disabled', released: drainReleases() };
    if (active) {
      return { taken: false, reason: 'busy', active: meta(active, 'active'), released: drainReleases() };
    }
    if (!pending.length) return { taken: false, reason: 'empty', released: drainReleases() };
    let best = 0;
    for (let index = 1; index < pending.length; index += 1) {
      const candidate = pending[index];
      const current = pending[best];
      if (candidate.priority !== current.priority) {
        if (candidate.priority > current.priority) best = index;
      } else {
        const candidateDeadline = candidate.expiresAt ?? Number.MAX_SAFE_INTEGER;
        const currentDeadline = current.expiresAt ?? Number.MAX_SAFE_INTEGER;
        if (candidateDeadline !== currentDeadline) {
          if (candidateDeadline < currentDeadline) best = index;
        } else if (candidate.sequence < current.sequence) {
          best = index;
        }
      }
    }
    const entry = pending.splice(best, 1)[0];
    const leaseId = randomUUID();
    active = { ...entry, leaseId };
    const record = seen.get(entry.id);
    if (record) seen.set(entry.id, { ...record, state: 'active' });
    return {
      taken: true,
      event: { id: entry.id, kind: entry.kind, at: entry.at, payload: entry.payload },
      leaseId,
      released: drainReleases(),
    };
  }

  function settle(input) {
    if (closed) return { accepted: false, status: 'closed' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_settle');
    if (typeof input.leaseId !== 'string' || !input.leaseId) throw new TypeError('invalid_lease');
    if (!OUTCOMES.has(input.outcome)) throw new TypeError('invalid_outcome');
    if (!active) return { accepted: false, status: 'no_active_lease' };
    if (active.leaseId !== input.leaseId) return { accepted: false, status: 'stale_lease' };
    const finished = active;
    active = null;
    totalBytes -= finished.bytes;
    rememberConsumed(finished);
    return { accepted: true, status: input.outcome, work: meta(finished, 'settled') };
  }

  function interrupt(input) {
    if (closed) return { accepted: false, status: 'closed', active: null, queued: [], released: [] };
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('invalid_interrupt');
    const epoch = epochValue(input.epoch);
    if (input.minimumPriority !== undefined &&
        (typeof input.minimumPriority !== 'number' || !Number.isFinite(input.minimumPriority))) {
      throw new TypeError('invalid_minimum_priority');
    }
    if (input.reason !== undefined && !boundedString(input.reason, MAX_REASON_LENGTH)) {
      throw new TypeError('invalid_reason');
    }
    if (hasEpoch && epoch < currentEpoch) {
      return { accepted: false, status: 'stale_epoch', active: null, queued: [], released: drainReleases() };
    }
    advanceEpoch(epoch);
    const reason = input.reason ?? 'interrupted';
    let revokedActive = null;
    if (active) {
      const staleEpoch = active.epoch < epoch;
      const preempted = !staleEpoch && input.minimumPriority !== undefined &&
        active.priority < input.minimumPriority && active.interruptible !== false;
      if (staleEpoch || preempted) {
        revokedActive = meta(active, 'active', staleEpoch ? 'stale_epoch' : reason);
        totalBytes -= active.bytes;
        rememberConsumed(active);
        active = null;
      }
    }
    const queued = [];
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      const staleEpoch = entry.epoch < epoch;
      const preempted = !staleEpoch && input.minimumPriority !== undefined && entry.priority < input.minimumPriority;
      if (!staleEpoch && !preempted) continue;
      dropEntry(entry);
      rememberConsumed(entry);
      queued.unshift(meta(entry, 'queued', staleEpoch ? 'stale_epoch' : reason));
    }
    return { accepted: true, status: 'interrupted', epoch, active: revokedActive, queued, released: drainReleases() };
  }

  function sweep() {
    if (closed) return { released: [] };
    sweepInternal(now());
    return { released: drainReleases() };
  }

  function snapshot() {
    if (closed) return { closed: true };
    return {
      closed: false,
      epoch: hasEpoch ? currentEpoch : null,
      pendingCount: pending.length,
      activeCount: active ? 1 : 0,
      totalBytes,
      maxPending,
      maxSeenIds,
      clockFaulted,
      maxBytes,
      releaseBacklog: releaseBuffer.length,
      active: active ? meta(active, 'active') : null,
      pending: pending.map(entry => meta(entry, 'queued')),
    };
  }

  function close() {
    if (closed) return { closed: true, released: [] };
    closed = true;
    const remaining = [
      ...(active ? [meta(active, 'active', 'closed')] : []),
      ...pending.map(entry => meta(entry, 'queued', 'closed')),
      ...releaseBuffer,
    ];
    pending.length = 0;
    active = null;
    seen.clear();
    releaseBuffer = [];
    totalBytes = 0;
    return { closed: true, released: remaining };
  }

  return { enqueue, take, settle, interrupt, sweep, snapshot, close };
}
