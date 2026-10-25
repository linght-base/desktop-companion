// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// JSONL stdio bridge to the local python device daemon. Frames go to onFrame
// only; they never reach snapshots, logs, or disk. stderr content is never
// surfaced: every failure is reported as a fixed error code.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const OPS = new Set(['head', 'expression', 'camera_start', 'camera_stop', 'camera_status', 'camera_recover', 'prepare_message', 'close', 'stop']);
const STOP_CHANNELS = new Set(['head', 'expression']);
const MAX_LINE_BYTES = 450_000;
const MAX_PENDING = 16;
const MAX_CAPABILITIES = 64;
const READY_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 3_000;
const CLOSE_OP_TIMEOUT_MS = 800;
const SIGKILL_GRACE_MS = 1_500;
const CODE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MESSAGE_KEYS = {
  ready: ['type', 'online', 'sdkVersion', 'firmwareVersion', 'capabilities'],
  reply: ['type', 'id', 'ok', 'result', 'error'],
  frame: ['type', 'at', 'sequence', 'width', 'height', 'data'],
  fatal: ['type', 'code']
};

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function asCode(value, fallback = 'device_error') {
  return typeof value === 'string' && CODE_RE.test(value) ? value : fallback;
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, keys) {
  const own = Object.keys(value);
  return own.length <= keys.length && own.every(key => keys.includes(key));
}
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createDeviceBridge({pythonPath, scriptPath, onFrame = () => {}, onChange = () => {}, clock = Date.now} = {}) {
  if (typeof pythonPath !== 'string' || pythonPath.length === 0) throw new TypeError('invalid_python_path');
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) throw new TypeError('invalid_script_path');
  if (typeof onFrame !== 'function') throw new TypeError('invalid_on_frame');
  if (typeof onChange !== 'function') throw new TypeError('invalid_on_change');
  if (typeof clock !== 'function') throw new TypeError('invalid_clock');

  let state = 'closed'; // starting|connected|error|closed; closed also covers "never started"
  let child = null;
  let decoder = null;
  let buffer = '';
  let generation = 0;
  let sdkVersion = null;
  let firmwareVersion = null;
  let capabilities = [];
  let errorCode = null;
  let framesReceived = 0;
  let lastFrameAt = null;
  let startPromise = null;
  let readyWaiter = null;
  let readyTimer = null;
  let killTimer = null;
  let closing = false;
  let started = false; // never respawns: no auto-reconnect, no auto-restart
  let closePromise = null;
  const pending = new Map();

  function snapshot() {
    return {
      configured: true,
      state,
      connected: state === 'connected',
      sdkVersion,
      firmwareVersion,
      capabilities: capabilities.slice(0, MAX_CAPABILITIES),
      error: errorCode,
      framesReceived,
      lastFrameAt
    };
  }
  function notify() {
    try { onChange(snapshot()); } catch { /* Consumer callbacks must not crash the bridge. */ }
  }
  function setState(next, code = null) {
    const changed = state !== next || errorCode !== code;
    state = next;
    errorCode = code;
    if (changed) notify();
  }
  function rejectPending(code) {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(failure(code));
    }
  }
  function settleReady(error, result) {
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    const waiter = readyWaiter;
    readyWaiter = null;
    if (!waiter) return;
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }
  function terminate() {
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* Already gone. */ }
    if (!killTimer) {
      killTimer = setTimeout(() => {
        killTimer = null;
        try { child?.kill('SIGKILL'); } catch { /* Already gone. */ }
      }, SIGKILL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }
  }
  function failBridge(code) {
    if (state === 'error' || state === 'closed') return;
    settleReady(failure(code));
    rejectPending(code);
    terminate();
    setState('error', code);
  }

  function handleReady(message) {
    if (state !== 'starting') return failBridge('protocol_error');
    if (!hasOnlyKeys(message, MESSAGE_KEYS.ready) || message.online !== true ||
        typeof message.sdkVersion !== 'string' || typeof message.firmwareVersion !== 'string' ||
        !Array.isArray(message.capabilities) || message.capabilities.some(item => typeof item !== 'string')) {
      return failBridge('protocol_error');
    }
    sdkVersion = message.sdkVersion;
    firmwareVersion = message.firmwareVersion;
    capabilities = message.capabilities.slice(0, MAX_CAPABILITIES);
    setState('connected', null);
    settleReady(null, snapshot());
  }
  function handleReply(message) {
    if (!hasOnlyKeys(message, MESSAGE_KEYS.reply) || typeof message.id !== 'string' || typeof message.ok !== 'boolean') {
      return failBridge('protocol_error');
    }
    const entry = pending.get(message.id);
    if (!entry) return; // Unknown or already timed out.
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result === undefined ? null : message.result);
    else entry.reject(failure(asCode(message.error)));
  }
  function handleFrame(message) {
    if (!hasOnlyKeys(message, MESSAGE_KEYS.frame) || !isFiniteNumber(message.at) ||
        !Number.isSafeInteger(message.sequence) || message.sequence < 0 ||
        !Number.isSafeInteger(message.width) || message.width < 1 || message.width > 16384 ||
        !Number.isSafeInteger(message.height) || message.height < 1 || message.height > 16384 ||
        typeof message.data !== 'string' || message.data.length === 0 || !BASE64_RE.test(message.data)) {
      return failBridge('protocol_error');
    }
    framesReceived++;
    lastFrameAt = message.at;
    try {
      onFrame({type: 'frame', at: message.at, sequence: message.sequence, width: message.width, height: message.height, data: message.data});
    } catch { /* Frame consumers must not crash the bridge. */ }
  }
  function handleLine(line) {
    if (line.length === 0) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return failBridge('parse_error');
    let message;
    try { message = JSON.parse(line); } catch { return failBridge('parse_error'); }
    if (!isRecord(message) || typeof message.type !== 'string') return failBridge('parse_error');
    if (closing || state === 'closed' || state === 'error') return;
    if (state === 'starting' && message.type !== 'ready' && message.type !== 'fatal') return failBridge('protocol_error');
    switch (message.type) {
      case 'ready': return handleReady(message);
      case 'reply': return handleReply(message);
      case 'frame': return handleFrame(message);
      case 'fatal': return failBridge('device_fatal');
      default: return failBridge('protocol_error');
    }
  }
  function onStdout(chunk) {
    if (!decoder || state === 'error' || state === 'closed') return;
    buffer += decoder.write(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleLine(line);
      if (state === 'error' || state === 'closed') { buffer = ''; return; }
      index = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) { buffer = ''; failBridge('parse_error'); } // bounded fragment
  }
  function onExit() {
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    child = null;
    if (closing) {
      settleReady(failure('bridge_closed'));
      rejectPending('bridge_closed');
      setState('closed', null);
      return;
    }
    failBridge('process_exit');
  }

  function track(id, op, resolve, reject, timeoutMs) {
    const entry = {op, resolve, reject, timer: null};
    entry.timer = setTimeout(() => {
      if (pending.delete(id)) entry.reject(failure('timeout'));
    }, timeoutMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    pending.set(id, entry);
    return entry;
  }
  function writeLine(id, line) {
    if (!child || !child.stdin || !child.stdin.writable) {
      const entry = pending.get(id);
      if (entry && pending.delete(id)) { clearTimeout(entry.timer); entry.reject(failure('write_failed')); }
      return;
    }
    try {
      child.stdin.write(line, writeError => {
        if (!writeError) return;
        const entry = pending.get(id);
        if (entry && pending.delete(id)) { clearTimeout(entry.timer); entry.reject(failure('write_failed')); }
      });
    } catch {
      const entry = pending.get(id);
      if (entry && pending.delete(id)) { clearTimeout(entry.timer); entry.reject(failure('write_failed')); }
    }
  }

  function start() {
    if (startPromise) return startPromise; // idempotent
    if (started) { // never restarted after a terminal state
      startPromise = Promise.reject(failure('bridge_closed'));
      startPromise.catch(() => {});
      return startPromise;
    }
    started = true;
    setState('starting', null);
    startPromise = new Promise((resolve, reject) => { readyWaiter = {resolve, reject}; });
    startPromise.catch(() => {}); // internal handler so an ignored start never crashes the process
    try {
      child = spawn(pythonPath, [scriptPath], {stdio: ['pipe', 'pipe', 'pipe'], shell: false});
    } catch {
      failBridge('spawn_failed');
      return startPromise;
    }
    decoder = new StringDecoder('utf8');
    buffer = '';
    child.stdout.on('data', onStdout);
    child.stderr.resume(); // consumed and discarded, never surfaced
    child.on('error', () => failBridge('spawn_failed'));
    child.on('exit', onExit);
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (state === 'starting') failBridge('ready_timeout');
    }, READY_TIMEOUT_MS);
    if (typeof readyTimer.unref === 'function') readyTimer.unref();
    return startPromise;
  }

  function request(op, payload = {}, {timeoutMs = 5000} = {}) {
    if (typeof op !== 'string' || !OPS.has(op)) return Promise.reject(failure('invalid_op'));
    if (!isRecord(payload)) return Promise.reject(failure('invalid_payload'));
    if (Object.keys(payload).some(key => key === 'id' || key === 'op' || key === 'generation' || key === '__proto__')) {
      return Promise.reject(failure('invalid_payload'));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      return Promise.reject(failure('invalid_options'));
    }
    if (state === 'closed') return Promise.reject(failure(started ? 'bridge_closed' : 'not_ready'));
    if (state !== 'connected') return Promise.reject(failure('not_ready'));
    if (pending.size >= MAX_PENDING) return Promise.reject(failure('too_many_pending'));
    let safePayload;
    try { safePayload = JSON.parse(JSON.stringify(payload)); } catch { return Promise.reject(failure('invalid_payload')); }
    if (!isRecord(safePayload)) return Promise.reject(failure('invalid_payload'));
    const id = randomUUID();
    const line = JSON.stringify({id, op, generation, ...safePayload}) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return Promise.reject(failure('payload_too_large'));
    return new Promise((resolve, reject) => {
      track(id, op, resolve, reject, timeoutMs);
      writeLine(id, line);
    });
  }

  function stop({channels, reason} = {}) {
    let channelList;
    if (channels === undefined) channelList = [...STOP_CHANNELS];
    else if (Array.isArray(channels) && channels.length >= 1 && channels.length <= STOP_CHANNELS.size &&
             channels.every(channel => STOP_CHANNELS.has(channel))) channelList = [...new Set(channels)];
    else return Promise.reject(failure('invalid_options'));
    const stopReason = asCode(reason, 'stopped');
    generation++; // monotonic; caller payloads can never override it
    rejectPending('stopped');
    if (state !== 'connected' || !child || !child.stdin || !child.stdin.writable) {
      return Promise.resolve({ok: false, error: state});
    }
    // High-priority direct send: bypasses the pending cap after the queue was revoked.
    const id = randomUUID();
    const line = JSON.stringify({id, op: 'stop', generation, channels: channelList}) + '\n';
    return new Promise((resolve, reject) => {
      track(id, 'stop', resolve, reject, STOP_TIMEOUT_MS);
      writeLine(id, line);
    });
  }

  function close() {
    if (state === 'closed' && !child) return Promise.resolve(snapshot()); // idempotent
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (state === 'connected') {
        try { await request('close', {}, {timeoutMs: CLOSE_OP_TIMEOUT_MS}); } catch { /* Best effort. */ }
      }
      settleReady(failure('bridge_closed'));
      rejectPending('bridge_closed');
      // The close ACK only accepts cleanup. Let official SDK cleanup release
      // inference ownership before SIGTERM can interrupt that cleanup.
      const owned=child;
      if(owned&&owned.exitCode===null){
        owned.stdin.end();
        await new Promise(resolve=>{const done=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{owned.removeListener('exit',done);resolve();},9000);owned.once('exit',done);});
      }
      terminate();
      if (child) {
        await new Promise(resolve => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          child.once('exit', finish);
          const guard = setTimeout(finish, SIGKILL_GRACE_MS + 500);
          if (typeof guard.unref === 'function') guard.unref();
        });
      }
      buffer = '';
      decoder = null;
      setState('closed', null);
      return snapshot();
    })();
    return closePromise;
  }

  return {start, request, stop, snapshot, close};
}
