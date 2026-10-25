// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Bounded declarative round-screen recipes: schema check at propose, structural check against
// current capabilities, and pure deterministic sampling. Value ranges are delegated to
// contracts.mjs validateIntent so the library can never drift from the wire contract.
import { validateIntent } from '../contracts.mjs';

export const HARD_LIMITS = Object.freeze({
  minDurationMs: 100, maxDurationMs: 5000, minKeyframes: 2, maxKeyframes: 32,
  icons: Object.freeze(['none', 'question', 'sparkle', 'clock', 'check', 'water', 'movement', 'posture']),
  gestures: Object.freeze(['idle', 'wave', 'jump', 'waiting', 'review']),
  eyesFields: Object.freeze(['gazeX', 'gazeY', 'openness', 'tilt', 'roundness', 'color']),
  numericEyes: Object.freeze({ gazeX: [-1, 1], gazeY: [-1, 1], openness: [0.05, 1.2], tilt: [-30, 30], roundness: [0, 1] }),
});
const KEYFRAME_FIELDS = ['atMs', 'eyes', 'icon', 'gesture'];

export function validateCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_capabilities: not an object');
  if (typeof value.version !== 'string' || !value.version.trim() || value.version.length > 100) throw new Error('invalid_capabilities: version');
  if (typeof value.eyes !== 'boolean') throw new Error('invalid_capabilities: eyes');
  const subset = (list, allowed, name) => {
    if (!Array.isArray(list)) throw new Error(`invalid_capabilities: ${name}`);
    const seen = new Set();
    for (const entry of list) {
      if (typeof entry !== 'string' || !allowed.includes(entry)) throw new Error(`invalid_capabilities: ${name}`);
      if (seen.has(entry)) throw new Error(`invalid_capabilities: duplicate ${name}`);
      seen.add(entry);
    }
    return [...seen];
  };
  const maxDurationMs = value.maxDurationMs === undefined ? HARD_LIMITS.maxDurationMs : value.maxDurationMs;
  const maxKeyframes = value.maxKeyframes === undefined ? HARD_LIMITS.maxKeyframes : value.maxKeyframes;
  if (typeof maxDurationMs !== 'number' || !Number.isFinite(maxDurationMs)
    || maxDurationMs < HARD_LIMITS.minDurationMs || maxDurationMs > HARD_LIMITS.maxDurationMs) throw new Error('invalid_capabilities: maxDurationMs');
  if (typeof maxKeyframes !== 'number' || !Number.isInteger(maxKeyframes)
    || maxKeyframes < HARD_LIMITS.minKeyframes || maxKeyframes > HARD_LIMITS.maxKeyframes) throw new Error('invalid_capabilities: maxKeyframes');
  // Unknown capability fields are ignored here: they never widen what a recipe may contain.
  return Object.freeze({
    version: value.version, eyes: value.eyes,
    icons: Object.freeze(subset(value.icons, HARD_LIMITS.icons, 'icons')),
    gestures: Object.freeze(subset(value.gestures, HARD_LIMITS.gestures, 'gestures')),
    maxDurationMs, maxKeyframes,
  });
}

/** Schema gate at propose time: type/shape only. Rejects unknown fields, non-numbers, NaN/Infinity,
 *  head/text/audio/script/URL payloads and empty keyframes before anything is written to the ledger. */
export function checkRecipeSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_recipe');
  if (Object.keys(value).some(key => !['durationMs', 'keyframes'].includes(key))) throw new Error('invalid_recipe_field');
  const { durationMs, keyframes } = value;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)
    || durationMs < HARD_LIMITS.minDurationMs || durationMs > HARD_LIMITS.maxDurationMs) throw new Error('invalid_duration');
  if (!Array.isArray(keyframes) || keyframes.length < HARD_LIMITS.minKeyframes) throw new Error('invalid_keyframes');
  if (keyframes.length > HARD_LIMITS.maxKeyframes) throw new Error('too_many_keyframes');
  keyframes.forEach((frame, index) => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error(`invalid_keyframe:${index}`);
    if (Object.keys(frame).some(key => !KEYFRAME_FIELDS.includes(key))) throw new Error(`invalid_keyframe_field:${index}`);
    if (frame.atMs === undefined || typeof frame.atMs !== 'number' || !Number.isFinite(frame.atMs) || frame.atMs < 0) throw new Error(`invalid_keyframe_time:${index}`);
    if (frame.eyes === undefined && frame.icon === undefined && frame.gesture === undefined) throw new Error(`invalid_keyframe_empty:${index}`);
    if (frame.eyes !== undefined) {
      if (!frame.eyes || typeof frame.eyes !== 'object' || Array.isArray(frame.eyes)) throw new Error(`invalid_eyes:${index}`);
      if (Object.keys(frame.eyes).some(key => !HARD_LIMITS.eyesFields.includes(key))) throw new Error(`invalid_eyes_field:${index}`);
      for (const [key, entry] of Object.entries(frame.eyes)) {
        if (key === 'color') {
          if (typeof entry !== 'string' || entry.length > 100) throw new Error(`invalid_eyes:${index}`);
        } else if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new Error(`invalid_eyes:${index}`);
      }
    }
    for (const key of ['icon', 'gesture']) if (frame[key] !== undefined && (typeof frame[key] !== 'string' || frame[key].length > 100)) throw new Error(`invalid_keyframe:${index}`);
  });
  return structuredClone({ durationMs, keyframes });
}

/** Full structural check against the CURRENT capabilities. Delegates per-keyframe value ranges to
 *  contracts.validateIntent so gaze/openness/tilt/roundness/color stay identical to the wire contract. */
export function structuralCheck(recipe, capabilities) {
  const issues = [];
  try { checkRecipeSchema(recipe); } catch (error) { return { status: 'failed', at: null, capabilityVersion: capabilities.version, issues: [error.message] }; }
  if (recipe.durationMs > capabilities.maxDurationMs) issues.push('duration_exceeds_capability');
  if (recipe.keyframes.length > capabilities.maxKeyframes) issues.push('too_many_keyframes_for_capability');
  if (recipe.keyframes[0].atMs !== 0) issues.push('first_keyframe_not_zero');
  if (recipe.keyframes.at(-1).atMs !== recipe.durationMs) issues.push('last_keyframe_mismatch');
  for (let i = 1; i < recipe.keyframes.length; i++) if (recipe.keyframes[i].atMs <= recipe.keyframes[i - 1].atMs) issues.push('keyframe_order');
  if (!capabilities.eyes && recipe.keyframes.some(frame => frame.eyes !== undefined)) issues.push('eyes_not_supported');
  recipe.keyframes.forEach((frame, index) => {
    if (frame.icon !== undefined && !capabilities.icons.includes(frame.icon)) issues.push(`icon_not_supported:${index}`);
    if (frame.gesture !== undefined && !capabilities.gestures.includes(frame.gesture)) issues.push(`gesture_not_supported:${index}`);
    try {
      validateIntent({
        basisObservationId: 'expression-recipe', durationMs: recipe.durationMs,
        ...(frame.eyes === undefined ? {} : { eyes: frame.eyes }),
        ...(frame.icon === undefined ? {} : { icon: frame.icon }),
        ...(frame.gesture === undefined ? {} : { gesture: frame.gesture }),
      });
    } catch (error) { issues.push(`keyframe_${index}:${error.message}`); }
  });
  return { status: issues.length ? 'failed' : 'passed', at: null, capabilityVersion: capabilities.version, issues };
}

const channelOf = color => [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
const hexOf = channels => `#${channels.map(channel => Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, '0').toUpperCase()).join('')}`;
const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));

/** Effective values at a keyframe: unspecified eyes params inherit the previous keyframe; the first
 *  keyframe stays unspecified. icon/gesture switch stepwise on the keyframe where they are stated. */
function effectiveAt(keyframes, index, field, key) {
  for (let i = index; i >= 0; i--) {
    const frame = keyframes[i];
    if (field === 'eyes' ? frame.eyes?.[key] !== undefined : frame[field] !== undefined) return field === 'eyes' ? frame.eyes[key] : frame[field];
  }
  return undefined;
}

/** Pure bounded deterministic sampling. No timers, no callbacks, no rendering loop: the caller owns
 *  display timing, lease, pause and preemption. */
export function sampleRecipe(recipe, elapsedMs) {
  const frames = recipe.keyframes;
  const durationMs = recipe.durationMs;
  const clampedMs = Math.min(Math.max(elapsedMs, 0), durationMs);
  let index = frames.length - 1;
  for (let i = 0; i < frames.length; i++) { if (frames[i].atMs <= clampedMs) index = i; else break; }
  const finished = elapsedMs >= durationMs;
  const next = index < frames.length - 1 ? frames[index + 1] : null;
  const fraction = next ? (clampedMs - frames[index].atMs) / (next.atMs - frames[index].atMs) : 1;
  const safeFraction = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const eyes = {};
  for (const key of HARD_LIMITS.eyesFields) {
    const from = effectiveAt(frames, index, 'eyes', key);
    if (from === undefined) continue;
    const to = next === null ? from : (effectiveAt(frames, index + 1, 'eyes', key) ?? from);
    if (key === 'color') {
      const fromChannels = channelOf(from); const toChannels = channelOf(to);
      eyes.color = hexOf(fromChannels.map((channel, i) => channel + (toChannels[i] - channel) * safeFraction));
    } else {
      const [min, max] = HARD_LIMITS.numericEyes[key];
      eyes[key] = clamp(from + (to - from) * safeFraction, [min, max]);
    }
  }
  const icon = effectiveAt(frames, index, 'icon');
  const gesture = effectiveAt(frames, index, 'gesture');
  return {
    ...(Object.keys(eyes).length ? { eyes } : {}),
    ...(icon === undefined ? {} : { icon }),
    ...(gesture === undefined ? {} : { gesture }),
    finished,
  };
}
