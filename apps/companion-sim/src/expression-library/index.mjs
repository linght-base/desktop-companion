// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Expression resource ledger: bounded declarative round-screen recipes proposed by the same Pi,
// structurally validated against current capabilities, activated per wake-session by the host, and
// revoked when upstream evidence is corrected, retracted or truly deleted. The module is a pure
// backend ledger: it never plays animations, never moves the head, never runs generated code and
// never creates timers — sample() returns plain data and the caller owns display timing.
//
// Honesty rules baked in: structural validation passing is NOT semantic acceptance
// (semanticStatus stays 'unverified' — there is no code path that can upgrade it); candidates never
// self-activate into the current session; test/holdout/unknown/denied/synthetic evidence can never
// become personal learning material; forgetEvidence physically deletes derived personal content.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { identifier } from '../contracts.mjs';
import { HARD_LIMITS, validateCapabilities, checkRecipeSchema, structuralCheck, sampleRecipe } from './recipe.mjs';
import { validateEvidenceRefs, evidenceUsableIssue, evidenceIssueFor, evidenceResolutionAvailable } from './evidence.mjs';

const LIMITS = Object.freeze({
  maxCandidates: 200, maxActivated: 20, maxTombstones: 200, maxSessions: 100,
  maxRequestAliases: 500, queryDefault: 6, queryMax: 20, maxMeaningLength: 500,
});
const SCHEMA_VERSION = '3';
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function tokens(value) {
  const normalized = value.normalize('NFKC').toLowerCase();
  const words = [...segmenter.segment(normalized)].filter(part => part.isWordLike).map(part => part.segment);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) words.push(run.slice(i, i + 2));
  }
  return [...new Set(words.filter(word => word.length > 1 || /[a-z0-9]/.test(word)))];
}
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`invalid_${name}`);
  return value.trim();
};

const requestKeyOf=(requestId,deskId,personaVersion)=>'scope:'+createHash('sha256').update(stableStringify({requestId,deskId,personaVersion})).digest('hex');

/** All timestamps are Unix milliseconds from the injectable clock. */
export function createExpressionLibrary({ path, clock = Date.now, capabilities, resolveEvidence } = {}) {
  text(path, 'path', 4096);
  if (typeof clock !== 'function') throw new Error('invalid_clock');
  let currentCapabilities = capabilities === undefined ? null : validateCapabilities(capabilities);
  if (resolveEvidence !== undefined && typeof resolveEvidence !== 'function') throw new Error('invalid_resolveEvidence');

  const db = new DatabaseSync(path);
  let closed = false;
  try {
    // secure_delete zeroes freed pages so a truly forgotten expression leaves no personal bytes behind.
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;');
    db.exec(`CREATE TABLE IF NOT EXISTS expression_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expression_candidates(
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL,
        revision INTEGER NOT NULL, status TEXT NOT NULL, meaning TEXT NOT NULL,
        desk_id TEXT NOT NULL, persona_version INTEGER NOT NULL,
        evidence_refs TEXT NOT NULL, recipe TEXT NOT NULL, structural_check TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS expression_tombstones(id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS expression_request_alias(request_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, at INTEGER NOT NULL);`);
    const stored=db.prepare("SELECT value FROM expression_meta WHERE key='schema_version'").get();
    if(!stored||['1','2'].includes(stored.value)){
      db.exec('BEGIN IMMEDIATE');
      try{
        const candidates=db.prepare('SELECT id,request_id,desk_id,persona_version FROM expression_candidates').all();
        const aliases=db.prepare('SELECT a.request_id,a.candidate_id,a.at,c.desk_id,c.persona_version FROM expression_request_alias a JOIN expression_candidates c ON c.id=a.candidate_id').all();
        for(const row of candidates)db.prepare('UPDATE expression_candidates SET request_id=? WHERE id=?').run('migrating:'+randomUUID(),row.id);
        for(const row of candidates)db.prepare('UPDATE expression_candidates SET request_id=? WHERE id=?').run(requestKeyOf(row.request_id,row.desk_id,row.persona_version),row.id);
        db.exec('DELETE FROM expression_request_alias');
        for(const row of aliases)db.prepare('INSERT INTO expression_request_alias(request_id,candidate_id,at) VALUES(?,?,?)').run(requestKeyOf(row.request_id,row.desk_id,row.persona_version),row.candidate_id,row.at);
        db.prepare("INSERT INTO expression_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(SCHEMA_VERSION);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }else if(stored.value!==SCHEMA_VERSION)throw new Error('unsupported_schema_version:'+stored.value);
  } catch (error) { db.close(); throw error; }

  const now = () => {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8.64e15) throw new Error('invalid_clock_value');
    return at;
  };
  const guard = () => { if (closed) throw new Error('library_closed'); };
  // Sessions live in memory only: a restart always demands a fresh session id from the host, so no
  // old session can survive a reboot and nothing can replay the previous wake's motion authority.
  const sessions = new Map();

  const toCandidate = row => ({
    id: row.id, revision: row.revision, status: row.status, meaning: row.meaning,
    deskId: row.desk_id, personaVersion: row.persona_version,
    evidenceRefs: JSON.parse(row.evidence_refs), recipe: JSON.parse(row.recipe),
    structuralCheck: JSON.parse(row.structural_check), semanticStatus: 'unverified',
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
  const loadCandidate = id => {
    const row = db.prepare('SELECT * FROM expression_candidates WHERE id=?').get(id);
    return row ? toCandidate(row) : null;
  };
  const writeCandidate = (candidate, { statusChanged }) => {
    db.prepare(`UPDATE expression_candidates SET revision=?, status=?, structural_check=?, updated_at=? WHERE id=?`).run(
      statusChanged ? candidate.revision + 1 : candidate.revision, candidate.status,
      JSON.stringify(candidate.structuralCheck), candidate.updatedAt, candidate.id);
    return loadCandidate(candidate.id);
  };
  const dropFromSessions = id => { for (const session of sessions.values()) session.items.delete(id); };
  // Capability withdrawal is effective immediately for EVERY session: gates check both the
  // session's activation snapshot and the latest provided set. The gate is live and non-terminal —
  // if the host restores capabilities, existing sessions serve their resources again. Only
  // evidence death (reconcile) permanently revokes.
  const capabilityIssue = (candidate, session) => {
    if (structuralCheck(candidate.recipe, session.capabilities).status !== 'passed') return 'capability_mismatch';
    if (currentCapabilities && structuralCheck(candidate.recipe, currentCapabilities).status !== 'passed') return 'capability_mismatch';
    return null;
  };
  const usableNow = (candidate, session) => {
    if (candidate.status !== 'ready') return `candidate_${candidate.status}`;
    if (capabilityIssue(candidate, session)) return 'capability_mismatch';
    if (evidenceIssueFor(candidate, resolveEvidence)) return 'evidence_invalid';
    return null;
  };

  function propose(input) {
    guard();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_proposal');
    if (Object.keys(input).some(key => !['requestId', 'meaning', 'evidenceRefs', 'deskId', 'personaVersion', 'recipe'].includes(key))) throw new Error('invalid_proposal_field');
    const requestId = identifier(input.requestId, 'request_id');
    const meaning = text(input.meaning, 'meaning', LIMITS.maxMeaningLength);
    const deskId = text(input.deskId, 'desk_id', 200);
    if (!Number.isSafeInteger(input.personaVersion) || input.personaVersion < 1 || input.personaVersion > 1e9) throw new Error('invalid_persona_version');
    const evidenceRefs = validateEvidenceRefs(input.evidenceRefs);

    const requestKey=requestKeyOf(requestId,deskId,input.personaVersion);
    const existing = db.prepare('SELECT * FROM expression_candidates WHERE request_id=?').get(requestKey);
    if (existing) return toCandidate(existing); // requestId is idempotent: replays return the ledger entry as recorded.
    const aliased = db.prepare('SELECT candidate_id FROM expression_request_alias WHERE request_id=?').get(requestKey);
    if (aliased) {
      // A requestId that once content-deduped keeps returning its first result even if the retry
      // carries different content — content dedupe must never break request idempotency.
      const target = loadCandidate(aliased.candidate_id);
      if (target) return target;
      db.prepare('DELETE FROM expression_request_alias WHERE request_id=?').run(requestKey); // defensive: candidate pruned or forgotten
    }

    if (!evidenceResolutionAvailable(resolveEvidence)) throw new Error('evidence_resolution_unavailable');
    for (const ref of evidenceRefs) {
      const issue = evidenceUsableIssue(ref, deskId, resolveEvidence);
      if (issue) throw new Error(issue); // non-personal or stale evidence never enters the ledger.
    }
    const recipe = checkRecipeSchema(input.recipe);

    const contentHash = createHash('sha256').update(stableStringify({ deskId, personaVersion: input.personaVersion, meaning, evidenceRefs, recipe })).digest('hex');
    const duplicate = db.prepare("SELECT * FROM expression_candidates WHERE content_hash=? AND status!='revoked'").get(contentHash);
    if (duplicate) {
      // The alias ledger is bounded; when full it rejects explicitly instead of silently dropping
      // the idempotency link. Fresh proposals (no dedupe) never need an alias and stay unaffected.
      if (db.prepare('SELECT COUNT(*) AS n FROM expression_request_alias').get().n >= LIMITS.maxRequestAliases) {
        db.prepare('DELETE FROM expression_request_alias WHERE candidate_id NOT IN (SELECT id FROM expression_candidates)').run();
        if (db.prepare('SELECT COUNT(*) AS n FROM expression_request_alias').get().n >= LIMITS.maxRequestAliases) throw new Error('request_alias_budget');
      }
      db.prepare('INSERT OR REPLACE INTO expression_request_alias(request_id,candidate_id,at) VALUES(?,?,?)').run(requestKey, duplicate.id, now());
      return toCandidate(duplicate); // identical content cannot inflate the ledger.
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM expression_candidates').get().n;
    if (total >= LIMITS.maxCandidates) {
      // Growth policy: reclaim space from already-dead rows; never silently evict live personal content.
      const pruned = db.prepare("SELECT id FROM expression_candidates WHERE status IN ('rejected','revoked') ORDER BY updated_at, rowid LIMIT 1").get();
      if (pruned) {
        db.prepare('DELETE FROM expression_candidates WHERE id=?').run(pruned.id);
        db.prepare('DELETE FROM expression_request_alias WHERE candidate_id=?').run(pruned.id);
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM expression_candidates').get().n >= LIMITS.maxCandidates) throw new Error('candidate_budget');
    }
    const at = now();
    const row = {
      id: `candidate-${randomUUID()}`, request_id: requestKey, content_hash: contentHash, revision: 1,
      status: 'candidate', meaning, desk_id: deskId, persona_version: input.personaVersion,
      evidence_refs: JSON.stringify(evidenceRefs), recipe: JSON.stringify(recipe),
      structural_check: JSON.stringify({ status: 'unchecked', at: null, capabilityVersion: null, issues: [] }),
      created_at: at, updated_at: at,
    };
    db.prepare(`INSERT INTO expression_candidates(id,request_id,content_hash,revision,status,meaning,desk_id,persona_version,evidence_refs,recipe,structural_check,created_at,updated_at)
      VALUES(@id,@request_id,@content_hash,@revision,@status,@meaning,@desk_id,@persona_version,@evidence_refs,@recipe,@structural_check,@created_at,@updated_at)`).run(row);
    return toCandidate(db.prepare('SELECT * FROM expression_candidates WHERE id=?').get(row.id));
  }

  function validateCandidate(id) {
    guard();
    const candidate = loadCandidate(text(id, 'candidate_id', 200));
    if (!candidate) throw new Error('unknown_candidate');
    if (candidate.status === 'revoked') return candidate; // revoked evidence cannot be re-grounded; propose fresh instead.
    if (!currentCapabilities) throw new Error('capabilities_unavailable');
    const check = structuralCheck(candidate.recipe, currentCapabilities);
    const status = check.status === 'passed' ? 'ready' : 'rejected';
    const statusChanged = candidate.status !== status;
    const at = now();
    return writeCandidate({ ...candidate, status, structuralCheck: { ...check, at }, updatedAt: at }, { statusChanged });
  }

  function getCandidate(id) {
    guard();
    text(id, 'candidate_id', 200);
    const candidate = loadCandidate(id);
    if (candidate) return candidate;
    const tombstone = db.prepare('SELECT at FROM expression_tombstones WHERE id=?').get(id);
    if (tombstone) return { id, status: 'forgotten', deletedAt: tombstone.at }; // minimal tombstone: no personal content.
    throw new Error('unknown_candidate');
  }

  function activateForSession(input) {
    guard();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_activation');
    if (Object.keys(input).some(key => !['sessionId', 'deskId', 'personaVersion', 'enabled', 'capabilities'].includes(key))) throw new Error('invalid_activation_field');
    const sessionId = identifier(input.sessionId, 'session_id');
    const deskId = text(input.deskId, 'desk_id', 200);
    if (!Number.isSafeInteger(input.personaVersion) || input.personaVersion < 1 || input.personaVersion > 1e9) throw new Error('invalid_persona_version');
    if (typeof input.enabled !== 'boolean') throw new Error('invalid_enabled');
    currentCapabilities = validateCapabilities(input.capabilities); // latest provided set governs all later checks.

    if (!input.enabled) {
      sessions.delete(sessionId);
      return { sessionId, availableIds: [], reason: 'disabled' };
    }
    const rows = db.prepare("SELECT * FROM expression_candidates WHERE status='ready' AND desk_id=? ORDER BY updated_at DESC, rowid DESC").all(deskId);
    const activated = [];
    let truncated = false;
    let emptyReason = 'no_ready_candidates';
    for (const row of rows) {
      if (activated.length >= LIMITS.maxActivated) { truncated = true; break; }
      const candidate = toCandidate(row);
      if (candidate.personaVersion !== input.personaVersion) { emptyReason = emptyReason === 'no_ready_candidates' ? 'persona_mismatch' : emptyReason; continue; }
      if (structuralCheck(candidate.recipe, currentCapabilities).status !== 'passed') { emptyReason = emptyReason === 'no_ready_candidates' ? 'capability_mismatch' : emptyReason; continue; }
      if (evidenceIssueFor(candidate, resolveEvidence)) { emptyReason = emptyReason === 'no_ready_candidates' ? 'evidence_invalid' : emptyReason; continue; }
      activated.push(candidate);
    }
    sessions.delete(sessionId);
    sessions.set(sessionId, {
      sessionId, deskId, personaVersion: input.personaVersion, capabilities: currentCapabilities,
      activatedAt: now(), items: new Map(activated.map(candidate => [candidate.id, candidate.revision])),
    });
    while (sessions.size > LIMITS.maxSessions) sessions.delete(sessions.keys().next().value);
    const reason = truncated ? 'activation_limit' : (activated.length ? undefined
      : (evidenceResolutionAvailable(resolveEvidence) ? emptyReason : 'evidence_resolution_unavailable'));
    return { sessionId, availableIds: activated.map(candidate => candidate.id), ...(reason ? { reason } : {}) };
  }

  function sessionOrThrow(sessionId) {
    const session = sessions.get(identifier(sessionId, 'session_id'));
    if (!session) throw new Error('unknown_session');
    return session;
  }

  function query(input) {
    guard();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_query');
    if (Object.keys(input).some(key => !['meaning', 'deskId', 'sessionId', 'limit'].includes(key))) throw new Error('invalid_query_field');
    const session = sessionOrThrow(input.sessionId);
    const deskId = text(input.deskId, 'desk_id', 200);
    if (session.deskId !== deskId) throw new Error('session_desk_mismatch');
    let limit = LIMITS.queryDefault;
    if (input.limit !== undefined) {
      if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error('invalid_limit');
      limit = Math.min(input.limit, LIMITS.queryMax);
    }
    const queryTokens = input.meaning === undefined ? null : tokens(text(input.meaning, 'query', LIMITS.maxMeaningLength));
    const results = [];
    for (const [id, activatedRevision] of session.items) {
      const candidate = loadCandidate(id);
      if (!candidate || usableNow(candidate, session) || candidate.revision !== activatedRevision) continue;
      if (queryTokens) {
        const hits = queryTokens.filter(token => tokens(candidate.meaning).includes(token));
        if (!hits.length) continue; // keyword recall only — no embedding, no synonym claims.
        results.push({ candidate, matchReason: `相关词：${hits.join('、')}`, score: hits.length });
      } else results.push({ candidate, matchReason: '当前会话已启用的表达资源', score: 0 });
    }
    return results.sort((a, b) => b.score - a.score || b.candidate.updatedAt - a.candidate.updatedAt)
      .slice(0, limit)
      .map(({ candidate, matchReason }) => ({
        id: candidate.id, revision: candidate.revision, meaning: candidate.meaning, status: candidate.status,
        evidenceRefs: candidate.evidenceRefs, structuralCheck: candidate.structuralCheck,
        semanticStatus: candidate.semanticStatus, matchReason,
      }));
  }

  function gateResource(id, sessionId) {
    const session = sessions.get(identifier(sessionId, 'session_id'));
    if (!session) return { ok: false, reason: 'unknown_session' };
    const candidate = loadCandidate(text(id, 'candidate_id', 200));
    if (!candidate) return { ok: false, reason: 'unknown_candidate' };
    const activatedRevision = session.items.get(candidate.id);
    if (activatedRevision === undefined) return { ok: false, reason: 'not_activated' };
    if (candidate.status !== 'ready') return { ok: false, reason: `candidate_${candidate.status}` };
    if (candidate.revision !== activatedRevision) return { ok: false, reason: 'candidate_changed' };
    if (candidate.personaVersion !== session.personaVersion) return { ok: false, reason: 'persona_mismatch' };
    const capabilityProblem = capabilityIssue(candidate, session);
    if (capabilityProblem) return { ok: false, reason: capabilityProblem };
    const evidenceIssue = evidenceIssueFor(candidate, resolveEvidence);
    if (evidenceIssue) return { ok: false, reason: 'evidence_invalid', detail: evidenceIssue };
    return { ok: true, candidate, session };
  }

  function get({ id, sessionId } = {}) {
    guard();
    const gate = gateResource(id, sessionId);
    if (!gate.ok) return gate;
    const { candidate, session } = gate;
    return {
      ok: true, id: candidate.id, revision: candidate.revision, meaning: candidate.meaning,
      deskId: candidate.deskId, personaVersion: candidate.personaVersion,
      evidenceRefs: structuredClone(candidate.evidenceRefs), recipe: structuredClone(candidate.recipe),
      structuralCheck: candidate.structuralCheck, semanticStatus: candidate.semanticStatus, sessionId: session.sessionId,
    };
  }

  function sample({ id, sessionId, elapsedMs } = {}) {
    guard();
    const gate = gateResource(id, sessionId);
    if (!gate.ok) return gate;
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return { ok: false, reason: 'invalid_elapsed' };
    return { ok: true, semanticStatus: 'unverified', ...sampleRecipe(gate.candidate.recipe, elapsedMs) };
  }

  function reconcileEvidence() {
    guard();
    if (!evidenceResolutionAvailable(resolveEvidence)) return { revokedIds: [], checkedCount: 0, reason: 'evidence_resolution_unavailable' };
    const revokedIds = [];
    const rows = db.prepare("SELECT * FROM expression_candidates WHERE status IN ('candidate','ready')").all();
    for (const row of rows) {
      const candidate = toCandidate(row);
      if (!evidenceIssueFor(candidate, resolveEvidence)) continue;
      // Upstream revision churn or retraction ends the resource; references are never silently
      // rewritten to a new revision — fresh grounding requires a fresh proposal.
      db.prepare("UPDATE expression_candidates SET status='revoked', revision=revision+1, updated_at=? WHERE id=?").run(now(), candidate.id);
      dropFromSessions(candidate.id);
      revokedIds.push(candidate.id);
    }
    return { revokedIds, checkedCount: rows.length };
  }

  function forgetEvidence(id) {
    guard();
    text(id, 'evidence_id', 200);
    const doomed = db.prepare('SELECT * FROM expression_candidates').all()
      .map(toCandidate).filter(candidate => candidate.evidenceRefs.some(ref => ref.id === id));
    const at = now();
    const transaction = db.prepare('BEGIN');
    transaction.run();
    try {
      for (const candidate of doomed) {
        db.prepare('DELETE FROM expression_candidates WHERE id=?').run(candidate.id);
        db.prepare('INSERT OR REPLACE INTO expression_tombstones(id,at) VALUES(?,?)').run(candidate.id, at);
        // True deletion cleans every derived link, including dedupe aliases that would otherwise
        // keep answering this requestId with personal content that was supposed to be gone.
        db.prepare('DELETE FROM expression_request_alias WHERE candidate_id=?').run(candidate.id);
        dropFromSessions(candidate.id);
      }
      db.prepare(`DELETE FROM expression_tombstones WHERE id IN (SELECT id FROM expression_tombstones ORDER BY at DESC LIMIT -1 OFFSET ${LIMITS.maxTombstones})`).run();
      db.prepare('COMMIT').run();
    } catch (error) { db.prepare('ROLLBACK').run(); throw error; }
    return { deletedCandidateIds: doomed.map(candidate => candidate.id) };
  }

  function stopSession(sessionId) {
    guard();
    if (sessionId !== undefined) sessions.delete(identifier(sessionId, 'session_id'));
  }

  function snapshot() {
    guard();
    const rows = db.prepare('SELECT * FROM expression_candidates ORDER BY updated_at DESC, rowid DESC').all();
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    return {
      version: 1, at: now(), semanticPolicy: 'structural_check_only',
      capabilityVersion: currentCapabilities?.version ?? null,
      limits: LIMITS,
      counts: { candidate: rows.length, candidateByStatus: byStatus, tombstone: db.prepare('SELECT COUNT(*) AS n FROM expression_tombstones').get().n, requestAlias: db.prepare('SELECT COUNT(*) AS n FROM expression_request_alias').get().n },
      candidates: rows.slice(0, 20).map(toCandidate),
      tombstones: db.prepare(`SELECT id FROM expression_tombstones ORDER BY at DESC LIMIT 20`).all().map(row => row.id),
      sessions: [...sessions.values()].map(session => ({
        sessionId: session.sessionId, deskId: session.deskId, personaVersion: session.personaVersion,
        activatedAt: session.activatedAt, availableCount: session.items.size,
      })),
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    sessions.clear();
    db.close();
  }

  return {
    propose, validateCandidate, getCandidate, activateForSession, query, get, sample,
    reconcileEvidence, forgetEvidence, stopSession, snapshot, close,
  };
}

export { HARD_LIMITS, LIMITS };
