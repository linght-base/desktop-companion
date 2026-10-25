// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
async function signalRequest(path, {body, keepalive = false} = {}) {
  const response = await fetch(path, {method: 'POST', credentials: 'same-origin', keepalive,
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const value = await response.json();
  if (!response.ok) throw new Error(response.status === 404 ? '本机服务还未准备好接收实时画面' : '画面分享未成功，请检查连接后重试');
  return value;
}

/** Only a privacy-masked canvas video track is sent. No audio, STUN service or snapshot fallback. */
export function createVideoStreamer({sampler, onStatus = () => {}, onStats = () => {},
  PeerConnection = globalThis.RTCPeerConnection, request = signalRequest, clock = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let generation = 0;
  let current = null;
  const isCurrent = session => current === session && !session.closed && session.generation === generation;
  const stopRemote = streamId => {
    if (!streamId) return;
    // A late old answer is retired by ID, never by a global stop that could stop a replacement.
    Promise.resolve(request('/api/video/stop', {body: {streamId}, keepalive: true})).catch(() => {});
  };
  function retire(session) {
    if (!session || session.closed) return;
    session.closed = true;
    session.abort.abort();
    clearTimer(session.statsTimer);
    session.pc?.close();
    session.feed?.stop();
    stopRemote(session.streamId);
  }
  function stop() {
    generation++;
    const old = current;
    current = null;
    retire(old);
    onStatus({state: 'stopped'});
  }
  function waitForIce(session) {
    const pc = session.pc;
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const clean = () => {pc.removeEventListener('icegatheringstatechange', changed);session.abort.signal.removeEventListener('abort', aborted);clearTimer(timeout);};
      const changed = () => {if (pc.iceGatheringState === 'complete') {clean();resolve();}};
      const aborted = () => {clean();reject(new DOMException('实时画面分享已停止', 'AbortError'));};
      const timeout = setTimer(() => {clean();reject(new Error('实时画面连接超时，请重试'));}, 10000);
      pc.addEventListener('icegatheringstatechange', changed);
      session.abort.signal.addEventListener('abort', aborted, {once: true});
      if (session.abort.signal.aborted) aborted();
      else changed();
    });
  }
  async function pollStats(session) {
    if (!isCurrent(session)) return;
    try {
      const reports = await session.pc.getStats();
      if (!isCurrent(session)) return;
      for (const report of reports.values()) if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
        onStats({streamId: session.streamId, framesEncoded: report.framesEncoded ?? 0,
          bytesSent: report.bytesSent ?? 0, packetsSent: report.packetsSent ?? 0,
          frameRate: report.framesPerSecond ?? null});
      }
    } catch { /* The peer may have closed while getStats was pending. */ }
    if (isCurrent(session)) session.statsTimer = setTimer(() => pollStats(session), 1000);
  }
  async function start({epoch} = {}) {
    stop();
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('缺少当前陪伴代次，请重新连接后再试');
    if (typeof PeerConnection !== 'function') {
      const error = new Error('当前浏览器暂不支持实时画面分享，请更换浏览器后重试');
      onStatus({state: 'error', error: error.message});throw error;
    }
    const session = {generation, epoch, startedAt: clock(), closed: false, abort: new AbortController(), feed: null, pc: null, streamId: null, statsTimer: null};
    current = session;
    onStatus({state: 'connecting'});
    try {
      session.feed = sampler.createMaskedFeed({frameRate: 12});
      const tracks = session.feed.stream.getVideoTracks();
      if (tracks.length !== 1 || session.feed.stream.getAudioTracks().length) throw new Error('画面分享只能包含遮挡后的视频，不能包含音频');
      session.pc = new PeerConnection({iceServers: []});
      session.pc.addEventListener('connectionstatechange', () => {
        if (!isCurrent(session)) return;
        const state = session.pc.connectionState;
        if (state === 'connected') {onStatus({state: 'streaming', streamId: session.streamId});pollStats(session);}
        else if (['failed','disconnected','closed'].includes(state)) {
          current = null;retire(session);onStatus({state: 'error', error: '实时画面已断开；请重新开启分享，不会自动恢复'});
        }
      });
      session.pc.addTransceiver(tracks[0], {direction: 'sendonly', streams: [session.feed.stream]});
      const offer = await session.pc.createOffer();
      if (!isCurrent(session)) return false;
      await session.pc.setLocalDescription(offer);
      if (!isCurrent(session)) return false;
      await waitForIce(session);
      if (!isCurrent(session)) return false;
      // Keep the finite signaling response observable after a local stop, so a late allocated
      // server stream can still be closed by its returned ID. No media remains live meanwhile.
      const answer = await request('/api/video/offer', {body: {type: 'offer', sdp: session.pc.localDescription.sdp,
        epoch, startedAt: session.startedAt, width: session.feed.width, height: session.feed.height, frameRate: 12}});
      if (typeof answer?.streamId === 'string') session.streamId = answer.streamId;
      if (!isCurrent(session)) {stopRemote(session.streamId);return false;}
      if (answer?.epoch !== epoch) throw new Error('画面连接已过期，请重新开启分享');
      if (answer.type !== 'answer' || typeof answer.sdp !== 'string' || !answer.sdp || !session.streamId) throw new Error('画面连接未成功，请重新开启分享');
      await session.pc.setRemoteDescription({type: 'answer', sdp: answer.sdp});
      if (!isCurrent(session)) return false;
      // An accepted answer alone is not a connected media path.
      if (session.pc.connectionState !== 'connected') onStatus({state: 'connecting', streamId: session.streamId});
      return true;
    } catch (error) {
      if (!isCurrent(session)) {retire(session);return false;}
      current = null;retire(session);
      onStatus({state: 'error', error: error.message});
      throw error;
    }
  }
  return {start, stop, get active() {return Boolean(current && !current.closed);}};
}
