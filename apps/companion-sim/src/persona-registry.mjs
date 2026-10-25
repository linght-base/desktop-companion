// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const MAX_TEXT = 12000;
const MAX_HISTORY = 64;
const MAX_VERSIONS_LIMIT = 64;

function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function body(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT || value.includes('\0')) throw new TypeError('Invalid persona text');
  return value;
}
function sourceId(value) {
  const id = text(value, 'sourceId', 200);
  if (/[/\\]/.test(id) || id.includes('..')) throw new TypeError('sourceId must be a bounded config identifier, not a path');
  return id;
}
function object(input, allowed, name) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    || Object.keys(input).some(key => !allowed.includes(key))) throw new TypeError(`Invalid ${name}`);
}
function timestamp(value, name = 'at') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new TypeError(`Invalid ${name}`);
  return value;
}
const hashOf = value => createHash('sha256').update(value, 'utf8').digest();
const legacyOf = digest => digest.readUInt32BE(0) % 1000000000 + 1;

/**
 * Stable persona version persistence only. The host owns configuration and loading; the model
 * never receives register/activate tools and activation selects persona text, never permissions.
 */
export function createPersonaRegistry({ path, clock = Date.now, maxVersions = 16 }) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new TypeError('Invalid clock');
  if (!Number.isInteger(maxVersions) || maxVersions < 1 || maxVersions > MAX_VERSIONS_LIMIT) throw new TypeError('Invalid maxVersions');
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS persona_versions (
        id TEXT PRIMARY KEY, legacy_version INTEGER NOT NULL, source_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, characters INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS persona_state (
        id TEXT PRIMARY KEY CHECK(id='current'), active_id TEXT, activated_at INTEGER);
      CREATE TABLE IF NOT EXISTS persona_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, at INTEGER NOT NULL);
      INSERT OR IGNORE INTO persona_state(id) VALUES('current');`);
  } catch (error) { db.close(); throw error; }
  const now = () => timestamp(clock(), 'clock');
  const stateRow = () => db.prepare("SELECT * FROM persona_state WHERE id='current'").get();
  const versionRow = id => db.prepare('SELECT * FROM persona_versions WHERE id=?').get(id);
  const descriptor = row => row && {
    id: row.id, legacyVersion: row.legacy_version, sourceId: row.source_id,
    createdAt: row.created_at, characters: row.characters, active: stateRow().active_id === row.id,
  };
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const api = {
    register(input) {
      object(input, ['text', 'sourceId'], 'register');
      const value = body(input.text);
      const source = sourceId(input.sourceId);
      const digest = hashOf(value);
      const id = digest.toString('hex');
      return transaction(() => {
        const existing = versionRow(id);
        if (existing) {
          if (existing.text !== value) throw new TypeError('Persona hash collision with different text');
          return descriptor(existing);
        }
        if (db.prepare('SELECT COUNT(*) AS n FROM persona_versions').get().n >= maxVersions) {
          const active = stateRow().active_id ?? '';
          // Only the oldest non-active version may be evicted, so rollback to the active
          // persona always survives; explicit rollback to an evicted id reads as unknown.
          const oldest = db.prepare('SELECT id FROM persona_versions WHERE id IS NOT ? ORDER BY created_at ASC, rowid ASC LIMIT 1').get(active);
          if (!oldest) throw new TypeError('Persona registry full: only the active version remains');
          db.prepare('DELETE FROM persona_versions WHERE id=?').run(oldest.id);
        }
        const row = { id, legacy_version: legacyOf(digest), source_id: source, created_at: now(), characters: value.length, text: value };
        db.prepare('INSERT INTO persona_versions(id,legacy_version,source_id,created_at,characters,text) VALUES(?,?,?,?,?,?)')
          .run(row.id, row.legacy_version, row.source_id, row.created_at, row.characters, row.text);
        return descriptor(row);
      });
    },
    activate(input) {
      object(input, ['id', 'expectedActiveId'], 'activate');
      const id = text(input.id, 'id', 100);
      if (input.expectedActiveId !== undefined) text(input.expectedActiveId, 'expectedActiveId', 100);
      return transaction(() => {
        const row = versionRow(id);
        if (!row) throw new TypeError('Unknown persona version');
        const state = stateRow();
        if (input.expectedActiveId !== undefined && input.expectedActiveId !== state.active_id) throw new TypeError('Active persona changed since expectedActiveId');
        if (state.active_id === id) return { ...descriptor(row), activatedAt: state.activated_at };
        const at = now();
        db.prepare("UPDATE persona_state SET active_id=?, activated_at=? WHERE id='current'").run(id, at);
        db.prepare('INSERT INTO persona_history(id,at) VALUES(?,?)').run(id, at);
        db.prepare('DELETE FROM persona_history WHERE seq NOT IN (SELECT seq FROM persona_history ORDER BY seq DESC LIMIT ?)').run(MAX_HISTORY);
        return { ...descriptor(row), activatedAt: at };
      });
    },
    getActive() {
      const state = stateRow();
      const row = state.active_id && versionRow(state.active_id);
      return row ? { ...descriptor(row), activatedAt: state.activated_at, text: row.text } : null;
    },
    getVersion(input) {
      object(input, ['id'], 'getVersion');
      const row = versionRow(text(input.id, 'id', 100));
      return row ? { ...descriptor(row), text: row.text } : null;
    },
    list() {
      return db.prepare('SELECT * FROM persona_versions ORDER BY created_at ASC, rowid ASC').all().map(descriptor);
    },
    snapshot() {
      const state = stateRow();
      const active = state.active_id && versionRow(state.active_id);
      return {
        active: active ? { ...descriptor(active), activatedAt: state.activated_at } : null,
        versions: api.list(),
        history: db.prepare('SELECT id,at FROM persona_history ORDER BY seq DESC LIMIT ?').all(MAX_HISTORY),
        limits: { maxVersions, maxHistory: MAX_HISTORY, maxText: MAX_TEXT },
      };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
  return api;
}
