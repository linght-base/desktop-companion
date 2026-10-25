// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
const SVG_NS = 'http://www.w3.org/2000/svg';
const ACTIONS = ['done', 'snooze', 'dismiss'];
const LABELS = {done: '完成本轮提醒', snooze: '稍后提醒', dismiss: '关闭本轮提醒'};
const ACTIVE_STATUSES = new Set(['waiting', 'exhausted']);

function glyph(document, kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const paths = {
    done: ['M5 12l4 4L19 6'],
    snooze: ['M12 6v6l4 2', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20'],
    dismiss: ['M7 7l10 10M17 7L7 17'],
    neutral: ['M7 12h10'],
    error: ['M12 6v7', 'M12 17v1', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20'],
  };
  for (const d of paths[kind] ?? paths.neutral) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function displayFor(state, now) {
  const body = state?.body;
  const reminder = state?.reminder;
  const expressionUntil=body?.leaseEnds?.expression??body?.leaseUntil;
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
  if (state?.enabled !== true || !body || !reminder || !id(reminder.id) ||
      !id(reminder.roundId) || !id(reminder.lastReceiptId) ||
      body.expressionCommandId !== reminder.lastReceiptId ||
      !Number.isFinite(expressionUntil) || expressionUntil <= now ||
      !ACTIVE_STATUSES.has(reminder.status)) return null;
  if (reminder.pausedUntil > now || reminder.deletedAt || reminder.disabled === true) return null;
  if (state.epoch !== undefined && (!Number.isSafeInteger(state.epoch) || state.epoch < 0)) return null;
  return {
    key: JSON.stringify([state.epoch ?? null, reminder.id, reminder.roundId, reminder.lastReceiptId]),
    id: reminder.id,
    roundId: reminder.roundId,
    canSnooze:reminder.status!=='exhausted'&&(reminder.attemptCount??0)<(reminder.maxAttempts??1),
    ...(state.epoch===undefined?{}:{epoch:state.epoch}),
    receiptId: reminder.lastReceiptId,
    expiresAt: expressionUntil,
  };
}

function confirmed(result, request) {
  const goal = result?.goal ?? result;
  if (!goal || result?.accepted === false || result?.status === 'rejected') return false;
  return goal.id === request.id && goal.roundId === request.roundId &&
    goal.lastUserAction === request.action && goal.lastUserRound === request.roundId &&
    (request.action === 'done' ? goal.status === 'completed' :
      request.action === 'dismiss' ? goal.status === 'dismissed' : goal.status === 'snoozed');
}

/** Explicit circular-screen reminder input. The caller owns transport and state updates. */
export function mountRoundScreenInput({root, send, clock = Date.now, onError} = {}) {
  if (!root?.ownerDocument || typeof root.append !== 'function') throw new TypeError('round_screen_root_required');
  if (typeof send !== 'function' || typeof clock !== 'function') throw new TypeError('round_screen_transport_required');
  const document = root.ownerDocument;
  const view = document.defaultView ?? globalThis;
  const svgRoot = root.namespaceURI === SVG_NS;
  const originalAriaHidden = root.getAttribute('aria-hidden');
  let wrapper = null;
  let container = root;
  if (svgRoot) {
    wrapper = document.createElementNS(SVG_NS, 'foreignObject');
    wrapper.setAttribute('x', '0');
    wrapper.setAttribute('y', '0');
    wrapper.setAttribute('width', '412');
    wrapper.setAttribute('height', '412');
    wrapper.classList.add('round-screen-input-svg');
    container = document.createElement('div');
    container.className = 'round-screen-input-svg-space';
    wrapper.append(container);
    root.append(wrapper);
    root.removeAttribute('aria-hidden');
  }
  const surface = document.createElement('div');
  surface.className = 'round-screen-input';
  surface.setAttribute('role', 'group');
  surface.setAttribute('aria-label', '提醒操作');
  surface.hidden = true;
  const buttons = new Map();
  const listeners = [];
  const hadHostClass = root.classList.contains('round-screen-input-host');
  if (!svgRoot) root.classList.add('round-screen-input-host');
  container.append(surface);
  let latestState = null;
  let current = null;
  let generation = 0;
  let timer = null;
  let pending = false;
  let feedback = null;
  let destroyed = false;

  function report(error) {
    try { onError?.(error); } catch { /* A notification callback cannot change receipt authority. */ }
  }

  function clearTimer() {
    if (timer !== null) view.clearTimeout(timer);
    timer = null;
  }

  function paint() {
    surface.hidden = !current;
    surface.dataset.state = feedback ?? (pending ? 'pending' : 'ready');
    surface.setAttribute('aria-busy', String(pending));
    for (const [action, button] of buttons) {
      button.disabled = pending || (feedback !== null && feedback !== 'error');
      button.hidden = action==='snooze'&&current?.canSnooze===false || feedback !== null && feedback !== 'error' && action !== feedback;
      button.setAttribute('aria-label', feedback === 'error' ? `${LABELS[action]}，上次未成功，可重试` : LABELS[action]);
    }
    const indicator = surface.querySelector('.round-screen-input-indicator');
    indicator.replaceChildren();
    indicator.hidden = !feedback;
    if (feedback) indicator.append(glyph(document, feedback === 'dismiss' ? 'neutral' : feedback));
    if (feedback && feedback !== 'error') for (const button of buttons.values()) button.hidden = true;
  }

  function sync(state) {
    if (destroyed) return;
    latestState = state;
    const next = displayFor(state, clock());
    if (next?.key !== current?.key) {
      generation++;
      pending = false;
      feedback = null;
    }
    current = next;
    clearTimer();
    paint();
    if (current) {
      const delay = Math.max(1, Math.min(2147483647, current.expiresAt - clock()));
      timer = view.setTimeout(() => { timer = null; sync(latestState); }, delay);
    }
  }

  async function choose(action) {
    if (destroyed || pending || !ACTIONS.includes(action) || feedback && feedback !== 'error') return;
    const active = displayFor(latestState, clock());
    if (!active || active.key !== current?.key) { sync(latestState); return; }
    if(action==='snooze'&&!active.canSnooze)return;
    const request = {...active, action};
    const admittedGeneration = generation;
    pending = true;
    feedback = null;
    paint();
    try {
      const result = await send({id:request.id,action,roundId:request.roundId,receiptId:request.receiptId,...(request.epoch===undefined?{}:{epoch:request.epoch})});
      if (destroyed || generation !== admittedGeneration ||
          displayFor(latestState, clock())?.key !== request.key) return;
      pending = false;
      if (confirmed(result, request)) feedback = action;
      else {
        feedback = 'error';
        report(new Error('round_screen_response_unconfirmed'));
      }
      paint();
    } catch (error) {
      if (destroyed || generation !== admittedGeneration ||
          displayFor(latestState, clock())?.key !== request.key) return;
      pending = false;
      feedback = 'error';
      paint();
      report(error);
    }
  }

  for (const action of ACTIONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `round-screen-input-action round-screen-input-${action}`;
    button.setAttribute('aria-label', LABELS[action]);
    button.append(glyph(document, action));
    const listener = event => { event.stopPropagation(); void choose(action); };
    button.addEventListener('click', listener);
    listeners.push([button, listener]);
    buttons.set(action, button);
    surface.append(button);
  }
  const indicator = document.createElement('span');
  indicator.className = 'round-screen-input-indicator';
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  surface.append(indicator);
  paint();

  return {
    update: sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      clearTimer();
      for (const [button, listener] of listeners) button.removeEventListener('click', listener);
      surface.remove();
      wrapper?.remove();
      if (svgRoot && originalAriaHidden !== null && !root.hasAttribute('aria-hidden')) root.setAttribute('aria-hidden', originalAriaHidden);
      if (!svgRoot && !hadHostClass) root.classList.remove('round-screen-input-host');
      latestState = null;
      current = null;
    },
  };
}
