// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {projectInteractionFeedback,projectFaceFeedback} from '../web/interaction-feedback.js';
// Host-state projection onto the physical device bridge. Per-channel
// latest-only sending: at most one request in flight; a newer host state
// observed while in flight is re-evaluated from `current` on settle, so the
// "queued" slot is always the newest accepted state. Every send re-checks
// the original epoch, the receipt identity (commandId), and the original
// absolute deadline; nothing ever extends a lease.
const HEAD_YAW_LIMIT = 45;
const HEAD_PITCH_LIMIT = 15;
const MIN_HEAD_REMAINING_MS = 100;
const MAX_HEAD_DURATION_MS = 600;
const MAX_REQUEST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 1_500;
const MAX_TIMER_MS = 2_147_000_000;
const CODE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const BRIDGE_CHANNELS = ['head', 'expression'];
const DEVICE_PROFILE = 'integrated-device';
const statusDisplay=state=>state?.device?.configured===true&&['paused','stopped','error'].includes(state.phase);

function asCode(value, fallback = 'device_error') {
  return typeof value === 'string' && CODE_RE.test(value) ? value : fallback;
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
function isCommandId(value) {
  return value === null || value === undefined || typeof value === 'string';
}
function readState(state) {
  if (!isRecord(state) || !Number.isSafeInteger(state.epoch) || state.epoch < 0) return null;
  if (typeof state.enabled !== 'boolean') return null;
  if (state.manualHeadPreview !== undefined && typeof state.manualHeadPreview !== 'boolean') return null;
  const body = state.body;
  if (!isRecord(body) || !isRecord(body.head)) return null;
  if (!isFiniteNumber(body.head.yaw) || !isFiniteNumber(body.head.pitch)) return null;
  if (!isRecord(body.eyes) || typeof body.icon !== 'string') return null;
  if (!isCommandId(body.headCommandId) || !isCommandId(body.expressionCommandId) || !isCommandId(body.gazeCommandId)) return null;
  const leaseEnds = body.leaseEnds;
  if (!isRecord(leaseEnds)) return null;
  for (const key of ['head', 'expression', 'gaze']) if (!isFiniteNumber(leaseEnds[key])) return null;
  return state;
}

export function createDeviceOutput({bridge, clock = Date.now, onChange = () => {}} = {}) {
  if (!isRecord(bridge) || typeof bridge.request !== 'function' || typeof bridge.stop !== 'function') {
    throw new TypeError('invalid_bridge');
  }
  if (typeof clock !== 'function') throw new TypeError('invalid_clock');
  if (typeof onChange !== 'function') throw new TypeError('invalid_on_change');

  let closed = false;
  let halted = false; // set by stop(); cleared by the next accept()
  let run = 0;        // revocation counter; captured by every send token
  let epoch = null;
  let current = null;
  let presencePulse = null;
  let error = null;
  let hadActivity = false; // any command ever sent since the last revocation
  let notifying = false;
  let notifyAgain = false;

  function createChannel(name) {
    return {name, active: false, cycle: 0, inFlight: null, queued: null, lastSignature: null, status: 'idle', commandId: null, at: null, target: null, confirmedTarget:null,confirmedAt:null,confirmedCommandId:null, timer: null};
  }
  const channels = {head: createChannel('head'), expression: createChannel('expression')};
  const channelList = [channels.head, channels.expression];

  function channelSnapshot(ch) {
    const snap = {status: ch.status, commandId: ch.commandId, at: ch.at};
    if (ch.name === 'expression' && ch.userMessage) snap.userMessage={...ch.userMessage};
    if (ch.name === 'head' && ch.target) snap.target = {yaw: ch.target.yaw, pitch: ch.target.pitch};
    if(ch.name==='head'&&ch.confirmedTarget)Object.assign(snap,{confirmedTarget:{...ch.confirmedTarget},confirmedAt:ch.confirmedAt,confirmedCommandId:ch.confirmedCommandId});
    return snap;
  }
  function snapshot() {
    let state = 'idle';
    const profileOk = current?.rig?.profile === DEVICE_PROFILE;
    if (closed) state = 'closed';
    else if (error) state = 'error';
    else if (!current) state = 'idle';
    else if (!profileOk) state = 'disabled';
    else if (current.enabled === true) state = 'active';
    else if (current.manualHeadPreview === true) state = 'manual_preview';
    else state = 'paused';
    return {state, head: channelSnapshot(channels.head), expression: channelSnapshot(channels.expression), error};
  }
  function notify() {
    if (notifying) { notifyAgain = true; return; } // re-entrancy guard: coalesce
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      try { onChange(snapshot()); } catch { /* Root owner's publish must not crash the output path. */ }
      if (notifyAgain) { notifyAgain = false; notify(); }
    });
  }

  function clearChannelTimer(ch) {
    if (ch.timer) { clearTimeout(ch.timer); ch.timer = null; }
  }
  function armExpiry(ch, expiresAt) {
    clearChannelTimer(ch);
    const delay = Math.min(MAX_TIMER_MS, Math.max(1, expiresAt - clock()));
    ch.timer = setTimeout(() => {
      ch.timer = null;
      evaluate(ch); // lease reached its absolute end: re-check and stop if still unextended
    }, delay);
    if (typeof ch.timer.unref === 'function') ch.timer.unref();
  }

  function headDesired(state, now) {
    const until = state.body.leaseEnds.head;
    if (until <= now) return null;
    const head = state.body.head;
    if (Math.abs(head.yaw) > HEAD_YAW_LIMIT || Math.abs(head.pitch) > HEAD_PITCH_LIMIT) {
      return {invalid: 'head_out_of_range'}; // reject: never silently clamp out-of-range poses
    }
    const remaining = until - now;
    if (remaining < MIN_HEAD_REMAINING_MS) return null; // too late to send; expiry timer will stop the channel
    return {
      commandId: typeof state.body.headCommandId === 'string' ? state.body.headCommandId : null,
      expiresAt: until,
      params: {yaw: head.yaw, pitch: head.pitch},
      payload: {yaw: head.yaw, pitch: head.pitch, durationMs: Math.min(state.personOrientation?.commandId===state.body.headCommandId?state.personOrientation.moveMs??300:state.attention?.focus?200:MAX_HEAD_DURATION_MS, Math.max(100,Math.floor(remaining)-100)), expiresAt: until,...(state.personOrientation?.commandId===state.body.headCommandId&&Number.isFinite(state.personOrientation.commandBasisAt)?{startBefore:state.personOrientation.commandBasisAt+800}:{})}
    };
  }
  function expressionDesired(state, now) {
    const expressionUntil = state.body.leaseEnds.expression;
    const gazeUntil = state.body.leaseEnds.gaze;
    const expressionActive = expressionUntil > now;
    const gazeActive = gazeUntil > now;
    const feedback=state.feedback??projectInteractionFeedback(state);
    const cognitiveIcons=[];
    const displayCode=projectFaceFeedback(feedback).code;
    const statusFields=displayCode?{statusCode:displayCode,cognitiveIcons}:cognitiveIcons.length?{statusCode:'none',cognitiveIcons}:{};
    const thought=state.userFeedback;
    const userMessage=state.enabled&&state.personOrientation?.suppressFeedback!==true&&thought?.epoch===state.epoch&&thought?.deskId===state.companion?.profile?.deskId&&thought?.expiresAt>now&&typeof thought.message==='string'&&Array.from(thought.message).length<=16?{id:thought.id,text:thought.message,createdAt:thought.createdAt,expiresAt:thought.expiresAt}:null;
    const messageFields=userMessage?{userMessage}:{};
    const displayEyes=eyes=>({...eyes,color:'#BFF478'});
    if ((!expressionActive && !gazeActive)||!state.enabled) {
      if(state.device?.configured!==true)return null;
      // A neutral operating face is presentation state, never an inferred emotion
      // or a continuation of a model/reminder receipt. Fixed host heartbeat cap.
      if(!presencePulse||presencePulse.epoch!==state.epoch||now>=presencePulse.expiresAt)return null;
      const eyes=displayEyes({gazeX:0,gazeY:0,openness:state.enabled===true&&!['paused','resting','manual','unavailable'].includes(feedback.code) ? .72 : .18,tilt:0,roundness:.8,color:'#BFF478'});
      return {commandId:'host-presence',expiresAt:presencePulse.expiresAt,params:{eyes,icon:'none',...statusFields,...messageFields},payload:{eyes,icon:'none',...statusFields,...messageFields,expiresAt:presencePulse.expiresAt}};
    }
    // Only still-active original expression/gaze leases; a head lease never becomes an expression lease.
    const expiresAt = Math.max(expressionActive ? expressionUntil : 0, gazeActive ? gazeUntil : 0);
    const commandId = expressionActive ? state.body.expressionCommandId : state.body.gazeCommandId;
    return {
      commandId: typeof commandId === 'string' ? commandId : null,
      expiresAt,
      params: {
        expressionCommandId: state.body.expressionCommandId ?? null,
        gazeCommandId: state.body.gazeCommandId ?? null,
        eyes: displayEyes(state.body.eyes),
        icon: 'none',...statusFields,...messageFields
      },
      payload: {eyes: displayEyes(state.body.eyes), icon: 'none', ...statusFields,...messageFields, expiresAt}
    };
  }
  function signatureOf(desired) {
    return JSON.stringify([desired.commandId, desired.expiresAt, desired.params]); // durationMs is derived, never a change trigger
  }

  function currentIdsFor(ch) {
    if (!current) return [];
    const body = current.body;
    const ids = ch.name === 'head' ? [body.headCommandId] : [body.expressionCommandId, body.gazeCommandId];
    return ids.filter(id => typeof id === 'string');
  }
  function stillValid(ch, token, now) {
    if (closed || halted) return false;
    if (token.run !== run || token.epoch !== epoch || token.cycle !== ch.cycle) return false;
    if (!current || now >= token.expiresAt) return false;
    return token.commandId === null || (token.commandId==='host-presence'&&(current.enabled||statusDisplay(current))&&current.device?.configured===true) || currentIdsFor(ch).includes(token.commandId);
  }

  function send(ch, desired, signature) {
    const now = clock();
    const token = {cycle: ch.cycle, run, epoch, commandId: desired.commandId, expiresAt: desired.expiresAt,...(ch.name==='head'?{target:{...desired.params}}:{})};
    if (!stillValid(ch, token, now)) return;
    ch.active = true;
    hadActivity = true;
    ch.inFlight = {token, signature};
    ch.status = 'host_intent';
    ch.commandId = desired.commandId;
    if(ch.name==='expression')ch.userMessage=null;
    ch.at = now;
    if (ch.name === 'head') ch.target = {yaw: desired.params.yaw, pitch: desired.params.pitch};
    notify();
    const timeoutMs = Math.max(1000, Math.min(MAX_REQUEST_TIMEOUT_MS, desired.expiresAt - now));
    let promise;
    try {
      promise = bridge.request(ch.name, desired.payload, {timeoutMs});
    } catch (err) {
      settle(ch, token, err, null);
      return;
    }
    Promise.resolve(promise).then(result => settle(ch, token, null, result), err => settle(ch, token, err, null));
  }
  function settle(ch, token, err, result) {
    if (ch.inFlight?.token !== token) return; // late ack: never changes the new run's state
    const signature = ch.inFlight.signature;
    ch.inFlight = null;
    if (err) {
      error = asCode(err?.code ?? err?.message);
      ch.lastSignature = signature; // it was sent; never hammer the device with identical retries
    } else if (stillValid(ch, token, clock())) {
      ch.lastSignature = signature;
      if(ch.name==='head'&&result?.status==='completed'){ch.confirmedTarget=token.target;ch.confirmedAt=clock();ch.confirmedCommandId=token.commandId;}
      ch.status = result?.status === 'completed' ? 'job_completed' : result?.status === 'device_acknowledged' ? 'device_acknowledged' : result?.status === 'stopped' ? 'stopped' : 'unconfirmed';
      ch.at = clock();
      const receipt=result?.userMessage;if(ch.name==='expression'&&receipt&&typeof receipt.id==='string'&&receipt.id.length<=100&&['device_acknowledged','unavailable','expired'].includes(receipt.status)){ch.userMessage={id:receipt.id,status:receipt.status};if(Number.isSafeInteger(receipt.page)&&receipt.page>0&&receipt.page<=16)ch.userMessage.page=receipt.page;if(Number.isSafeInteger(receipt.pageCount)&&receipt.pageCount>0&&receipt.pageCount<=16)ch.userMessage.pageCount=receipt.pageCount;if(typeof receipt.reason==='string'&&/^[a-z_]{1,64}$/.test(receipt.reason))ch.userMessage.reason=receipt.reason;if(typeof receipt.complete==='boolean')ch.userMessage.complete=receipt.complete;if(typeof receipt.rendererVersion==='string'&&/^[a-z0-9_-]{1,64}$/.test(receipt.rendererVersion))ch.userMessage.rendererVersion=receipt.rendererVersion;if(typeof receipt.rendering==='string'&&/^[a-z_]{1,64}$/.test(receipt.rendering))ch.userMessage.rendering=receipt.rendering;const diagnostic=receipt.diagnostics;if(diagnostic&&typeof diagnostic==='object'){const safe={};for(const key of ['strokeCount','pointCount','maxStrokePoints','remainingStrokeCount','lineCount','fontSize','characterCount'])if(Number.isSafeInteger(diagnostic[key])&&diagnostic[key]>=0&&diagnostic[key]<100000)safe[key]=diagnostic[key];if(typeof diagnostic.codepoint==='string'&&/^U\+[A-F0-9]{4,6}$/.test(diagnostic.codepoint))safe.codepoint=diagnostic.codepoint;if(typeof diagnostic.failure==='string'&&/^[a-z_]{1,40}$/.test(diagnostic.failure))safe.failure=diagnostic.failure;if(typeof diagnostic.isolatedFallback==='boolean')safe.isolatedFallback=diagnostic.isolatedFallback;ch.userMessage.diagnostics=safe;}}
    }
    notify();
    evaluate(ch); // deliver whatever the newest accepted state requires (re-delivery after revocation)
  }
  function enqueue(ch, desired) {
    const signature = signatureOf(desired);
    if (ch.inFlight) {
      if (ch.inFlight.signature !== signature) ch.queued = signature; // marker; newest desired recomputed on settle
      return;
    }
    if (ch.lastSignature === signature) return; // identical params/receipt: no periodic repeats
    send(ch, desired, signature);
  }
  function stopChannel(ch, reason) {
    ch.queued = null;
    if(ch.name==='expression')ch.userMessage=null;
    ch.cycle++; // invalidate any in-flight token so its ack cannot revive this channel
    ch.inFlight = null;
    ch.lastSignature = null;
    if (!ch.active) return; // nothing was ever sent: no stop traffic
    ch.active = false;
    ch.status = 'stopped';
    ch.at = clock();
    try {
      Promise.resolve(bridge.request('stop', {channels: [ch.name]}, {timeoutMs: STOP_TIMEOUT_MS})).catch(() => {});
    } catch { /* Stop is best effort; the lease itself bounds the device. */ }
    notify();
  }
  function evaluate(ch) {
    if (closed || halted) return;
    clearChannelTimer(ch);
    const state = current;
    if (!state) return;
    const now = clock();
    const profileOk = state.rig?.profile === DEVICE_PROFILE;
    const enabled = state.enabled === true;
    const manualHead = state.manualHeadPreview === true;
    let desired = null;
    let invalid = null;
    if (profileOk) {
      if (ch.name === 'head') {
        if (enabled || manualHead) { // paused: manual head preview may move the head, never the eyes
          const candidate = headDesired(state, now);
          if (candidate?.invalid) invalid = candidate.invalid;
          else desired = candidate;
        }
      } else if (enabled||statusDisplay(state)) {
        desired = expressionDesired(state, now);
      }
    }
    if (invalid) { error = invalid; notify(); }
    if (!desired) { stopChannel(ch, invalid ? 'rejected' : 'lease_ended'); return; }
    armExpiry(ch, desired.expiresAt);
    enqueue(ch, desired);
  }

  function revokeAll(reason) {
    run++;presencePulse=null;
    for (const ch of channelList) {
      clearChannelTimer(ch);
      ch.queued = null;
      ch.inFlight = null;
      ch.cycle++;
      ch.lastSignature = null;
      if (ch.active) { ch.active = false; ch.status = 'stopped'; ch.at = clock(); }
    }
    if (hadActivity) {
      hadActivity = false;
      try {
        Promise.resolve(bridge.stop({channels: BRIDGE_CHANNELS, reason: asCode(reason, 'stopped')})).catch(() => {});
      } catch { /* Stop is best effort. */ }
    }
  }

  function accept(state) {
    if (closed) return snapshot();
    error = null;
    const valid = readState(state);
    if (!valid) { error = 'invalid_state'; notify(); return snapshot(); }
    halted = false;
    if (epoch !== null && valid.epoch !== epoch) revokeAll('epoch_changed');
    else if (current && current.enabled === true && valid.enabled !== true) {
      if (valid.manualHeadPreview === true) stopChannel(channels.expression, 'paused'); // head preview keeps its channel
      else revokeAll('paused');
    }
    epoch = valid.epoch;
    if(valid.device?.connected===false){channels.head.confirmedTarget=null;channels.head.confirmedAt=null;channels.head.confirmedCommandId=null;}
    current = valid;
    const now=clock();if((valid.enabled||statusDisplay(valid))&&valid.device?.configured===true&&(!presencePulse||presencePulse.epoch!==valid.epoch||now>=presencePulse.refreshAt))presencePulse={epoch:valid.epoch,expiresAt:now+1800,refreshAt:now+900};
    for (const ch of channelList) evaluate(ch);
    notify();
    return snapshot();
  }
  function stop(reason = 'stopped') {
    if (closed) return snapshot();
    halted = true;
    error = null;
    revokeAll(reason);
    for (const ch of channelList) {
      if (ch.status !== 'idle' && ch.status !== 'stopped') { ch.status = 'stopped'; ch.at = clock(); }
    }
    notify();
    return snapshot();
  }
  function close() {
    if (closed) return snapshot(); // idempotent; the bridge itself is owned by the caller
    closed = true;
    revokeAll('closed');
    notify();
    return snapshot();
  }

  return {accept, stop, snapshot, close};
}
