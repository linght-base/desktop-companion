// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const MEANING_MAX = 500;
const METHOD_MAX = 1500;
const MAX_REFS = 12;
const MAX_CANDIDATES = 32;
const MAX_REQUESTS = 128;
const MAX_SESSIONS = 64;
const MAX_RETIRED = 64;
const MAX_HISTORY_PER_METHOD = 8;
const MAX_HISTORY = 1024;
const MAX_TOMBSTONES = 128;
const MAX_LIMIT = 32;
const SNAPSHOT_LIMIT = 50;
const SOURCES = { perception: ['camera', 'replay'], episode: ['camera', 'replay'], interaction: ['explicit_user'] };
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function timestamp(value, name = 'at') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new TypeError(`Invalid ${name}`);
  return value;
}
function versionTag(value) {
  if (Number.isSafeInteger(value) && value >= 1) return String(value);
  return text(value, 'personaVersion', 200);
}
function refs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REFS) throw new TypeError('Invalid evidenceRefs');
  const seen = new Set();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object') throw new TypeError('Invalid evidenceRefs');
    const id = text(ref.id, 'evidence id', 200);
    if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new TypeError('Invalid evidence revision');
    if (seen.has(id)) throw new TypeError('Duplicate evidence id');
    seen.add(id);
    return { id, revision: ref.revision };
  });
}
function tokens(value) {
  const normalized = value.normalize('NFKC').toLowerCase();
  const words = [...segmenter.segment(normalized)].filter(part => part.isWordLike).map(part => part.segment);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words.filter(word => word.length > 1 || /[a-z0-9]/.test(word)))];
}
const hashOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Sourced behavior-method accumulation. Method text is untrusted reference for the same Pi
 *  only: never code, device instructions, permissions, or a change to the stable persona. */
export function createBehaviorMethods({ path, clock = Date.now, resolveEvidence }) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new TypeError('Invalid clock');
  if (typeof resolveEvidence !== 'function') throw new TypeError('Invalid resolveEvidence');
  const db = new DatabaseSync(path);
  let closed = false;
  const now = () => timestamp(clock(), 'clock');
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS method_methods (
      id TEXT PRIMARY KEY, desk_id TEXT NOT NULL, persona_version TEXT NOT NULL,
      request_id TEXT NOT NULL, meaning TEXT NOT NULL, method TEXT NOT NULL,
      evidence_refs TEXT NOT NULL, status TEXT NOT NULL, semantic_status TEXT NOT NULL,
      revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS method_requests (
      desk_id TEXT NOT NULL, persona_version TEXT NOT NULL, request_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, method_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(desk_id,persona_version,request_id));
      CREATE TABLE IF NOT EXISTS method_sessions (
      session_id TEXT PRIMARY KEY, desk_id TEXT NOT NULL, persona_version TEXT NOT NULL,
      enabled INTEGER NOT NULL, method_ids TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, stopped_at INTEGER);
      CREATE TABLE IF NOT EXISTS method_history (
      method_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
      meaning TEXT NOT NULL, method TEXT NOT NULL, evidence_refs TEXT NOT NULL,
      changed_at INTEGER NOT NULL, PRIMARY KEY(method_id,revision));
      CREATE TABLE IF NOT EXISTS method_tombstones (key TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
    // A restart restores methods only; sessions and execution authority never carry over.
    db.exec("UPDATE method_sessions SET status='stopped' WHERE status='active'");
  } catch (error) { db.close(); throw error; }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function resolve(ref, deskId) {
    let record;
    try { record = resolveEvidence(ref.id, { deskId }); } catch { return null; }
    return record && typeof record === 'object' ? record : null;
  }
  // Current state is resolved on every call; this module never reads continuity tables.
  function evidenceCurrent(ref, deskId) {
    const record = resolve(ref, deskId);
    if (!record || record.id !== ref.id || record.status !== 'active' || record.deskId !== deskId || record.revision !== ref.revision) return false;
    if (['test','holdout','denied'].includes(record.learningUse)) return false;
    const allowed = SOURCES[record.kind];
    return Boolean(allowed) && allowed.includes(record.source);
  }
  const toMethod = row => row && ({
    id: row.id, requestId: row.request_id, deskId: row.desk_id, personaVersion: row.persona_version,
    meaning: row.meaning, method: row.method, evidenceRefs: JSON.parse(row.evidence_refs),
    status: row.status, semanticStatus: row.semantic_status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const toSession = row => row && ({
    sessionId: row.session_id, deskId: row.desk_id, personaVersion: row.persona_version,
    enabled: row.enabled === 1, status: row.status, methodIds: JSON.parse(row.method_ids),
    createdAt: row.created_at, ...(row.stopped_at === null || row.stopped_at === undefined ? {} : { stoppedAt: row.stopped_at }),
  });
  const methodRow = id => db.prepare('SELECT * FROM method_methods WHERE id=?').get(id);
  const sessionRow = id => db.prepare('SELECT * FROM method_sessions WHERE session_id=?').get(id);
  function scopeRows(deskId, personaVersion, statuses) {
    const marks = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM method_methods WHERE desk_id=? AND persona_version=? AND status IN (${marks}) ORDER BY updated_at DESC`).all(deskId, personaVersion, ...statuses);
  }
  function archive(row, at) {
    db.prepare('INSERT INTO method_history(method_id,revision,status,meaning,method,evidence_refs,changed_at) VALUES(?,?,?,?,?,?,?)')
      .run(row.id, row.revision, row.status, row.meaning, row.method, row.evidence_refs, at);
    db.prepare(`DELETE FROM method_history WHERE method_id=? AND revision NOT IN
      (SELECT revision FROM method_history WHERE method_id=? ORDER BY changed_at DESC LIMIT ?)`).run(row.id, row.id, MAX_HISTORY_PER_METHOD);
    db.prepare(`DELETE FROM method_history WHERE rowid NOT IN
      (SELECT rowid FROM method_history ORDER BY changed_at DESC LIMIT ?)`).run(MAX_HISTORY);
  }
  function dropMethod(id) {
    db.prepare('DELETE FROM method_methods WHERE id=?').run(id);
    db.prepare('DELETE FROM method_history WHERE method_id=?').run(id);
    db.prepare('DELETE FROM method_requests WHERE method_id=?').run(id);
    for (const session of db.prepare("SELECT * FROM method_sessions WHERE method_ids LIKE '%'||?||'%' ESCAPE '\\'").all(id.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_'))) {
      const ids = JSON.parse(session.method_ids);
      if (!ids.includes(id)) continue;
      db.prepare('UPDATE method_sessions SET method_ids=? WHERE session_id=?').run(JSON.stringify(ids.filter(item => item !== id)), session.session_id);
    }
  }
  function tombstone(key, at) {
    db.prepare('INSERT OR REPLACE INTO method_tombstones(key,at) VALUES(?,?)').run(hashOf(key), at);
    db.prepare(`DELETE FROM method_tombstones WHERE rowid NOT IN
      (SELECT rowid FROM method_tombstones ORDER BY at DESC LIMIT ?)`).run(MAX_TOMBSTONES);
  }
  function pruneScope(deskId, personaVersion) {
    db.prepare(`DELETE FROM method_requests WHERE desk_id=? AND persona_version=? AND rowid NOT IN
      (SELECT rowid FROM method_requests WHERE desk_id=? AND persona_version=? ORDER BY created_at DESC LIMIT ?)`)
      .run(deskId, personaVersion, deskId, personaVersion, MAX_REQUESTS);
    for (const row of db.prepare(`SELECT session_id FROM method_sessions WHERE desk_id=? AND persona_version=? ORDER BY
      CASE status WHEN 'stopped' THEN 0 ELSE 1 END, created_at DESC LIMIT -1 OFFSET ?`).all(deskId, personaVersion, MAX_SESSIONS)) {
      db.prepare('DELETE FROM method_sessions WHERE session_id=?').run(row.session_id);
    }
    for (const row of scopeRows(deskId, personaVersion, ['revoked', 'source_invalidated']).slice(MAX_RETIRED)) dropMethod(row.id);
  }
  return {
    propose({ requestId, meaning, method, evidenceRefs } = {}, { deskId, personaVersion } = {}) {
      requestId = text(requestId, 'requestId', 200);
      meaning = text(meaning, 'meaning', MEANING_MAX);
      method = text(method, 'method', METHOD_MAX);
      deskId = text(deskId, 'deskId', 200);
      personaVersion = versionTag(personaVersion);
      const references = refs(evidenceRefs);
      const contentHash = hashOf([deskId, personaVersion, meaning, method, references]);
      return transaction(() => {
        const prior = db.prepare('SELECT * FROM method_requests WHERE desk_id=? AND persona_version=? AND request_id=?').get(deskId, personaVersion, requestId);
        if (prior) {
          if (prior.content_hash !== contentHash) return { accepted: false, status: 'rejected', reason: 'request_conflict', requestId };
          const replayed = methodRow(prior.method_id);
          if (replayed) return toMethod(replayed);
        }
        for (const ref of references) {
          if (!evidenceCurrent(ref, deskId)) return { accepted: false, status: 'rejected', reason: 'evidence_not_current', evidenceId: ref.id };
        }
        if (scopeRows(deskId, personaVersion, ['candidate']).length >= MAX_CANDIDATES) {
          return { accepted: false, status: 'rejected', reason: 'candidate_limit', limit: MAX_CANDIDATES };
        }
        const at = now();
        const id = randomUUID();
        db.prepare(`INSERT INTO method_methods(id,desk_id,persona_version,request_id,meaning,method,evidence_refs,status,semantic_status,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'candidate','unverified',1,?,?)`)
          .run(id, deskId, personaVersion, requestId, meaning, method, JSON.stringify(references), at, at);
        db.prepare('INSERT OR REPLACE INTO method_requests(desk_id,persona_version,request_id,content_hash,method_id,created_at) VALUES(?,?,?,?,?,?)')
          .run(deskId, personaVersion, requestId, contentHash, id, at);
        pruneScope(deskId, personaVersion);
        return toMethod(methodRow(id));
      });
    },
    activateForSession({ sessionId, deskId, personaVersion, enabled } = {}) {
      sessionId = text(sessionId, 'sessionId', 200);
      deskId = text(deskId, 'deskId', 200);
      personaVersion = versionTag(personaVersion);
      if (typeof enabled !== 'boolean') throw new TypeError('Invalid enabled');
      return transaction(() => {
        const prior = sessionRow(sessionId);
        if (prior) {
          if (prior.desk_id !== deskId || prior.persona_version !== personaVersion) {
            return { accepted: false, status: 'rejected', reason: 'session_scope_conflict', sessionId };
          }
          // Idempotent replay: the fixed set for this wake never expands.
          return { accepted: true, ...toSession(prior), activated: JSON.parse(prior.method_ids).length };
        }
        const at = now();
        let ids = [];
        if (enabled) {
          ids = scopeRows(deskId, personaVersion, ['candidate'])
            .filter(row => row.created_at <= at && JSON.parse(row.evidence_refs).every(ref => evidenceCurrent(ref, deskId)))
            .map(row => row.id);
        }
        db.prepare('INSERT INTO method_sessions(session_id,desk_id,persona_version,enabled,method_ids,status,created_at,stopped_at) VALUES(?,?,?,?,?,?,?,NULL)')
          .run(sessionId, deskId, personaVersion, enabled ? 1 : 0, JSON.stringify(ids), 'active', at);
        pruneScope(deskId, personaVersion);
        return { accepted: true, ...toSession(sessionRow(sessionId)), activated: ids.length };
      });
    },
    query({ sessionId, deskId, meaning, limit = 6 } = {}) {
      sessionId = text(sessionId, 'sessionId', 200);
      deskId = text(deskId, 'deskId', 200);
      if (meaning !== undefined) meaning = text(meaning, 'meaning', MEANING_MAX);
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Invalid limit');
      limit = Math.min(limit, MAX_LIMIT);
      const session = sessionRow(sessionId);
      if (!session || session.desk_id !== deskId || session.status !== 'active' || session.enabled !== 1) return [];
      const phrase = meaning === undefined ? '' : meaning.normalize('NFKC').toLowerCase();
      const queryTokens = phrase ? tokens(phrase) : [];
      if (phrase && !queryTokens.length) return [];
      const ranked = [];
      for (const id of JSON.parse(session.method_ids)) {
        const row = methodRow(id);
        if (!row || row.status !== 'candidate') continue;
        const references = JSON.parse(row.evidence_refs);
        if (!references.every(ref => evidenceCurrent(ref, deskId))) continue;
        let score = 0, hits = [], exact = false;
        if (phrase) {
          const content = `${row.meaning} ${row.method}`.normalize('NFKC').toLowerCase();
          const contentTokens = tokens(content);
          hits = queryTokens.filter(token => contentTokens.includes(token));
          exact = content.includes(phrase);
          if (!hits.length && !exact) continue;
          score = (exact ? 100 : 0) + hits.reduce((sum, token) => sum + token.length, 0);
        }
        ranked.push({ row, references, score, hits, exact });
      }
      ranked.sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at);
      return ranked.slice(0, limit).map(({ row, references, hits, exact }) => ({
        id: row.id, meaning: row.meaning, method: row.method, evidenceRefs: references,
        status: row.status, semanticStatus: row.semantic_status, revision: row.revision, createdAt: row.created_at,
        referenceOnly: true,
        matchReason: phrase ? `相关词：${hits.join('、')}${exact ? '；原文匹配' : ''}` : '本次苏醒已激活且来源仍当前',
      }));
    },
    revoke({ id } = {}, { deskId, personaVersion } = {}) {
      id = text(id, 'id', 200);
      deskId = text(deskId, 'deskId', 200);
      personaVersion = versionTag(personaVersion);
      return transaction(() => {
        const row = methodRow(id);
        if (!row || row.desk_id !== deskId || row.persona_version !== personaVersion) return { accepted: false, status: 'rejected', reason: 'unknown_method', id };
        if (row.status === 'revoked') return toMethod(row);
        archive(row, now());
        db.prepare("UPDATE method_methods SET status='revoked', revision=revision+1, updated_at=? WHERE id=?").run(now(), id);
        return toMethod(methodRow(id));
      });
    },
    stopSession(sessionId) {
      sessionId = text(sessionId, 'sessionId', 200);
      return transaction(() => {
        const row = sessionRow(sessionId);
        if (!row) return { accepted: false, status: 'rejected', reason: 'unknown_session', sessionId };
        if (row.status === 'stopped') return { accepted: true, ...toSession(row) };
        db.prepare("UPDATE method_sessions SET status='stopped', stopped_at=? WHERE session_id=?").run(now(), sessionId);
        return { accepted: true, ...toSession(sessionRow(sessionId)) };
      });
    },
    reconcileEvidence() {
      return transaction(() => {
        const invalidated = [];
        for (const row of db.prepare("SELECT * FROM method_methods WHERE status='candidate'").all()) {
          const references = JSON.parse(row.evidence_refs);
          if (references.every(ref => evidenceCurrent(ref, row.desk_id))) continue;
          archive(row, now());
          db.prepare("UPDATE method_methods SET status='source_invalidated', revision=revision+1, updated_at=? WHERE id=?").run(now(), row.id);
          invalidated.push(row.id);
        }
        return { reconciled: true, invalidated: invalidated.length, invalidatedIds: invalidated };
      });
    },
    forgetEvidence(id) {
      id = text(id, 'evidence id', 200);
      return transaction(() => {
        const affected = db.prepare('SELECT * FROM method_methods').all()
          .filter(row => JSON.parse(row.evidence_refs).some(ref => ref.id === id));
        for (const row of affected) dropMethod(row.id);
        tombstone(`evidence:${id}`, now());
        return { forgotten: affected.length };
      });
    },
    snapshot({ deskId, personaVersion } = {}) {
      deskId = text(deskId, 'deskId', 200);
      personaVersion = versionTag(personaVersion);
      const rows = db.prepare('SELECT * FROM method_methods WHERE desk_id=? AND persona_version=? ORDER BY updated_at DESC LIMIT ?').all(deskId, personaVersion, SNAPSHOT_LIMIT);
      const counts = { candidate: 0, revoked: 0, source_invalidated: 0 };
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM method_methods WHERE desk_id=? AND persona_version=? GROUP BY status').all(deskId, personaVersion)) counts[row.status] = row.n;
      const sessions = { active: 0, stopped: 0 };
      for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM method_sessions WHERE desk_id=? AND persona_version=? GROUP BY status').all(deskId, personaVersion)) sessions[row.status] = row.n;
      // Metadata only: method bodies are never copied into snapshots.
      return {
        deskId, personaVersion, counts, sessions,
        methods: rows.map(row => ({
          id: row.id, requestId: row.request_id, meaning: row.meaning, status: row.status,
          semanticStatus: row.semantic_status, revision: row.revision,
          evidenceRefs: JSON.parse(row.evidence_refs), createdAt: row.created_at, updatedAt: row.updated_at,
        })),
      };
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
