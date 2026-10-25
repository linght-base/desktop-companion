// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const MAX = 50;
const KINDS = ['fact', 'hypothesis', 'action', 'preference'];
const MEMORY_STATUSES = ['active', 'invalidated', 'superseded', 'deleted'];
const ATTENTION_STATUSES = ['active', 'resolved', 'dismissed', 'paused'];
const LEARNING_STATUSES = ['active', 'rejected', 'rolled_back'];
const IMMUTABLE_SCOPE = /persona|personality|identity|pause|stop|safety|privacy|permission|boundary|人设|人格|暂停|停止|安全|隐私|权限/i;

function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new TypeError(`${name} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}
function member(value, values, name) {
  if (!values.includes(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}
function timestamp(value, name = 'at') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new TypeError(`Invalid ${name}`);
  return value;
}
function evidenceIds(value = []) {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError('evidenceIds must have at most 32 entries');
  return [...new Set(value.map(id => text(id, 'evidence id', 200)))];
}
function limit(value = 12) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('limit must be a positive integer');
  return Math.min(value, MAX);
}
function unpack(row) { return row ? JSON.parse(row.payload) : null; }
function rows(statement, ...params) { return statement.all(...params).map(unpack); }
function validScope(value) {
  const scope = text(value, 'scope', 200);
  if (IMMUTABLE_SCOPE.test(scope)) throw new TypeError('Learning scope cannot change stable persona or safety boundaries');
  return scope;
}

/** Synchronous local continuity. The host alone owns inference, clocks, and action authority. */
export function createStore({ path, clock = Date.now }) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT NOT NULL, revision INTEGER NOT NULL, at INTEGER NOT NULL,
        kind TEXT NOT NULL, summary TEXT NOT NULL, subject TEXT, status TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY (id, revision)
      );
      CREATE INDEX IF NOT EXISTS memory_at ON memory_revisions(at);
      CREATE TABLE IF NOT EXISTS attention (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, next_at INTEGER, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wakes (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wakes_due ON wakes(status, at);
      CREATE TABLE IF NOT EXISTS learning (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL
      );
      -- A claim is not successful delivery. Recover interrupted host work on reopen.
      UPDATE wakes SET status = 'scheduled',
        payload = json_remove(json_set(payload, '$.status', 'scheduled'), '$.claimedAt')
        WHERE status = 'claimed';
    `);
  } catch (error) { db.close(); throw error; }
  const now = () => timestamp(clock(), 'clock');
  const latest = db.prepare('SELECT payload FROM memory_revisions WHERE id = ? ORDER BY revision DESC LIMIT 1');
  const insertMemory = db.prepare('INSERT INTO memory_revisions (id,revision,at,kind,summary,subject,status,payload) VALUES (?,?,?,?,?,?,?,?)');
  const currentOnly = 'm.revision = (SELECT MAX(revision) FROM memory_revisions WHERE id = m.id)';
  const putMemory = record => insertMemory.run(record.id, record.revision, record.at, record.kind, record.summary, record.subject ?? null, record.status, JSON.stringify(record));
  const getLearning = id => unpack(db.prepare('SELECT payload FROM learning WHERE id = ?').get(id));
  const putLearning = record => db.prepare('INSERT INTO learning (id,status,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(record.id, record.status, JSON.stringify(record));
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function storedEvidence(id) {
    const record = unpack(latest.get(id));
    return record?.status === 'active' && ['fact', 'action'].includes(record.kind) ? record : null;
  }
  function finishClaim(id, status) {
    text(id, 'id', 200);
    return transaction(() => {
      const previous = unpack(db.prepare("SELECT payload FROM wakes WHERE id = ? AND status = 'claimed'").get(id));
      if (!previous) return false;
      const record = { ...previous, status };
      delete record.claimedAt;
      if (status === 'consumed') record.consumedAt = now();
      db.prepare("UPDATE wakes SET status = ?, payload = ? WHERE id = ? AND status = 'claimed'").run(status, JSON.stringify(record), id);
      return true;
    });
  }

  return {
    append({ kind, summary, subject, evidenceIds: ids, confidence, status = 'active' }) {
      const record = {
        id: randomUUID(), at: now(), revision: 1,
        kind: member(kind, KINDS, 'kind'), summary: text(summary, 'summary'),
        evidenceIds: evidenceIds(ids), status: member(status, MEMORY_STATUSES, 'status'),
      };
      if (subject !== undefined) record.subject = text(subject, 'subject', 200);
      if (confidence !== undefined) {
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new TypeError('confidence must be between 0 and 1');
        record.confidence = confidence;
      }
      putMemory(record);
      return record;
    },
    revise(id, { summary, status, reason }) {
      text(id, 'id', 200);
      reason = text(reason, 'reason');
      if (summary !== undefined) summary = text(summary, 'summary');
      if (status !== undefined) member(status, MEMORY_STATUSES, 'status');
      return transaction(() => {
        const previous = unpack(latest.get(id));
        if (!previous) throw new Error('Unknown memory id');
        const record = { ...previous, revision: previous.revision + 1, previousRevision: previous.revision, updatedAt: now(), reason };
        if (summary !== undefined) record.summary = summary;
        if (status !== undefined) record.status = status;
        putMemory(record);
        // Even an active correction changes the evidence used to approve a candidate.
        // Keep the old evidence revision auditable and require a fresh proposal.
        for (const candidate of rows(db.prepare("SELECT payload FROM learning WHERE status = 'active'"))) {
          if (candidate.evidenceIds.includes(id)) putLearning({ ...candidate, status: 'rolled_back', updatedAt: now(), reason: `Evidence ${id} revised: ${reason}` });
        }
        return record;
      });
    },
    query({ query, subject, limit: count } = {}) {
      const clauses = [currentOnly, "m.status = 'active'"];
      const params = [];
      if (query !== undefined && query !== '') {
        const escaped = text(query, 'query', 500).replace(/[\\%_]/g, '\\$&');
        clauses.push("m.summary LIKE ? ESCAPE '\\'"); params.push(`%${escaped}%`);
      }
      if (subject !== undefined) { clauses.push('m.subject = ?'); params.push(text(subject, 'subject', 200)); }
      params.push(limit(count));
      return rows(db.prepare(`SELECT m.payload FROM memory_revisions m WHERE ${clauses.join(' AND ')} ORDER BY m.at DESC, m.rowid DESC LIMIT ?`), ...params);
    },
    snapshot() {
      return {
        memories: this.query(), attention: this.listAttention(),
        wakes: rows(db.prepare("SELECT payload FROM wakes WHERE status IN ('scheduled','claimed') ORDER BY at, rowid LIMIT 50")),
        learning: rows(db.prepare('SELECT payload FROM learning ORDER BY rowid DESC LIMIT 50')),
      };
    },
    upsertAttention({ id, question, summary, nextAt, status = 'active' }) {
      const previous = id === undefined ? null : unpack(db.prepare('SELECT payload FROM attention WHERE id = ?').get(text(id, 'id', 200)));
      const record = {
        id: id ?? randomUUID(), at: previous?.at ?? now(), updatedAt: now(),
        question: text(question, 'question', 1000), status: member(status, ATTENTION_STATUSES, 'status'),
      };
      if (summary !== undefined) record.summary = text(summary, 'summary');
      else if (previous?.summary !== undefined) record.summary = previous.summary;
      if (nextAt !== undefined) record.nextAt = timestamp(nextAt, 'nextAt');
      else if (previous?.nextAt !== undefined) record.nextAt = previous.nextAt;
      db.prepare('INSERT INTO attention(id,status,next_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_at=excluded.next_at,payload=excluded.payload').run(record.id, record.status, record.nextAt ?? null, JSON.stringify(record));
      return record;
    },
    listAttention() {
      return rows(db.prepare("SELECT payload FROM attention WHERE status = 'active' ORDER BY next_at IS NULL, next_at, rowid DESC LIMIT 50"));
    },
    scheduleWake({ id, at, reason, attentionId }) {
      const record = { id: id === undefined ? randomUUID() : text(id, 'id', 200), at: timestamp(at), reason: text(reason, 'reason'), status: 'scheduled', createdAt: now() };
      if (attentionId !== undefined) {
        record.attentionId = text(attentionId, 'attentionId', 200);
        if (!db.prepare('SELECT id FROM attention WHERE id = ?').get(record.attentionId)) throw new Error('Unknown attention id');
      }
      const previous = unpack(db.prepare('SELECT payload FROM wakes WHERE id = ?').get(record.id));
      if (previous && previous.status !== 'scheduled') throw new Error('Claimed, consumed or cancelled wake id cannot be reused');
      if (previous) record.createdAt = previous.createdAt;
      db.prepare('INSERT INTO wakes(id,at,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,status=excluded.status,payload=excluded.payload').run(record.id, record.at, record.status, JSON.stringify(record));
      return record;
    },
    takeDueWakes(at) {
      timestamp(at);
      return transaction(() => {
        const due = rows(db.prepare("SELECT payload FROM wakes WHERE status = 'scheduled' AND at <= ? ORDER BY at, rowid LIMIT 50"), at);
        return due.map(record => {
          const consumed = { ...record, status: 'consumed', consumedAt: at };
          db.prepare('UPDATE wakes SET status = ?, payload = ? WHERE id = ?').run(consumed.status, JSON.stringify(consumed), record.id);
          return consumed;
        });
      });
    },
    claimDueWakes(at, count = 20) {
      timestamp(at);
      count = limit(count);
      return transaction(() => {
        const due = rows(db.prepare("SELECT payload FROM wakes WHERE status = 'scheduled' AND at <= ? ORDER BY at, rowid LIMIT ?"), at, count);
        return due.map(record => {
          const claimed = { ...record, status: 'claimed', claimedAt: at };
          db.prepare("UPDATE wakes SET status = ?, payload = ? WHERE id = ? AND status = 'scheduled'").run(claimed.status, JSON.stringify(claimed), record.id);
          return claimed;
        });
      });
    },
    acknowledgeWake(id) { return finishClaim(id, 'consumed'); },
    releaseWake(id) { return finishClaim(id, 'scheduled'); },
    cancelWake(id) {
      text(id, 'id', 200);
      const previous = unpack(db.prepare("SELECT payload FROM wakes WHERE id = ? AND status IN ('scheduled','claimed')").get(id));
      if (!previous) return false;
      const record = { ...previous, status: 'cancelled', cancelledAt: now() };
      db.prepare('UPDATE wakes SET status = ?,payload = ? WHERE id = ?').run(record.status, JSON.stringify(record), id);
      return true;
    },
    proposeLearning({ summary, evidenceIds: ids, scope }) {
      ids = evidenceIds(ids);
      const record = { id: randomUUID(), at: now(), status: 'candidate', summary: text(summary, 'summary'), scope: validScope(scope), evidenceIds: ids,
        evidenceRevisions: Object.fromEntries(ids.map(id => [id, storedEvidence(id)?.revision ?? null])) };
      putLearning(record);
      return record;
    },
    setLearningStatus(id, { status, reason }) {
      text(id, 'id', 200);
      member(status, LEARNING_STATUSES, 'learning status');
      reason = text(reason, 'reason');
      const previous = getLearning(id);
      if (!previous) throw new Error('Unknown learning id');
      if (status === 'active') {
        validScope(previous.scope);
        if (!previous.evidenceIds.length || !previous.evidenceIds.every(id => {
          const evidence = storedEvidence(id);
          return evidence && evidence.revision === previous.evidenceRevisions[id];
        })) throw new Error('Learning requires current active fact/action evidence from this store');
      }
      const record = { ...previous, status, reason, updatedAt: now(), previousStatus: previous.status };
      putLearning(record);
      return record;
    },
    diary({ day }) {
      if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('day must be YYYY-MM-DD');
      const start = Date.parse(`${day}T00:00:00+08:00`);
      if (!Number.isFinite(start) || new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== day) throw new TypeError('Invalid calendar day');
      const records = rows(db.prepare(`SELECT m.payload FROM memory_revisions m WHERE ${currentOnly} AND m.status = 'active' AND m.kind IN ('fact','action') AND m.at >= ? AND m.at < ? ORDER BY m.at, m.rowid LIMIT 50`), start, start + 86400000);
      return { day, panels: records.map(record => ({ id: record.id, at: record.at, summary: record.summary, evidenceIds: [...new Set([record.id, ...record.evidenceIds])] })), gaps: [] };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
