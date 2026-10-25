// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// Rendering vocabulary only: the model maps its grounded reading onto these
// icons. This module never maps an icon back to a scene claim (a cup badge
// never means anyone drank), and never matches scenarios — meaning text is
// model-chosen, tentative, and only as strong as its evidence refs.
const ICONS = ['office', 'home', 'person', 'cup', 'keyboard', 'book', 'plant', 'focus', 'rest', 'question'];
const KINDS = ['environment', 'activity', 'hypothesis'];
const TTL = {
  activity: { defaultMs: 120000, maxMs: 1800000 },
  hypothesis: { defaultMs: 120000, maxMs: 600000 },
};
// Evidence must be a live real record of the same desk at the exact revision.
// 'belief' covers generic hosts; 'understanding'/'hypothesis' cover the
// continuity store's belief kinds.
const EVIDENCE_KINDS = ['perception', 'episode', 'belief', 'understanding', 'hypothesis'];
const LIVE = new Set(['active', 'tentative']);
const MAX_ITEMS = 3;
const MAX_REFS = 8;

function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function timestamp(value, name = 'at') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new TypeError(`Invalid ${name}`);
  return value;
}
function member(value, options, name) {
  if (!options.includes(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
function strictKeys(value, allowed, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Invalid ${name}`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Invalid ${name}`);
}

/**
 * Persisted agent-chosen cognitive badges. Generic by construction: the model
 * supplies icon/meaning/kind plus grounding refs; this host only validates,
 * stores and reconciles. Own connection into the shared database, dedicated
 * table, no images accepted or retained.
 */
export function createCognition({ path, clock = Date.now, resolveEvidence = () => null }) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new TypeError('Invalid clock');
  if (typeof resolveEvidence !== 'function') throw new TypeError('Invalid resolveEvidence');
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS cognition_badges (
      desk_id TEXT NOT NULL, set_seq INTEGER NOT NULL, position INTEGER NOT NULL,
      badge_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(desk_id,set_seq,position));`);
  } catch (error) { db.close(); throw error; }
  const now = () => timestamp(clock(), 'clock');
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Latest set per desk; position -1 marks an accepted empty (clearing) set.
  function latestSet(deskId) {
    const row = db.prepare('SELECT MAX(set_seq) AS seq FROM cognition_badges WHERE desk_id=?').get(deskId);
    const seq = row?.seq ?? 0;
    if (seq === 0) return { seq, items: [] };
    const rows = db.prepare('SELECT position, payload FROM cognition_badges WHERE desk_id=? AND set_seq=? AND position>=0 ORDER BY position').all(deskId, seq);
    return { seq, items: rows.map(entry => JSON.parse(entry.payload)) };
  }
  function validItem(value) {
    strictKeys(value, ['icon', 'meaning', 'kind', 'evidenceRefs', 'ttlMs'], 'badge item');
    const icon = member(value.icon, ICONS, 'badge icon');
    const meaning = text(value.meaning, 'badge meaning', 180);
    const kind = member(value.kind, KINDS, 'badge kind');
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length < 1 || value.evidenceRefs.length > MAX_REFS) throw new TypeError('Invalid evidenceRefs');
    const seen = new Set();
    const evidenceRefs = value.evidenceRefs.map(ref => {
      strictKeys(ref, ['id', 'revision'], 'evidence ref');
      const id = text(ref.id, 'evidence id', 200);
      if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new TypeError('Invalid evidence revision');
      if (!seen.has(id)) seen.add(id); else throw new TypeError('Duplicate evidenceRefs');
      return { id, revision: ref.revision };
    });
    let ttlMs;
    if (kind === 'environment') {
      if (value.ttlMs !== undefined) throw new TypeError('Invalid ttlMs');
    } else {
      const limit = TTL[kind];
      ttlMs = value.ttlMs === undefined ? limit.defaultMs : value.ttlMs;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > limit.maxMs) throw new TypeError('Invalid ttlMs');
    }
    return { icon, meaning, kind, evidenceRefs, ttlMs };
  }
  function resolveRef(ref, deskId) {
    let record;
    try { record = resolveEvidence(ref.id, { deskId }); } catch { return null; }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
    if (record.deskId !== deskId) return null;
    if (record.revision !== ref.revision) return null;
    if (!LIVE.has(record.status)) return null;
    if (!EVIDENCE_KINDS.includes(record.kind)) return null;
    if(!['camera','replay'].includes(record.source))return null;
    return record;
  }
  const visible = (badge, deskId, at) => badge.state === 'visible'
    && (badge.expiresAt === null || at < badge.expiresAt)
    && badge.evidenceRefs.every(ref => resolveRef(ref, deskId));
  return {
    update(input, context) {
      strictKeys(context, ['deskId', 'enabled', 'mode', 'epoch', 'isCurrent'], 'cognition context');
      const deskId = text(context.deskId, 'deskId', 200);
      if (typeof context.enabled !== 'boolean') throw new TypeError('Invalid enabled');
      if (typeof context.mode !== 'string') throw new TypeError('Invalid mode');
      if (!Number.isSafeInteger(context.epoch) || context.epoch < 0) throw new TypeError('Invalid epoch');
      if (typeof context.isCurrent !== 'function') throw new TypeError('Invalid isCurrent');
      if (!context.enabled) return { status: 'rejected', reason: 'disabled', items: [] };
      if (context.mode !== 'cloud') return { status: 'rejected', reason: 'not_supported', items: [] };
      strictKeys(input, ['items'], 'cognition input');
      if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) throw new TypeError('Invalid items');
      // One badge per icon: the finite vocabulary renders each icon at most once.
      const byIcon = new Map();
      for (const item of input.items.map(validItem)) if (!byIcon.has(item.icon)) byIcon.set(item.icon, item);
      const createdAt = now();
      const grounded = [];
      for (const item of byIcon.values()) {
        const refs = [];const observedTimes=[];
        for (const ref of item.evidenceRefs) {
          const record = resolveRef(ref, deskId);
          if (!record) return { status: 'rejected', reason: 'evidence_invalid', items: [] };
          const observedAt=record.endAt??record.observedAt??record.at;if(Number.isFinite(observedAt))observedTimes.push(observedAt);
          // Preserve the source's status and confidence alongside the pinned ref.
          refs.push({ id: ref.id, revision: ref.revision, kind: record.kind, status: record.status,
            ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? { confidence: record.confidence } : {}) });
        }
        grounded.push({ ...item, evidenceRefs: refs, observedAt:observedTimes.length?Math.max(...observedTimes):createdAt });
      }
      return transaction(() => {
        // Currency is decided at commit so a stale epoch can never replace a
        // newer set even if it raced validation.
        if (!context.isCurrent()) return { status: 'rejected', reason: 'stale_context', items: [] };
        const setSeq = latestSet(deskId).seq + 1;
        if (!grounded.length) {
          db.prepare('INSERT INTO cognition_badges(desk_id,set_seq,position,badge_id,payload) VALUES(?,?,?,?,?)')
            .run(deskId, setSeq, -1, `set:${randomUUID()}`, JSON.stringify({ marker: true, deskId, epoch: context.epoch, createdAt }));
        }
        const stored = grounded.map((item, position) => {
          const badge = { id: `badge:${randomUUID()}`, deskId, icon: item.icon, meaning: item.meaning, kind: item.kind,
            evidenceRefs: item.evidenceRefs, epoch: context.epoch, createdAt,
            observedAt:item.observedAt,expiresAt: item.ttlMs === undefined ? null : Math.min(createdAt,item.observedAt) + item.ttlMs,
            state: 'visible', tentative: true, rawImagesRetained: false };
          db.prepare('INSERT INTO cognition_badges(desk_id,set_seq,position,badge_id,payload) VALUES(?,?,?,?,?)')
            .run(deskId, setSeq, position, badge.id, JSON.stringify(badge));
          return badge;
        });
        return { status: 'accepted', reason: 'ok', items: structuredClone(stored) };
      });
    },
    snapshot({ deskId } = {}) {
      deskId = text(deskId, 'deskId', 200);
      const at = now();
      const { items } = latestSet(deskId);
      return { deskId, at, items: structuredClone(items.filter(badge => visible(badge, deskId, at))) };
    },
    reconcile({ deskId } = {}) {
      deskId = text(deskId, 'deskId', 200);
      const at = now();
      return transaction(() => {
        const { seq, items } = latestSet(deskId);
        const expired = [], contradicted = [], visibleItems = [];
        items.forEach((badge, position) => {
          let state = badge.state;
          if (state === 'visible' && badge.expiresAt !== null && at >= badge.expiresAt) state = 'expired';
          if (state === 'visible' && !badge.evidenceRefs.every(ref => resolveRef(ref, deskId))) state = 'contradicted';
          if (state !== badge.state) {
            badge.state = state;
            db.prepare('UPDATE cognition_badges SET payload=? WHERE desk_id=? AND set_seq=? AND position=?').run(JSON.stringify(badge), deskId, seq, position);
          }
          if (state === 'expired') expired.push(badge.id);
          else if (state === 'contradicted') contradicted.push(badge.id);
          else visibleItems.push(badge);
        });
        return { deskId, at, expired, contradicted, items: structuredClone(visibleItems) };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
