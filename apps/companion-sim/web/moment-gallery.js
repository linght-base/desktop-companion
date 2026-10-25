// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ITEMS = 5;
const SWIPE_MIN_PX = 35;
const SWIPE_VERTICAL_RATIO = 0.5;
const SWIPE_VERTICAL_MAX_PX = 24;
const EMPTY_HINT_MS = 1600;
const MAX_TEXT = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function imageUrlFor(id) {
  return `/api/moment-comics/images/${encodeURIComponent(id)}`;
}

/** 仅接受真实的瞬间漫画条目：安全 id、同源固定路径、有限文本；其余一律丢弃。 */
function itemFor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  if (!Number.isFinite(raw.createdAt)) return null;
  const imageUrl = imageUrlFor(raw.id);
  if (raw.imageUrl !== undefined && raw.imageUrl !== imageUrl) return null;
  const text = value => typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_TEXT) : '';
  return {id: raw.id, imageUrl, encouragement: text(raw.encouragement), title: text(raw.title), createdAt: raw.createdAt};
}

function itemsFor(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    const item = itemFor(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

function glyph(document, paths) {
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    icon.append(path);
  }
  return icon;
}

/** 圆屏瞬间漫画画廊：挂在既有 #robot-face SVG 圆屏内，用户左滑进入手动浏览。
 *  宿主拥有数据与传输：update({enabled, epoch, items}) 推送最近真实条目，
 *  onMode('gallery'|'face') 通知宿主交接表情所有权；不做任何网络或语音行为。 */
export function mountMomentGallery({stage, request, onMode = () => {}, onAction=()=>{}, clock = Date.now} = {}) {
  if (!stage?.ownerDocument || typeof stage.append !== 'function') throw new TypeError('moment_gallery_stage_required');
  if (typeof request !== 'function') throw new TypeError('moment_gallery_request_required');
  if (typeof onMode !== 'function' || typeof clock !== 'function') throw new TypeError('moment_gallery_callback_required');
  const document = stage.ownerDocument;
  const view = document.defaultView ?? globalThis;
  const svgRoot = stage.namespaceURI === SVG_NS;
  const originalAriaHidden = stage.getAttribute('aria-hidden');
  let wrapper = null;
  let container = stage;
  if (svgRoot) {
    wrapper = document.createElementNS(SVG_NS, 'foreignObject');
    wrapper.setAttribute('x', '0');
    wrapper.setAttribute('y', '0');
    wrapper.setAttribute('width', '412');
    wrapper.setAttribute('height', '412');
    wrapper.classList.add('moment-gallery-svg');
    container = document.createElement('div');
    container.className = 'moment-gallery-space';
    wrapper.append(container);
    stage.append(wrapper);
    stage.removeAttribute('aria-hidden');
  }
  const hadHostClass = stage.classList.contains('moment-gallery-host');
  if (!svgRoot) stage.classList.add('moment-gallery-host');

  const surface = document.createElement('div');
  surface.className = 'moment-gallery';
  surface.setAttribute('role', 'group');
  surface.setAttribute('aria-label', '瞬间漫画画廊');
  surface.hidden = true;

  const image = document.createElement('img');
  image.className = 'moment-gallery-image';
  image.alt = '';
  const caption = document.createElement('div');
  caption.className = 'moment-gallery-caption';
  const title = document.createElement('span');
  title.className = 'moment-gallery-title';
  const encouragement = document.createElement('p');
  encouragement.className = 'moment-gallery-encouragement';
  caption.append(title, encouragement);
  const position = document.createElement('span');
  position.className = 'moment-gallery-position';
  position.setAttribute('aria-live', 'polite');

  const listeners = [];
  const listen = (element, type, handler, options) => {
    element.addEventListener(type, handler, options);
    listeners.push([element, type, handler]);
  };
  const navSpec = [
    ['previous', '上一张漫画', ['M14 6l-6 6 6 6']],
    ['next', '下一张漫画', ['M10 6l6 6-6 6']],
  ];
  const buttons = new Map();
  const nav = document.createElement('div');
  nav.className = 'moment-gallery-nav';
  for (const [action, label, paths] of navSpec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `moment-gallery-nav-button moment-gallery-${action}`;
    button.setAttribute('aria-label', label);
    button.append(glyph(document, paths));
    listen(button, 'click', event => { event.stopPropagation(); activate(action); });
    buttons.set(action, button);
    nav.append(button);
  }
  const returnButton = document.createElement('button');
  returnButton.type = 'button';
  returnButton.className = 'moment-gallery-return';
  returnButton.setAttribute('aria-label', '返回表情');
  returnButton.append(glyph(document, ['M7 7l10 10M17 7L7 17']), document.createTextNode('返回'));
  listen(returnButton, 'click', event => { event.stopPropagation(); activate('return'); });
  surface.append(image, caption, position, nav, returnButton);

  const emptyHint = document.createElement('div');
  emptyHint.className = 'moment-gallery-empty';
  emptyHint.setAttribute('role', 'status');
  emptyHint.textContent = '还没有瞬间漫画';
  emptyHint.hidden = true;
  container.append(surface, emptyHint);

  let destroyed = false;
  let mode = 'face';
  let enabled = false;
  let epoch;
  let items = [];
  let index = 0;
  let currentId = null;
  let gesture = null;
  let swallowNextClick = false;
  let emptyTimer = null;
  let previousFocus=null;
  function focusGallery(){returnButton.focus?.({preventScroll:true});}

  function notifyMode(next) {
    try { onMode(next); } catch { /* 宿主回调不能改变画廊状态机。 */ }
  }
  function clearEmptyTimer() {
    if (emptyTimer !== null) view.clearTimeout(emptyTimer);
    emptyTimer = null;
  }

  function currentItem() {
    return mode === 'gallery' ? items[index] ?? null : null;
  }

  function paint() {
    surface.hidden = mode !== 'gallery';
    const item = currentItem();
    if (!item) return;
    if (image.getAttribute('src') !== item.imageUrl) image.setAttribute('src', item.imageUrl);
    image.alt = item.title || '瞬间漫画';
    title.textContent = item.title;
    encouragement.textContent = item.encouragement;
    caption.hidden = !item.title && !item.encouragement;
    position.textContent = `${index + 1}/${items.length}`;
    buttons.get('previous').disabled = items.length<2;
    buttons.get('next').disabled = items.length<2;
  }

  function enter() {
    if (mode !== 'face' || !enabled) return;
    if (items.length === 0) { showEmptyHint(); return; }
    previousFocus=document.activeElement;
    mode = 'gallery';
    index = 0;
    currentId = items[0].id;
    notifyMode('gallery');
    try{onAction({action:'select',imageId:currentId});}catch{}
    paint();
    focusGallery();
  }
  function exit() {
    if (mode !== 'gallery') return;
    mode = 'face';
    currentId = null;
    gesture = null;
    paint();
    notifyMode('face');
    if(previousFocus?.isConnected!==false)previousFocus?.focus?.({preventScroll:true});previousFocus=null;
  }
  function activate(action) {
    if (destroyed || mode !== 'gallery') return;
    if (action === 'return') {try{onAction({action:'back'});}catch{} exit(); return; }
    if(items.length<2)return;
    if (action === 'next') index=(index+1)%items.length;
    else if (action === 'previous') index=(index-1+items.length)%items.length;
    else return;
    currentId = items[index].id;
    try{onAction({action:'select',imageId:currentId});}catch{}
    paint();
  }

  function showEmptyHint() {
    if (destroyed) return;
    emptyHint.hidden = false;
    clearEmptyTimer();
    emptyTimer = view.setTimeout(() => { emptyTimer = null; emptyHint.hidden = true; }, EMPTY_HINT_MS);
  }

  /** 滑动识别：水平位移超过 35px 且垂直分量被抑制才算一次滑动；
   *  被消费的滑动吞掉紧随的 click，避免误触底下的提醒确认按钮。 */
  function swallowClick() {
    swallowNextClick = true;
  }
  listen(stage, 'click', event => {
    if (!swallowNextClick) return;
    swallowNextClick = false;
    event.stopPropagation();
    event.preventDefault?.();
  }, true);
  listen(stage, 'pointerdown', event => {
    if (destroyed || gesture) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    gesture = {id: event.pointerId ?? 'mouse', x: event.clientX, y: event.clientY};
  });
  listen(stage, 'pointerup', event => {
    if (!gesture || gesture.id !== (event.pointerId ?? 'mouse')) return;
    const start = gesture;
    gesture = null;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX) return;
    if (Math.abs(dy) > Math.max(SWIPE_VERTICAL_MAX_PX, Math.abs(dx) * SWIPE_VERTICAL_RATIO)) return;
    swallowClick();
    if (mode === 'face') { if (dx < 0) enter(); return; }
    activate(dx < 0 ? 'next' : 'previous');
  });
  listen(stage, 'pointercancel', () => { gesture = null; });
  listen(surface, 'keydown', event => {
    if (mode !== 'gallery') return;
    if (event.key === 'ArrowRight') { event.preventDefault(); activate('next'); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); activate('previous'); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); activate('return'); }
  });

  function update(state) {
    if (destroyed) return;
    const nextEpoch = state && state.epoch !== undefined ? state.epoch : undefined;
    if (nextEpoch !== undefined && (!Number.isSafeInteger(nextEpoch) || nextEpoch < 0)) return;
    const epochChanged = nextEpoch !== undefined && epoch !== undefined && nextEpoch !== epoch;
    if (nextEpoch !== undefined) epoch = nextEpoch;
    enabled = state?.enabled === true;
    items = itemsFor(state?.items);
    if (!enabled || epochChanged) { exit(); return; }
    if (mode === 'gallery') {
      if (items.length === 0) { exit(); return; }
      const kept = items.findIndex(item => item.id === currentId);
      if (kept >= 0) index = kept; // 新图到达只移动位置，不打断正在看的同一张
      else {
        index = Math.min(index, items.length - 1); // 当前图被挤出后夹到边界
        currentId = items[index].id;
      }
    }
    paint();
  }

  return {
    update,
    open(id){if(destroyed||!enabled)return false;const found=items.findIndex(item=>item.id===id);if(found<0)return false;if(mode==='face')previousFocus=document.activeElement;mode='gallery';index=found;currentId=id;notifyMode('gallery');try{onAction({action:'select',imageId:id});}catch{}paint();focusGallery();return true;},
    back(){if(destroyed||mode!=='gallery')return false;activate('return');return true;},
    snapshot() {
      return {
        mode,
        enabled,
        epoch: epoch ?? null,
        count: items.length,
        index: mode === 'gallery' ? index : null,
        currentId,
        items: items.map(item => item.id),
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const wasGallery = mode === 'gallery';
      mode = 'face';
      gesture = null;
      clearEmptyTimer();
      for (const [element, type, handler] of listeners) element.removeEventListener(type, handler);
      surface.remove();
      emptyHint.remove();
      wrapper?.remove();
      if (!svgRoot && !hadHostClass) stage.classList.remove('moment-gallery-host');
      if (svgRoot && originalAriaHidden !== null && !stage.hasAttribute('aria-hidden')) stage.setAttribute('aria-hidden', originalAriaHidden);
      items = [];
      if (wasGallery) notifyMode('face');
    },
  };
}
