// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
// Evidence grounding for expression candidates. The host injects a synchronous read-only
// resolveEvidence(id) callback; this module never reads continuity tables directly. Unverifiable
// evidence is never trusted: unknown, test, holdout, denied or synthetic material cannot become
// personal learning input, and the model has no API to upgrade that decision.
const KINDS = new Set(['perception', 'episode', 'interaction']);
const LIVE_STATUSES = new Set(['active', 'tentative']);
const STATUSES = new Set(['active', 'tentative', 'invalidated', 'retracted', 'deleted']);
const SOURCES = new Set(['camera', 'replay', 'explicit_user', 'synthetic']);
const LEARNING_USES = new Set(['allowed', 'test', 'holdout', 'denied', 'unknown']);

export function validateEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error('invalid_evidence_refs');
  const seen = new Set();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error('invalid_evidence_ref');
    if (Object.keys(ref).some(key => !['id', 'revision'].includes(key))) throw new Error('invalid_evidence_ref_field');
    if (typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 200 || ref.id.includes('\0')) throw new Error('invalid_evidence_ref');
    if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new Error('invalid_evidence_ref');
    if (seen.has(ref.id)) throw new Error('duplicate_evidence_ref');
    seen.add(ref.id);
    return { id: ref.id.trim(), revision: ref.revision };
  });
}

function resolveDescriptor(resolveEvidence, id) {
  if (typeof resolveEvidence !== 'function') return { issue: 'evidence_resolution_unavailable' };
  let descriptor = null;
  try { descriptor = resolveEvidence(id); } catch { descriptor = null; }
  if (descriptor === null || descriptor === undefined) return { issue: 'unknown_evidence' };
  if (typeof descriptor !== 'object' || Array.isArray(descriptor)
    || typeof descriptor.id !== 'string' || !descriptor.id || descriptor.id.length > 200
    || !Number.isSafeInteger(descriptor.revision) || descriptor.revision < 1
    || typeof descriptor.kind !== 'string' || typeof descriptor.status !== 'string'
    || typeof descriptor.source !== 'string' || typeof descriptor.deskId !== 'string'
    || !descriptor.deskId || descriptor.deskId.length > 200
    || typeof descriptor.learningUse !== 'string') return { issue: 'evidence_descriptor_invalid' };
  return { descriptor };
}

/** Returns null when the referenced evidence currently grounds personal learning material on this
 *  desk, otherwise a machine-readable reason. Called at propose, activate, query, get and sample —
 *  never only at first activation. */
export function evidenceUsableIssue(ref, deskId, resolveEvidence) {
  const { descriptor, issue } = resolveDescriptor(resolveEvidence, ref.id);
  if (issue) return issue;
  if (descriptor.id !== ref.id) return 'evidence_id_mismatch';
  if (descriptor.revision !== ref.revision) return 'evidence_revision_stale';
  if (!KINDS.has(descriptor.kind)) return 'evidence_kind_unsupported';
  if (!STATUSES.has(descriptor.status)) return 'evidence_status_invalid';
  if (!LIVE_STATUSES.has(descriptor.status)) return `evidence_status_${descriptor.status}`;
  if (!SOURCES.has(descriptor.source)) return 'evidence_source_invalid';
  if (descriptor.source === 'synthetic') return 'evidence_source_synthetic';
  if (!LEARNING_USES.has(descriptor.learningUse)) return 'evidence_learning_invalid';
  if (descriptor.learningUse !== 'allowed') return `evidence_learning_${descriptor.learningUse}`;
  if (descriptor.deskId !== deskId) return 'evidence_desk_mismatch';
  return null;
}

export function evidenceIssueFor(candidate, resolveEvidence) {
  for (const ref of candidate.evidenceRefs) {
    const issue = evidenceUsableIssue(ref, candidate.deskId, resolveEvidence);
    if (issue) return issue;
  }
  return null;
}

export const evidenceResolutionAvailable = resolveEvidence => typeof resolveEvidence === 'function';
