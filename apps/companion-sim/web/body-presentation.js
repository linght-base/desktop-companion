// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Pure lease projection for a host body snapshot. The host owns timers and
 * DOM wiring; this module only enforces the deadlines a snapshot already
 * carries, so a late frame can retract but never extend a presentation.
 * No timers, DOM, network, model, or scene judgement, and no input mutation.
 */

const DEFAULT_EYES = Object.freeze({gazeX: 0, gazeY: 0, openness: 0.55, tilt: 0, roundness: 0.7, color: '#A9DDE9'});
const CHANNELS = ['head', 'expression', 'gaze'];

const isDeadline = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Resolve the three raw channel deadlines, or null when the snapshot carries no lease metadata. */
function channelDeadlines(body) {
  const {leaseEnds, leaseUntil} = body;
  if (Object.hasOwn(body,'leaseEnds')) {
    if (leaseEnds===null || typeof leaseEnds !== 'object' || Array.isArray(leaseEnds)) throw new TypeError('body-presentation: leaseEnds must be an object');
    const ends = {};
    for (const channel of CHANNELS) {
      const value = leaseEnds[channel];
      if (!isDeadline(value)) throw new TypeError(`body-presentation: leaseEnds.${channel} must be a finite non-negative timestamp`);
      ends[channel] = value;
    }
    return ends;
  }
  if (Object.hasOwn(body,'leaseUntil')) {
    if (!isDeadline(leaseUntil)) throw new TypeError('body-presentation: leaseUntil must be a finite non-negative timestamp');
    return {head: leaseUntil, expression: leaseUntil, gaze: leaseUntil};
  }
  return null;
}

/**
 * Project a host body snapshot onto `now` (a finite non-negative millisecond
 * timestamp from the same clock as the snapshot deadlines). Returns
 * {body, nextExpiryAt} where nextExpiryAt is the earliest still-future raw
 * channel deadline, or null when nothing remains scheduled.
 */
export function projectBodyPresentation(body, now) {
  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) throw new TypeError('body-presentation: now must be a finite non-negative timestamp');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('body-presentation: body must be an object');

  const ends = channelDeadlines(body);
  const projected = structuredClone(body);
  if (ends === null) return {body: projected, nextExpiryAt: null};

  const active = {head: ends.head > now, expression: ends.expression > now, gaze: ends.gaze > now};
  projected.leaseEnds = {
    head: active.head ? ends.head : 0,
    expression: active.expression ? ends.expression : 0,
    gaze: active.gaze ? ends.gaze : 0
  };

  if (!active.head) projected.head = {yaw: 0, pitch: 0};

  if (!active.expression && !active.gaze) {
    projected.eyes = {...DEFAULT_EYES};
  } else if (!active.expression) {
    // The live gaze keeps its direction; only the expression eye shape resets.
    projected.eyes = {...DEFAULT_EYES, gazeX: body.eyes?.gazeX ?? 0, gazeY: body.eyes?.gazeY ?? 0};
  } else if (!active.gaze && (ends.gaze>0 || body.gazeBase)) {
    // Uncover the pre-gaze base only while its own deadline is still ahead.
    const base = body.gazeBase;
    const restore = base !== null && typeof base === 'object' && base.until > now;
    projected.eyes = {...structuredClone(body.eyes ?? DEFAULT_EYES), gazeX: restore ? base.gazeX : 0, gazeY: restore ? base.gazeY : 0};
  }

  if (!active.expression) {
    projected.icon = 'none';
    projected.gesture = 'idle';
    projected.expressionCommandId = null;
  }
  if (!active.gaze) projected.gazeBase = null;
  if (!active.head && !active.expression && !active.gaze) projected.activeCommandId = null;

  projected.leaseUntil = Math.max(projected.leaseEnds.head, projected.leaseEnds.expression, projected.leaseEnds.gaze);

  const future = CHANNELS.map(channel => ends[channel]).filter(until => until > now);
  return {body: projected, nextExpiryAt: future.length ? Math.min(...future) : null};
}
