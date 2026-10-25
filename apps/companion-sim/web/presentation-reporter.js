// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Actual-visibility presentation reporter for the round robot face. The host
 * owns state, drawing, and transport; this module only confirms that a
 * reminder presentation carrying a live expression lease was really painted
 * on a visible screen, then reports strictly {id, roundId, receiptId, epoch}.
 * A confirmation means "drawn locally" only — never that the user saw,
 * agreed, or completed anything. No DOM or language edits, no body control,
 * no model, and no judgement from icons or activity names.
 */

const ACTIVE_STATUSES = new Set(['waiting', 'exhausted']);
const MAX_LEDGER = 256;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 200;
const POLL_LIMIT = 20;
const POLL_INTERVAL_MS = 250;

const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const isDeadline = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Original expression deadline only: the head lease can never extend it.
 * leaseUntil is a compat fallback solely when leaseEnds is entirely absent;
 * an invalid or partial leaseEnds never falls back to an unbounded lease.
 */
function expressionDeadline(body) {
  const {leaseEnds, leaseUntil} = body;
  if (Object.hasOwn(body,'leaseEnds')) {
    if (leaseEnds===null || typeof leaseEnds !== 'object' || Array.isArray(leaseEnds)) return null;
    return isDeadline(leaseEnds.expression) ? leaseEnds.expression : null;
  }
  return isDeadline(leaseUntil) ? leaseUntil : null;
}

export function mountPresentationReporter({root, send, clock = Date.now} = {}) {
  if (!root?.ownerDocument || typeof root.getBoundingClientRect !== 'function') throw new TypeError('presentation_reporter_root_required');
  if (typeof send !== 'function' || typeof clock !== 'function') throw new TypeError('presentation_reporter_transport_required');
  const document = root.ownerDocument;
  const view = document.defaultView ?? globalThis;
  if (typeof view.setTimeout !== 'function' || typeof view.clearTimeout !== 'function') throw new TypeError('presentation_reporter_view_required');
  const requestFrame = typeof view.requestAnimationFrame === 'function' ? callback => view.requestAnimationFrame(callback) : callback => view.setTimeout(() => callback(clock()), 16);
  const cancelFrame = typeof view.cancelAnimationFrame === 'function' ? handle => view.cancelAnimationFrame(handle) : handle => view.clearTimeout(handle);

  const ledger = new Map(); // key -> {sent, done}; insertion-ordered and bounded
  let latestState = null;
  let currentKey = null;
  let generation = 0;
  let sending = false;
  let destroyed = false;
  let frame = null;
  let cleanups = [];

  const remember = (key, entry) => {
    ledger.delete(key);
    ledger.set(key, entry);
    while (ledger.size > MAX_LEDGER) ledger.delete(ledger.keys().next().value);
  };
  const record = key => ledger.get(key) ?? {sent: 0, done: false};
  const canAttempt = key => { const entry = ledger.get(key); return entry?.done !== true && (entry?.sent ?? 0) < MAX_ATTEMPTS; };

  /** Current reminder candidate, or null unless every identity and lease check passes against `now`. */
  function candidate(state, now) {
    if(!isDeadline(now))return null;
    const body = state?.body;
    const reminder = state?.reminder;
    if (state?.enabled !== true || !body || !reminder) return null;
    if (!Number.isSafeInteger(state.epoch) || state.epoch < 0) return null;
    if (!isId(reminder.id) || !isId(reminder.roundId) || !isId(reminder.lastReceiptId)) return null;
    if (!ACTIVE_STATUSES.has(reminder.status)) return null;
    if (reminder.pausedUntil > now || reminder.deletedAt || reminder.disabled === true) return null;
    if (body.expressionCommandId !== reminder.lastReceiptId) return null;
    const expiresAt = expressionDeadline(body);
    if (expiresAt === null || expiresAt <= now) return null;
    return {
      key: JSON.stringify([state.epoch, reminder.id, reminder.roundId, reminder.lastReceiptId]),
      id: reminder.id,
      roundId: reminder.roundId,
      receiptId: reminder.lastReceiptId,
      epoch: state.epoch,
      expiresAt,
    };
  }

  function cssVisible() {
    if (typeof root.checkVisibility === 'function') {
      try { return root.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}); } catch { return false; }
    }
    if (typeof view.getComputedStyle !== 'function') return true;
    let node = root;
    while (node && node.nodeType === 1) {
      const style = view.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity)===0) return false;
      node = node.parentElement;
    }
    return true;
  }

  /** Real on-screen visibility: visible document, connected root, non-zero rect intersecting the viewport, and CSS visibility. */
  function visible() {
    if (document.visibilityState !== undefined && document.visibilityState !== 'visible') return false;
    const connected = typeof root.isConnected === 'boolean' ? root.isConnected : document.documentElement?.contains(root) === true;
    if (!connected) return false;
    const rect = root.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return false;
    const width = Number.isFinite(view.innerWidth) ? view.innerWidth : document.documentElement?.clientWidth ?? 0;
    const height = Number.isFinite(view.innerHeight) ? view.innerHeight : document.documentElement?.clientHeight ?? 0;
    if (!(rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height)) return false;
    return cssVisible();
  }

  function clearAttempt() {
    if (frame !== null) { cancelFrame(frame); frame = null; }
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch { /* Cleanup must never throw back into state handling. */ }
    }
  }

  function later(callback, delay) {
    let active = true;
    const cancel = () => {
      if (!active) return;
      active = false;
      view.clearTimeout(timer);
      const index = cleanups.indexOf(cancel);
      if (index >= 0) cleanups.splice(index, 1);
    };
    const timer = view.setTimeout(() => { cancel(); callback(); }, Math.max(0, Math.min(2147483647, delay)));
    cleanups.push(cancel);
    return cancel;
  }

  /** Two consecutive painted frames, then re-verify against the latest state before any send. */
  function verify(key, gen) {
    if(frame!==null||sending)return;
    let frames = 0;
    const step = () => {
      frame = null;
      if (destroyed || gen !== generation || currentKey !== key) return;
      if(!candidate(latestState,clock()))return;
      if(!visible()){awaitVisibility(key,gen);return;}
      frames += 1;
      if (frames < 2) { frame = requestFrame(step); return; }
      const next = candidate(latestState, clock());
      if (!next || next.key !== key || !canAttempt(key)) return; // Expired or superseded: nothing is resent.
      if (!visible()) { awaitVisibility(key, gen); return; }
      report(next, gen);
    };
    frame = requestFrame(step);
  }

  /** Bounded re-checks for a presentation that is current but not yet visible; expiry while hidden is never resent. */
  function awaitVisibility(key, gen) {
    clearAttempt();
    const recheck = () => {
      if (destroyed || gen !== generation || currentKey !== key || !canAttempt(key)) return;
      const next = candidate(latestState, clock());
      if (!next || next.key !== key) return;
      if (visible()) verify(key, gen);
    };
    if (typeof document.addEventListener === 'function') {
      const onVisibility = () => recheck();
      document.addEventListener('visibilitychange', onVisibility);
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
    if (typeof view.IntersectionObserver === 'function') {
      try {
        const observer = new view.IntersectionObserver(() => recheck());
        observer.observe(root);
        cleanups.push(() => observer.disconnect());
      } catch { /* Bounded polling below also covers CSS-only visibility changes. */ }
    }
    {
      let polls = 0;
      const poll = () => {
        if (destroyed || gen !== generation || currentKey !== key || frame !== null || !canAttempt(key)) return;
        polls += 1;
        recheck();
        if (frame === null && polls < POLL_LIMIT) later(poll, POLL_INTERVAL_MS);
      };
      later(poll, POLL_INTERVAL_MS);
    }
    const next = candidate(latestState, clock());
    if (next) later(() => { if (gen === generation && currentKey === key) clearAttempt(); }, next.expiresAt - clock());
  }

  function report(next, gen) {
    if (destroyed || gen !== generation || sending || !canAttempt(next.key)) return;
    clearAttempt();
    const entry = record(next.key);
    entry.sent += 1;
    remember(next.key, entry);
    sending = true;
    const payload = {id: next.id, roundId: next.roundId, receiptId: next.receiptId, epoch: next.epoch};
    let outcome;
    try { outcome = Promise.resolve(send(payload)); } catch (error) { outcome = Promise.reject(error); }
    outcome.then(
      result => settle(next, gen, result, null),
      error => settle(next, gen, null, error ?? new Error('presentation_report_failed')),
    );
  }

  function settle(next, gen, result, error) {
    if(gen===generation&&currentKey===next.key)sending = false;
    // Only an explicit acceptance counts; anything unknown stays unknown.
    if (error === null && (result?.status === 'accepted' || result?.accepted === true)) {
      const entry = record(next.key);
      entry.done = true;
      remember(next.key, entry);
      if (gen === generation && currentKey === next.key) clearAttempt();
      return;
    }
    if (destroyed || gen !== generation || currentKey !== next.key) return; // A late failure never pollutes a newer reminder.
    const now = clock();
    const again = candidate(latestState, now);
    if (!again || again.key !== next.key || !canAttempt(next.key)) return;
    if (now + RETRY_DELAY_MS > again.expiresAt) return; // Retries stay inside the original deadline.
    later(() => { if (!destroyed && gen === generation && currentKey === next.key) verify(next.key, gen); }, RETRY_DELAY_MS);
  }

  function sync(state) {
    if (destroyed) return;
    latestState = state;
    const next = candidate(state, clock());
    if (next === null) {
      if (currentKey !== null) {
        generation++;
        clearAttempt();
        currentKey = null;
        sending = false;
      }
      return;
    }
    if (next.key !== currentKey) {
      generation++;
      clearAttempt();
      currentKey = next.key;
      sending = false;
      if (!canAttempt(next.key)) return;
      if (visible()) verify(next.key, generation);
      else awaitVisibility(next.key, generation);
      return;
    }
    // Same key: a pending chain is left untouched, so steady updates cannot
    // starve the two-frame check or spam the transport with fresh requests.
    if (sending || frame !== null || cleanups.length > 0 || !canAttempt(next.key)) return;
    if (visible()) verify(next.key, generation);
    else awaitVisibility(next.key, generation);
  }

  return {
    update: sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      clearAttempt();
      latestState = null;
      currentKey = null;
      sending = false;
    },
  };
}
