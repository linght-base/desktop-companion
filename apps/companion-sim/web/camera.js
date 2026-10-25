// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Browser-only pixels stay in memory. No audio is ever requested. */
export function createCameraSampler({video, canvas, mediaDevices = globalThis.navigator?.mediaDevices,
  upload, onStatus = () => {}, onFrame = () => {}, clock = Date.now,
  makeId = () => globalThis.crypto.randomUUID(), intervalMs = 1000 / 12,
  makeCanvas = () => globalThis.document?.createElement('canvas'),
  setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  let stream = null;
  let active = false;
  let starting = false;
  let epoch = 0;
  let timer = null;
  let inFlight = null;
  let masks = [];
  let previousPixels = null;
  const feeds = new Set();
  const context = canvas.getContext('2d', {willReadFrequently: true});
  const release = value => value?.getTracks().forEach(track => track.stop());

  function stop() {
    epoch++;
    active = false;
    starting = false;
    clearTimer(timer);
    timer = null;
    inFlight?.abort();
    for (const feed of [...feeds]) feed.stop();
    release(stream);
    stream = null;
    video.srcObject = null;
    previousPixels = null;
    onStatus({state: 'stopped'});
  }

  function setMasks(value) {
    if (!Array.isArray(value) || value.some(mask =>
      !['x', 'y', 'width', 'height'].every(key => Number.isFinite(mask[key])) ||
      mask.x < 0 || mask.y < 0 || mask.width <= 0 || mask.height <= 0 ||
      mask.x + mask.width > 1 || mask.y + mask.height > 1)) throw new Error('Invalid privacy mask');
    masks = value.map(mask => ({...mask}));
    previousPixels = null;
    if (active) drawPreview();
    for (const feed of feeds) feed.draw();
  }

  function drawMasked(target, ctx, drawable, width, height) {
    const scale = Math.min(1, 640 / width, 480 / height);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (target.width !== w) target.width = w;
    if (target.height !== h) target.height = h;
    ctx.drawImage(drawable, 0, 0, w, h);
    ctx.fillStyle = '#000000';
    for (const mask of masks) {
      const x = Math.floor(mask.x * w), y = Math.floor(mask.y * h);
      ctx.fillRect(x, y, Math.ceil((mask.x + mask.width) * w) - x, Math.ceil((mask.y + mask.height) * h) - y);
    }
  }

  function drawPreview() {
    if (!active || !video.videoWidth || !video.videoHeight) return false;
    drawMasked(canvas, context, video, video.videoWidth, video.videoHeight);
    onFrame({at: clock(), source: 'camera', change: null, coverage: masks.length ? 'partial' : 'visible', local: true});
    return true;
  }

  function createMaskedFeed({frameRate = 12} = {}) {
    if (!active || !video.videoWidth || !video.videoHeight) throw new Error('请先打开摄像头本地预览');
    if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 30) throw new Error('Invalid video frame rate');
    const target = makeCanvas();
    if (typeof target?.captureStream !== 'function') throw new Error('当前浏览器暂不支持实时画面分享，请更换浏览器后重试');
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('无法创建遮挡视频画布');
    let closed = false, drawingTimer = null, captured = null;
    const feed = {
      draw() {if (!closed && active) drawMasked(target, ctx, video, video.videoWidth, video.videoHeight);},
      stop() {if (closed) return; closed = true; clearTimer(drawingTimer); release(captured); feeds.delete(feed);}
    };
    try {
      // The first encoded frame is already masked; subsequent mask changes redraw synchronously.
      feed.draw();
      captured = target.captureStream(frameRate);
      if (captured.getAudioTracks().length || captured.getVideoTracks().length !== 1) throw new Error('遮挡视频必须只有一条视频轨，不能包含音频');
      const tickFeed = () => {if (closed || !active) return; feed.draw(); drawingTimer = setTimer(tickFeed, 1000 / frameRate);};
      drawingTimer = setTimer(tickFeed, 1000 / frameRate);
      feeds.add(feed);
      return {stream: captured, stop: feed.stop, width: target.width, height: target.height};
    } catch (error) {feed.stop(); throw error;}
  }

  async function captureDrawable(drawable, {source, width, height}) {
    if (inFlight) return false;
    if (!['camera', 'replay', 'synthetic'].includes(source)) throw new Error('Invalid frame source');
    if (!(width > 0 && height > 0)) return false;
    const generation = epoch;
    const controller = new AbortController();
    inFlight = controller;
    try {
      drawMasked(canvas, context, drawable, width, height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let change = null;
      if (previousPixels?.length === pixels.length) {
        let difference = 0;
        let samples = 0;
        for (let index = 0; index < pixels.length; index += 64) {
          difference += Math.abs(pixels[index] - previousPixels[index]);
          samples++;
        }
        change = samples ? difference / samples / 255 : 0;
      }
      previousPixels = new Uint8ClampedArray(pixels);
      const encoded = canvas.toDataURL('image/jpeg', 0.72);
      const data = encoded.split(',')[1];
      const bytes = data?.length * 3 / 4 - (data?.endsWith('==') ? 2 : data?.endsWith('=') ? 1 : 0);
      if (!data || bytes > 300 * 1024) throw new Error('Frame exceeds 300 KB; choose a smaller image');
      const at = clock();
      const observation = {id: makeId(), at, source, frames: [{at, mimeType: 'image/jpeg', data, width: canvas.width, height: canvas.height}],
        coverage: masks.length ? 'partial' : 'visible', view: {yaw: 0, pitch: 0, physicalCameraMoves: false}};
      onFrame({at, source, change, coverage: observation.coverage});
      await upload(observation, {signal: controller.signal});
      return generation === epoch && !controller.signal.aborted;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  async function sample() {
    if (!active) return false;
    return drawPreview();
  }

  async function tick(generation) {
    if (!active || generation !== epoch) return;
    try { await sample(); }
    catch (error) { if (generation === epoch && error.name !== 'AbortError') onStatus({state: 'error', error: error.message}); }
    if (active && generation === epoch) timer = setTimer(() => tick(generation), intervalMs);
  }

  async function start({deviceId} = {}) {
    if (active || starting) return false;
    stop();
    const generation = epoch;
    starting = true;
    onStatus({state: 'requesting'});
    try {
      if (!mediaDevices?.getUserMedia) throw new Error('Camera unavailable; use replay or synthetic input');
      const acquired = await mediaDevices.getUserMedia({audio: false, video: {width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 12, max: 30}, ...(deviceId ? {deviceId: {exact: deviceId}} : {facingMode: 'user'})}});
      if (generation !== epoch) { release(acquired); return false; }
      stream = acquired;
      video.srcObject = acquired;
      await video.play();
      if (generation !== epoch) return false;
      active = true;
      starting = false;
      onStatus({state: 'active'});
      timer = setTimer(() => tick(generation), 0);
      return true;
    } catch (error) {
      if (generation === epoch) { stop(); onStatus({state: 'error', error: error.message}); }
      throw error;
    }
  }

  return {start, stop, sample, captureDrawable, createMaskedFeed, setMasks, get active() {return active;}, get busy() {return Boolean(inFlight);}};
}
