// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const NS = 'http://www.w3.org/2000/svg';
const GLYPHS = new Set(['left', 'right', 'up', 'down', 'nearer', 'farther']);
const ROTATION = {right:0, down:90, left:180, up:270};

/** Mounts an independent, finite glyph layer; never changes the robot's eyes or joints. */
export function mountViewGuidance({root, clock = Date.now}) {
  if (!root?.appendChild || !root.ownerDocument) throw new Error('invalid_guidance_root');
  const document = root.ownerDocument, timers = document.defaultView ?? globalThis;
  const svgRoot = root.namespaceURI === NS;
  const layer = svgRoot ? document.createElementNS(NS, 'g') : document.createElement('div');
  layer.setAttribute('class', `view-guidance-layer${svgRoot ? ' view-guidance-svg-layer' : ''}`);
  layer.setAttribute('hidden', '');
  layer.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('focusable', 'false');
  if (svgRoot) for (const [key, value] of Object.entries({x:'28%',y:'28%',width:'44%',height:'44%'})) svg.setAttribute(key, value);
  const glyph = document.createElementNS(NS, 'g');
  svg.appendChild(glyph); layer.appendChild(svg); root.appendChild(layer);
  let timer = null, destroyed = false, visibleId = null, expiresAt = 0;
  // A cue cannot reappear after a reminder/expression supersedes it or it expires.
  const consumed = new Set();
  const consume = id => {
    if (!id) return;
    consumed.add(id);
    if (consumed.size > 128) consumed.delete(consumed.values().next().value);
  };
  function hide(permanent = false) {
    if (permanent) consume(visibleId);
    if (timer !== null) timers.clearTimeout(timer);
    timer = null; layer.setAttribute('hidden', ''); visibleId = null; expiresAt = 0;
  }
  function path(d, className = '') {
    const element = document.createElementNS(NS, 'path');
    element.setAttribute('d', d);
    if (className) element.setAttribute('class', className);
    glyph.appendChild(element);
  }
  function draw(kind) {
    glyph.replaceChildren();
    glyph.removeAttribute('transform');
    if (Object.hasOwn(ROTATION, kind)) {
      glyph.setAttribute('transform', `rotate(${ROTATION[kind]} 50 50)`);
      path('M29 50H70M56 36L70 50L56 64');
      return;
    }
    // Distance glyphs point toward/away from a fixed center, with no words.
    path('M46 46H54V54H46Z', 'view-guidance-center');
    if (kind === 'nearer') {
      path('M22 22L38 38M28 38H38V28M78 22L62 38M62 28V38H72M22 78L38 62M28 62H38V72M78 78L62 62M62 72V62H72');
    } else {
      path('M38 38L22 22M22 32V22H32M62 38L78 22M68 22H78V32M38 62L22 78M22 68V78H32M62 62L78 78M68 78H78V68');
    }
  }
  function update({guidance, enabled, expressionActive} = {}) {
    if (destroyed) return;
    const cue = guidance?.cue, at = clock();
    if (enabled !== true || expressionActive === true) {
      consume(cue?.id); hide(true); return;
    }
    if (!cue || typeof cue.id !== 'string' || cue.id.length > 100 || !GLYPHS.has(cue.glyph)
      || !Number.isFinite(at) || !Number.isFinite(cue.startedAt) || !Number.isFinite(cue.expiresAt)
      || cue.expiresAt <= at || cue.startedAt > at || cue.expiresAt - cue.startedAt > 8000
      || cue.expiresAt <= cue.startedAt || consumed.has(cue.id)) {
      hide(true); return;
    }
    if (visibleId === cue.id) {
      // Repeated snapshots cannot extend the original accepted display deadline.
      if (cue.expiresAt !== expiresAt) hide(true);
      return;
    }
    hide(true); draw(cue.glyph);
    visibleId = cue.id; expiresAt = cue.expiresAt; layer.removeAttribute('hidden');
    layer.dataset.glyph = cue.glyph;
    timer = timers.setTimeout(() => hide(true), Math.max(0, expiresAt - at));
  }
  function destroy() {
    if (destroyed) return;
    hide(true); destroyed = true; consumed.clear(); layer.remove();
  }
  return {update, destroy};
}
