// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PANELS = 6, MAX_OBJECTS = 16;
const clamp = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

function svg(document, tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}
function glyph(document, paths) {
  const icon = svg(document, 'svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of paths) icon.append(svg(document, 'path', { d }));
  return icon;
}

/** 机器人叙述者：几何与配色沿用 comic-renderer.mjs，只应用分镜记录的表情参数，不新增文字。 */
function robotNarrator(document, expression = {}) {
  const gazeX = clamp(expression.gazeX, -1, 1, 0) * 5, gazeY = clamp(expression.gazeY, -1, 1, 0) * 4;
  const openness = clamp(expression.openness, 0, 1, 0.85), tilt = clamp(expression.tilt, -30, 30, 0);
  const group = svg(document, 'g', { transform: `translate(18 84) rotate(${tilt} 40 40)` });
  group.append(svg(document, 'path', { d: 'M22 76 L14 101 L66 101 L58 76', fill: '#e5cba5', stroke: '#3b4544', 'stroke-width': '2.5' }));
  group.append(svg(document, 'rect', { x: 0, y: 0, width: 80, height: 76, rx: 23, fill: '#f7e6cb', stroke: '#3b4544', 'stroke-width': '2.5' }));
  group.append(svg(document, 'rect', { x: 9, y: 15, width: 62, height: 43, rx: 14, fill: '#3b4544' }));
  group.append(svg(document, 'ellipse', { cx: 26 + gazeX, cy: 36 + gazeY, rx: 5, ry: Math.max(1, 8 * openness), fill: '#a9cfc3' }));
  group.append(svg(document, 'ellipse', { cx: 54 + gazeX, cy: 36 + gazeY, rx: 5, ry: Math.max(1, 8 * openness), fill: '#a9cfc3' }));
  group.append(svg(document, 'path', { d: 'M33 65 L47 65', stroke: '#3b4544', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  return group;
}

/** 用真实分镜 layout 绘制一帧：仅画记录到的物体与机器人叙述者；没有记录就留空，不补演示数据。 */
function scenePanel(document, panel) {
  const group = svg(document, 'g');
  group.append(svg(document, 'rect', { x: 0, y: 0, width: 320, height: 190, rx: 12, fill: '#f3f0e8' }));
  group.append(svg(document, 'path', { d: 'M12 170 H308', stroke: '#d1c9b8', 'stroke-width': 2 }));
  const entities = new Map((Array.isArray(panel.entities) ? panel.entities : [])
    .filter(entity => typeof entity?.id === 'string' && typeof entity?.label === 'string').map(entity => [entity.id, entity]));
  const objects = (Array.isArray(panel.objects) ? panel.objects : []).slice(0, MAX_OBJECTS);
  for (const object of objects) {
    if (!object || typeof object !== 'object' || !entities.has(object.entityId)) continue;
    if (object.shape !== 'rect' && object.shape !== 'ellipse') continue;
    const { x, y, width, height } = object;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0
      || x + width > 1 || y + height > 1) continue;
    const left = 100 + x * 206, top = 14 + y * 136, w = width * 206, h = height * 136;
    const rotation = Number.isFinite(object.rotation) ? clamp(object.rotation, -180, 180, 0) : 0;
    const rotated = svg(document, 'g', { transform: `rotate(${rotation} ${left + w / 2} ${top + h / 2})` });
    rotated.append(object.shape === 'ellipse'
      ? svg(document, 'ellipse', { cx: left + w / 2, cy: top + h / 2, rx: w / 2, ry: h / 2, fill: '#a9cfc3', 'fill-opacity': '.66', stroke: '#3b4544', 'stroke-width': 2 })
      : svg(document, 'rect', { x: left, y: top, width: w, height: h, rx: 4, fill: '#a9cfc3', 'fill-opacity': '.66', stroke: '#3b4544', 'stroke-width': 2 }));
    group.append(rotated);
  }
  group.append(robotNarrator(document, panel.robot && typeof panel.robot === 'object' ? panel.robot : {}));
  return group;
}

/** 校验 /api/comic 的真实 book：仅 published 且带分镜的画册可用；无有效标识或分镜超界一律拒绝。 */
function viewFor(book) {
  if (!book || typeof book !== 'object' || book.status !== 'published') return null;
  if (typeof book.id !== 'string' || !book.id || book.id.length > 200) return null;
  if (typeof book.day !== 'string' || !DAY_PATTERN.test(book.day)) return null;
  if (!Array.isArray(book.panels) || book.panels.length < 1 || book.panels.length > MAX_PANELS) return null;
  const panels = book.panels.map(panel => {
    if (!panel || typeof panel !== 'object') return null;
    return {
      entities: Array.isArray(panel.entities) ? panel.entities : [],
      objects: Array.isArray(panel.objects) ? panel.objects : [],
      robot: panel.robot && typeof panel.robot === 'object' ? panel.robot : {},
      basisId: typeof panel.basisId === 'string' ? panel.basisId : null,
      revision: Number.isSafeInteger(panel.revision) ? panel.revision : null,
    };
  });
  if (panels.some(panel => panel === null)) return null;
  const fingerprint = JSON.stringify([book.id, book.status, book.updatedAt ?? null, panels.map(panel => [panel.basisId, panel.revision])]);
  return { key: fingerprint, fingerprint, id: book.id, day: book.day, panels };
}

/** 门禁：宿主未启用、画册无效、或提醒正在占用圆屏（图标+有效租约+当前命令）时不显示；提醒始终优先。 */
function displayFor(state, now) {
  if (state?.enabled !== true) return null;
  const comic = state?.comic;
  const view = viewFor(comic && typeof comic === 'object' ? (comic.book ?? comic) : null);
  if (!view) return null;
  const body = state?.body && typeof state.body === 'object' ? state.body : null;
  const commandId = typeof body?.expressionCommandId === 'string' ? body.expressionCommandId
    : typeof body?.activeCommandId === 'string' ? body.activeCommandId : null;
  const leaseUntil = Number.isFinite(body?.leaseUntil) ? body.leaseUntil : 0;
  if (commandId && leaseUntil > now) return null;
  return view;
}

/** 圆屏每日漫画阅读器：入口与阅读 UI 都挂在 #robot-face 内，随头一起转动；不修改眼睛或头部元素。
 *  宿主拥有状态与传输：update({enabled,body,comic}) 驱动显示，load({day}) 返回 /api/comic 真实响应。 */
export function mountRoundComicReader({ root, load, onError, clock = Date.now } = {}) {
  if (!root?.ownerDocument || typeof root.append !== 'function') throw new TypeError('comic_reader_root_required');
  if (typeof load !== 'function' || typeof clock !== 'function') throw new TypeError('comic_reader_source_required');
  const document = root.ownerDocument;
  const view = document.defaultView ?? globalThis;
  const svgRoot = root.namespaceURI === SVG_NS;
  const originalAriaHidden = root.getAttribute('aria-hidden');
  let wrapper = null;
  let container = root;
  if (svgRoot) {
    wrapper = svg(document, 'foreignObject', { x: 0, y: 0, width: 412, height: 412 });
    wrapper.classList.add('round-comic-reader-svg');
    container = document.createElement('div');
    container.className = 'round-comic-reader-space';
    wrapper.append(container);
    root.append(wrapper);
    root.removeAttribute('aria-hidden');
  }
  const hadHostClass = root.classList.contains('round-comic-reader-host');
  if (!svgRoot) root.classList.add('round-comic-reader-host');

  const surface = document.createElement('div');
  surface.className = 'round-comic-reader';
  surface.setAttribute('role', 'group');
  surface.setAttribute('aria-label', '每日漫画阅读');
  container.append(surface);

  const entrance = document.createElement('button');
  entrance.type = 'button';
  entrance.className = 'round-comic-entrance';
  entrance.setAttribute('aria-label', '打开今日漫画');
  entrance.append(glyph(document, ['M4 5h7a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z', 'M20 5h-7a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h7z']));

  const readingView = document.createElement('div');
  readingView.className = 'round-comic-reading';
  readingView.hidden = true;
  const scene = svg(document, 'svg', { viewBox: '0 0 412 412', role: 'img', 'aria-label': '漫画分镜' });
  scene.classList.add('round-comic-scene');
  scene.append(svg(document, 'circle', { cx: 206, cy: 206, r: 186, fill: '#07110e', 'fill-opacity': '.55' }));
  const sceneFrame = svg(document, 'g', { transform: 'translate(46 92)' });
  scene.append(sceneFrame);
  const dots = document.createElement('span');
  dots.className = 'round-comic-dots';
  dots.setAttribute('aria-hidden', 'true');
  const nav = document.createElement('div');
  nav.className = 'round-comic-nav';
  const buttons = new Map();
  const listenerRegistry = [];
  const navSpec = [
    ['previous', '上一格', ['M14 6l-6 6 6 6']],
    ['exit', '退出漫画阅读', ['M7 7l10 10M17 7L7 17']],
    ['next', '下一格', ['M10 6l6 6-6 6']],
  ];
  for (const [action, label, paths] of navSpec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `round-comic-nav-button round-comic-${action}`;
    button.setAttribute('aria-label', label);
    button.append(glyph(document, paths));
    const listener = event => { event.stopPropagation(); activate(action); };
    button.addEventListener('click', listener);
    listenerRegistry.push([button, 'click', listener]);
    buttons.set(action, button);
    nav.append(button);
  }
  const keyListener = event => {
    if (readingView.hidden) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); activate('previous'); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); activate('next'); }
    else if (event.key === 'Escape') { event.preventDefault(); activate('exit'); }
  };
  surface.addEventListener('keydown', keyListener);
  listenerRegistry.push([surface, 'keydown', keyListener]);
  readingView.append(scene, dots, nav);
  surface.append(entrance, readingView);

  let latestState = null;
  let current = null;
  let reading = null; // {id,panels,index}
  let opening = false;
  let generation = 0;
  let destroyed = false;

  function report(error) {
    try { onError?.(error); } catch { /* 通知回调不能改变阅读门禁。 */ }
  }
  function viewHasFocus() {
    return readingView.contains(document.activeElement);
  }
  function activate(action) {
    if (destroyed || !reading || opening) return;
    if (action === 'exit') {
      const hadFocus = viewHasFocus();
      reading = null;
      paint();
      if (hadFocus) entrance.focus();
      return;
    }
    if (action === 'previous' && reading.index > 0) reading.index--;
    else if (action === 'next' && reading.index < reading.panels.length - 1) reading.index++;
    paint();
  }

  async function enter() {
    if (destroyed || reading || opening || !current) return;
    const admittedGeneration = generation;
    const day = current.day;
    opening = true;
    paint();
    try {
      const response = await load({ day });
      // 异步迟到结果不得重新打开：期间状态变化（提醒占用/停用/画册失效）都会递增 generation 或使门禁为空。
      if(destroyed||generation!==admittedGeneration)return;
      if(!displayFor(latestState,clock())){opening=false;paint();return;}
      opening = false;
      const fresh = viewFor(response && typeof response === 'object' ? (response.book ?? response) : null);
      if (!fresh || fresh.key !== current?.key) { report(new Error('comic_reader_book_unavailable')); paint(); return; }
      reading = { id: fresh.id, key:fresh.key, panels: fresh.panels, index: 0 };
      paint();
    } catch (error) {
      if (destroyed || generation !== admittedGeneration) return;
      opening = false;
      report(error);
      paint();
    }
  }
  const entranceListener = event => { event.stopPropagation(); void enter(); };
  entrance.addEventListener('click', entranceListener);
  listenerRegistry.push([entrance, 'click', entranceListener]);

  function paint() {
    const showEntrance = Boolean(current) && !reading;
    entrance.hidden = !showEntrance;
    entrance.disabled = opening;
    entrance.dataset.opening = opening ? 'true' : 'false';
    readingView.hidden = !reading;
    if (!reading) { sceneFrame.replaceChildren(); dots.replaceChildren(); return; }
    scene.setAttribute('aria-label', `漫画分镜 ${reading.index + 1}/${reading.panels.length}`);
    sceneFrame.replaceChildren(scenePanel(document, reading.panels[reading.index]));
    dots.replaceChildren(...reading.panels.map((_, index) => {
      const dot = document.createElement('i');
      dot.className = 'round-comic-dot';
      if (index === reading.index) dot.dataset.current = 'true';
      return dot;
    }));
    buttons.get('previous').disabled = reading.index === 0;
    buttons.get('next').disabled = reading.index === reading.panels.length - 1;
  }

  function update(state) {
    if (destroyed) return;
    latestState = state;
    const next = displayFor(state, clock());
    if (next?.key !== current?.key){generation++;opening=false;}
    current = next;
    if (reading) {
      // 停用、主表达占用、来源修订或画册被替换都立即退出阅读。
      if (!next || next.key !== reading.key) { reading = null; paint(); return; }
    }
    paint();
  }
  paint();

  return {
    update,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      reading = null;
      current = null;
      latestState = null;
      for (const [element, type, listener] of listenerRegistry) element.removeEventListener(type, listener);
      surface.remove();
      wrapper?.remove();
      if (svgRoot && originalAriaHidden !== null && !root.hasAttribute('aria-hidden')) root.setAttribute('aria-hidden', originalAriaHidden);
      if (!svgRoot && !hadHostClass) root.classList.remove('round-comic-reader-host');
    },
  };
}
