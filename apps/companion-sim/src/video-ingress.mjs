// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const MAX_SDP = 131072;
const MAX_IPC_LINE = 450000;
const MAX_JPEG = 300000;
const MAX_COUNT = 1_000_000_000;
const helperPath = fileURLToPath(new URL('../../../scripts/companion_webrtc.py', import.meta.url));
const defaultPython = fileURLToPath(new URL('../../../.runtime/companion-webrtc-venv/bin/python', import.meta.url));
const failure = (reason, status = 400) => Object.assign(new Error(reason), {status});
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const count = v => Number.isInteger(v) && finite(v, 0, MAX_COUNT);

/** One local WebRTC video receiver. HTTP authorization remains the caller's responsibility. */
export function createVideoIngress({controller, clock = Date.now, pythonPath = process.env.COMPANION_WEBRTC_PYTHON ?? defaultPython, onChange = () => {}}) {
  let session = null;
  let closed = false;
  let lastChange = -Infinity;
  let state = {status: 'idle', transport: 'webrtc', streamId: null, startedAt: null, sampledObservations: 0, receivedFrames: 0, decodedFrames: 0, droppedFrames: 0, bufferedFrames: 0, lastFrameAt: null, reason: null};
  const children = new Set();
  const snapshot = () => ({...state});
  function setPresenceDetection(enabled){
    if(typeof enabled!=='boolean'||!session||!current(session)||session.presenceDetection===enabled)return;
    session.presenceDetection=enabled;
    session.child.stdin.write(JSON.stringify({type:'presence_detection',enabled})+'\n');
  }
  function changed(force = false) {
    if (!force && clock() - lastChange < 1000) return;
    lastChange = clock();
    onChange(snapshot());
  }
  const current = s => !closed && session === s && !controller.closed && controller.enabled && controller.epoch === s.epoch;
  function stop(reason = 'stopped', status = 'stopped') {
    const previous = session;
    controller.stopAttention?.(reason);
    session = null; // Revoke authority before any child/transport callbacks can execute.
    if (previous) {
      clearTimeout(previous.timeout);
      previous.frames.length = 0;
      previous.visualSignature = null;
      previous.buffer = '';
      previous.reject?.(failure(reason, 409));
      previous.reject = null;
      previous.child.stdin.destroy();
      previous.child.kill('SIGTERM');
      const kill = setTimeout(() => { if (children.has(previous.child)) previous.child.kill('SIGKILL'); }, 1000);
      kill.unref();
      previous.child.once('close', () => clearTimeout(kill));
    }
    state = {...state, status, bufferedFrames: 0, reason: String(reason).replace(/[^a-z_]/g, '').slice(0, 60) || 'stopped'};
    changed(true);
  }
  function fail(s, reason) { if (session === s) stop(reason, 'error'); }
  function checkAuthority() {
    if (session && !current(session)) stop('video_epoch_changed');
  }
  controller.on?.('state', checkAuthority);
  function frame(s, value) {
    if (!current(s)) { checkAuthority(); return; }
    if (!count(value.receivedFrames) || !count(value.decodedFrames) || !count(value.droppedFrames) || value.receivedFrames < value.decodedFrames || value.droppedFrames > value.receivedFrames || value.decodedFrames < state.decodedFrames || value.droppedFrames < state.droppedFrames || !finite(value.ptsMs, 0, 86400000) || !Number.isInteger(value.width) || !Number.isInteger(value.height) || !finite(value.width, 1, s.input.width) || !finite(value.height, 1, s.input.height)) return fail(s, 'invalid_video_frame');
    if (typeof value.data !== 'string' || value.data.length > 400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return fail(s, 'invalid_video_frame');
    if (typeof value.visualSignature !== 'string' || value.visualSignature.length !== 3072 || !/^[A-Za-z0-9+/]{3072}$/.test(value.visualSignature)) return fail(s, 'invalid_video_frame');
    const signature = Buffer.from(value.visualSignature, 'base64');
    if (signature.length !== 2304 || signature.toString('base64') !== value.visualSignature) return fail(s, 'invalid_video_frame');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length > MAX_JPEG || bytes.length < 4 || bytes.toString('base64') !== value.data || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return fail(s, 'invalid_video_frame');
    if (s.firstPts === null) {
      s.firstPts = value.ptsMs;
      // RTP supplies relative presentation time, not camera wall time. Keep that uncertainty explicit.
      s.startedAt = Math.max(s.input.startedAt, clock() - Math.ceil(1000 / s.input.frameRate));
    }
    const at = Math.round(s.startedAt + value.ptsMs - s.firstPts);
    if (at > clock() + 1000 || clock() - at > 10000 || at < s.startedAt) return fail(s, 'video_timing_out_of_range');
    if (s.lastPts !== null && value.ptsMs <= s.lastPts) return fail(s, 'video_pts_out_of_order');
    if (Array.isArray(value.gaps)) {
      for (const gap of value.gaps.slice(0, 16)) {
        if (!finite(gap.startPtsMs, s.firstPts, value.ptsMs) || !finite(gap.endPtsMs, gap.startPtsMs, value.ptsMs)) return fail(s, 'invalid_video_gap');
        s.gaps.push({startAt: Math.round(s.startedAt + gap.startPtsMs - s.firstPts), endAt: Math.round(s.startedAt + gap.endPtsMs - s.firstPts), reason: 'video_frame_gap'});
      }
      s.gaps = s.gaps.slice(-16);
    }
    // Position hints expire sooner than historical image evidence; omit old hints without relabeling absence or killing valid video.
    if(value.sight&&clock()-at<=1000){
      try{controller.ingestSight?.({...value.sight,at,streamId:s.id},{admittedEpoch:s.epoch});}catch{return fail(s,'invalid_local_sight');}
    }
    s.lastPts = value.ptsMs;
    s.visualSignature = {frameAt: at, pixels: value.visualSignature};
    s.frames.push({at, mimeType: 'image/jpeg', data: value.data, width: value.width, height: value.height});
    if (s.frames.length > 4) s.frames.shift();
    s.lastReceivedAt = clock();
    state = {...state, status: 'streaming', startedAt: s.startedAt, receivedFrames: value.receivedFrames, decodedFrames: value.decodedFrames, droppedFrames: value.droppedFrames, bufferedFrames: s.frames.length, lastFrameAt: at, reason: null};
    changed();
  }
  function consume(s, data) {
    if (!current(s)) { checkAuthority(); return; }
    s.buffer += data.toString('utf8');
    // Limit each line and the in-progress line, allowing ordinary OS chunk coalescing.
    let end;
    while ((end = s.buffer.indexOf('\n')) !== -1) {
      if (end > MAX_IPC_LINE) return fail(s, 'video_receiver_overflow');
      const line = s.buffer.slice(0, end); s.buffer = s.buffer.slice(end + 1);
      let value;
      try { value = JSON.parse(line); } catch { return fail(s, 'invalid_video_receiver_message'); }
      if (!current(s)) return;
      if (value.type === 'answer') {
        if (typeof value.sdp !== 'string' || value.sdp.length > MAX_SDP || !value.sdp.includes('m=video')) return fail(s, 'invalid_video_answer');
        clearTimeout(s.timeout); s.timeout = null;
        const resolve = s.resolve; s.resolve = null; s.reject = null;
        resolve?.({type: 'answer', sdp: value.sdp, streamId: s.id, epoch: s.epoch});
      } else if (value.type === 'frame') frame(s, value);
      else if (value.type === 'error') fail(s, ['webrtc_runtime_unavailable', 'invalid_video_offer', 'video_track_ended', 'video_track_stalled', 'invalid_video_dimensions', 'video_receiver_overflow', 'video_peer_failed'].includes(value.reason) ? value.reason : 'video_receiver_failed');
      else if (value.type === 'closed') stop('video_peer_closed');
    }
    if (s.buffer.length > MAX_IPC_LINE) fail(s, 'video_receiver_overflow');
  }
  async function negotiate(input, {admittedEpoch} = {}) {
    if (closed || controller.closed) throw failure('video_ingress_closed', 409);
    if (admittedEpoch !== controller.epoch || input?.epoch !== admittedEpoch) throw failure('video_epoch_changed', 409);
    if (!controller.enabled) throw failure('video_controller_inactive', 409);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['type', 'sdp', 'epoch', 'width', 'height', 'frameRate', 'startedAt'].includes(k)) || input.type !== 'offer' || typeof input.sdp !== 'string' || input.sdp.length > MAX_SDP || !input.sdp.startsWith('v=0') || !Number.isInteger(input.width) || !Number.isInteger(input.height) || !finite(input.width, 1, 640) || !finite(input.height, 1, 480) || !finite(input.frameRate, 1, 30) || !Number.isSafeInteger(input.startedAt) || !finite(input.startedAt, Math.max(0, clock() - 30000), clock() + 1000)) throw failure('invalid_video_offer');
    const media = input.sdp.split(/\r?\n/).filter(line => line.startsWith('m='));
    if (media.length !== 1 || !media[0].startsWith('m=video ')) throw failure('video_only_media_required');
    if (session) throw failure('video_stream_active', 409);
    const child = spawn(pythonPath, ['-u', helperPath], {stdio: ['pipe', 'pipe', 'pipe'], env: {PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1'}});
    const s = {id: randomUUID(), epoch: admittedEpoch, input: {...input}, child, buffer: '', frames: [], gaps: [], firstPts: null, lastPts: null, lastReceivedAt: clock(), lastSubmittedAt: -Infinity, submittedFrameAt: null};
    session = s; children.add(child);
    state = {status: 'connecting', transport: 'webrtc', streamId: s.id, startedAt: null, sampledObservations: 0, receivedFrames: 0, decodedFrames: 0, droppedFrames: 0, bufferedFrames: 0, lastFrameAt: null, reason: null};
    const result = new Promise((resolve, reject) => { s.resolve = resolve; s.reject = reject; });
    s.timeout = setTimeout(() => fail(s, 'video_negotiation_timeout'), 12000); s.timeout.unref();
    child.stdout.on('data', data => consume(s, data));
    child.stderr.on('data', () => {}); // Never publish SDP, ICE credentials, environment, paths, or decoder logs.
    child.stdin.on('error', () => fail(s, 'video_receiver_failed'));
    child.on('error', () => fail(s, 'webrtc_runtime_unavailable'));
    child.on('close', () => { children.delete(child); if (session === s) fail(s, 'video_receiver_closed'); });
    child.stdin.write(JSON.stringify({...input, maxOutputFps: 8}) + '\n');
    changed(true);
    return result;
  }
  function pulse() {
    checkAuthority();
    const s = session;
    if (!s || !current(s)) return;
    if (clock() - s.lastReceivedAt > (state.status === 'connecting' ? 15000 : 5000)) { fail(s, 'video_track_stalled'); return; }
    if(controller.presenceRest?.snapshot().resting)return;
    if (!s.frames.length || clock() - s.lastSubmittedAt < 500 || s.submittedFrameAt === s.frames.at(-1).at) return;
    const frames = s.frames.filter(f => clock() - f.at <= 10000);
    if (!frames.length) return;
    const start = frames[0].at, end = frames.at(-1).at;
    const rig=controller.rigManager?.snapshot();
    const view=rig?.profile==='integrated-device'?{yaw:rig.camera.pose.yaw,pitch:rig.camera.pose.pitch,physicalCameraMoves:true,poseSource:'commanded'}:{yaw:0,pitch:0,physicalCameraMoves:false};
    const observation = {id: randomUUID(), at: end, source: 'camera', coverage: 'partial', view, frames: frames.map(f => ({...f})), stream: {id: s.id, transport: 'webrtc', startedAt: s.startedAt, windowStartAt: start, windowEndAt: end, receivedFrames: state.receivedFrames, decodedFrames: state.decodedFrames, droppedFrames: state.droppedFrames, gaps: s.gaps.filter(g => g.endAt > start && g.startAt < end).map(g => ({...g, startAt: Math.max(start, g.startAt), endAt: Math.min(end, g.endAt)})), timing: 'estimated', timingUncertaintyMs: 1000}};
    try {
      const receipt = controller.ingestVideoObservation(observation, {admittedEpoch: s.epoch, visualSignature: s.visualSignature});
      if (receipt?.accepted === false) { fail(s, 'video_observation_rejected'); return; }
      s.lastSubmittedAt = clock(); s.submittedFrameAt = end;
      state = {...state, sampledObservations: state.sampledObservations + 1}; changed();
    } catch { fail(s, 'video_observation_rejected'); }
  }
  const timer = setInterval(pulse, 100); timer.unref();
  return {
    snapshot, negotiate, stop,setPresenceDetection,
    stopStream(streamId, reason = 'client_stop') { if (!session || session.id !== streamId) return false; stop(reason); return true; },
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer); controller.removeListener?.('state', checkAuthority); stop('closed');
      await Promise.all([...children].map(child => new Promise(resolve => {
        if (!children.has(child)) return resolve();
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1200);
        timeout.unref(); child.once('close', () => { clearTimeout(timeout); resolve(); });
      })));
    }
  };
}
