// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const CLEAR_FACE = .9;
const PLAUSIBLE_FACE = .6;
const DETECTOR = 'yunet-2023mar';
const FRESH_SAMPLE_MS = 2500;
const MAX_SAMPLES = 2048;
const defaults = {absentAfterMs: 10000, probeEveryMs: 15000, probeWindowMs: 1200};
const finite = Number.isFinite;

/**
 * Generic no-person rest with periodic probe detection. Pure state: the host owns
 * the detector toggle (driven by snapshot().shouldDetect) and calls tick; no timers
 * live here. Absence is only ever concluded from multiple recent ready no-face
 * samples — an unavailable/unknown detector, expired evidence, or a network gap is
 * always 'unknown', never absence.
 */
export function createPresenceRest({clock = Date.now, absentAfterMs, probeEveryMs, probeWindowMs} = {}) {
  const p = {...defaults};
  if (finite(absentAfterMs)) p.absentAfterMs = Math.min(120000, Math.max(1000, absentAfterMs));
  if (finite(probeEveryMs)) p.probeEveryMs = Math.min(600000, Math.max(2000, probeEveryMs));
  if (finite(probeWindowMs)) p.probeWindowMs = Math.min(p.probeEveryMs, Math.max(200, probeWindowMs));
  let epoch = null, enabled = true, streaming = null;
  let streamId = null, samples = [], detector = null;
  let lastPersonAt = null, lastCheckedAt = null, lastSampleAt = null;
  let resting = false, probeStartedAt = null, nextProbeAt = null;
  let status = 'unknown', reason = 'initial', epochChanged = false;
  const clear = why => {streamId = null; samples = []; detector = null; lastPersonAt = null; lastSampleAt = null; resting = false; probeStartedAt = null; nextProbeAt = null; status = 'unknown'; reason = why;};
  function authorize(context = {}) {
    epochChanged = false;
    if (!Number.isSafeInteger(context.epoch) || context.epoch < 0) return 'invalid_epoch';
    if (epoch !== null && context.epoch < epoch) return 'stale_epoch';
    if (epoch !== context.epoch) {epoch = context.epoch; epochChanged = true; clear('epoch_changed');}
    enabled = context.enabled === true;
    return null;
  }
  const prune = now => {samples = samples.filter(s => s.at <= now + 250 && now - s.at <= p.absentAfterMs + FRESH_SAMPLE_MS + p.probeWindowMs);};
  const noFaceRun = () => {
    const run = [];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].conf >= PLAUSIBLE_FACE) break;
      if(run.length&&run.at(-1).at-samples[i].at>FRESH_SAMPLE_MS)break;
      run.push(samples[i]);
    }
    return run.reverse();
  };
  function evaluate(now) {
    if(!enabled)return;
    if (resting) {
      // Rest cycles probes; only a fresh clear face (ingest) exits rest. A failed
      // probe preserves the previous reason and is never a confirmed absence.
      if (probeStartedAt !== null) {
        if (now - probeStartedAt < p.probeWindowMs) {status = 'probing'; return;}
        const covered = detector === null && samples.some(s => s.at >= probeStartedAt && s.at <= now + 250);
        const why = detector !== null ? `detector_${detector}` : 'probe_inconclusive';
        probeStartedAt = null; nextProbeAt = now + p.probeEveryMs;
        if (covered) {status = 'absent'; reason = 'probe_confirmed_absence';}
        else {status = 'resting'; reason = why;}
        return;
      }
      if (nextProbeAt === null) nextProbeAt = now + p.probeEveryMs;
      if (streaming !== false && now >= nextProbeAt) {probeStartedAt = now; status = 'probing'; reason = 'probe_started';}
      else if (status === 'probing') status = 'resting';
      return;
    }
    if (!enabled) return; // paused: freeze, never autowake
    if (streaming === false) {status = 'unknown'; reason = 'stream_inactive'; return;}
    if (detector !== null) {status = 'unknown'; reason = `detector_${detector}`; return;}
    const run = noFaceRun(), latest = run.at(-1);
    if (run.length >= 2 && latest.at - run[0].at >= p.absentAfterMs && now - latest.at <= FRESH_SAMPLE_MS) {
      resting = true; status = 'resting'; reason = 'no_face_span'; probeStartedAt = null; nextProbeAt = now + p.probeEveryMs;
      return;
    }
    if (lastPersonAt !== null && now - lastPersonAt < p.absentAfterMs) {status = 'present'; reason = 'face_recent'; return;}
    const newest = samples.at(-1);
    if (newest && newest.conf >= PLAUSIBLE_FACE && now - newest.at <= FRESH_SAMPLE_MS) {status = 'unknown'; reason = 'uncertain_detection'; return;}
    if (lastSampleAt === null) {status = 'unknown'; reason = 'awaiting_detection'; return;}
    status = 'unknown';
    reason = !newest || now - newest.at > FRESH_SAMPLE_MS ? 'evidence_expired' : 'insufficient_evidence';
  }
  function ingest(input, context) {
    const denied = authorize(context); if (denied) return {accepted: false, reason: denied};
    if(!enabled)return {accepted:false,reason:'paused'};
    const now = clock(); lastCheckedAt = now;
    if (!input || !finite(input.at) || input.at > now + 250 || now - input.at > FRESH_SAMPLE_MS || typeof input.streamId !== 'string' || !input.streamId || input.streamId.length > 200 || !['ready', 'unavailable', 'error'].includes(input.status) || (input.detector !== undefined && typeof input.detector !== 'string') || !Array.isArray(input.targets) || input.targets.length > 8) return {accepted: false, reason: 'invalid_sight'};
    let conf = 0;
    for (const target of input.targets) {
      if (!finite(target?.confidence) || target.confidence < 0 || target.confidence > 1) return {accepted: false, reason: 'invalid_target'};
      conf = Math.max(conf, target.confidence);
    }
    if (streamId !== null && input.streamId !== streamId) clear('stream_changed');
    streamId = input.streamId; lastSampleAt = now;
    if (input.status !== 'ready' || (input.detector !== undefined && input.detector !== DETECTOR)) {
      detector = input.status === 'ready' ? 'unknown_detector' : input.status;
      samples=[];
      prune(now); evaluate(now);
      return {accepted: true};
    }
    detector = null;
    samples.push({at: input.at, conf});
    samples.sort((a, b) => a.at - b.at);
    samples = samples.slice(-MAX_SAMPLES);
    if (conf >= CLEAR_FACE) {
      lastPersonAt = input.at; resting = false; probeStartedAt = null; nextProbeAt = null; status = 'present'; reason = 'face_detected';
      return {accepted: true};
    }
    if (resting && conf >= PLAUSIBLE_FACE) {resting = false; probeStartedAt = null; nextProbeAt = null;}
    prune(now); evaluate(now);
    return {accepted: true};
  }
  function tick(context = {}) {
    const denied = authorize(context); if (denied) return {accepted: false, reason: denied};
    if (context.streaming === true) streaming = true; else if (context.streaming === false) streaming = false;
    const now = clock(); lastCheckedAt = now;
    if(!enabled)return snapshot();
    if(streaming!==false&&finite(context.personVisibleUntil)&&context.personVisibleUntil>now){
      resting=false;probeStartedAt=null;nextProbeAt=null;samples=[];status='present';reason='recent_visual_person';
    }else if (!epochChanged) {prune(now); evaluate(now);}
    return snapshot();
  }
  function snapshot() {
    return {status, resting, shouldDetect: enabled && epoch !== null && (resting ? probeStartedAt !== null : enabled), lastPersonAt, lastCheckedAt, nextProbeAt: probeStartedAt !== null ? probeStartedAt + p.probeWindowMs : nextProbeAt, streamId, reason, epoch};
  }
  function reset() {epoch = null; enabled = true; streaming = null; clear('reset');}
  return {ingest, tick, snapshot, reset};
}
