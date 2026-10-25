// Copyright (c) 2026 Shenzhen Guangbo Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0
/** Expression library public shapes. All timestamps are Unix milliseconds from the injectable clock. */

export interface Capabilities {
  version: string;
  eyes: boolean;
  icons: Array<'none' | 'question' | 'sparkle' | 'clock' | 'check' | 'water' | 'movement' | 'posture'>;
  gestures: Array<'idle' | 'wave' | 'jump' | 'waiting' | 'review'>;
  maxDurationMs: number; // <= 5000 (contracts hard limit)
  maxKeyframes: number;  // <= 32
}

/** Host-injected synchronous read-only evidence descriptor. The library never reads continuity tables. */
export interface EvidenceDescriptor {
  id: string;
  revision: number;
  kind: 'perception' | 'episode' | 'interaction';
  status: 'active' | 'tentative' | 'invalidated' | 'retracted' | 'deleted';
  source: 'camera' | 'replay' | 'explicit_user' | 'synthetic';
  deskId: string;
  learningUse: 'allowed' | 'test' | 'holdout' | 'denied' | 'unknown';
}

export interface EvidenceRef { id: string; revision: number }

export interface Keyframe {
  atMs: number;
  eyes?: Partial<{ gazeX: number; gazeY: number; openness: number; tilt: number; roundness: number; color: string }>;
  icon?: string;
  gesture?: string;
}

/** Bounded declarative recipe: 100–5000ms, 2–32 keyframes, first atMs=0, last atMs=durationMs,
 *  strictly increasing. No head motion, text, audio, code, URLs or external resources. */
export interface Recipe { durationMs: number; keyframes: Keyframe[] }

export interface StructuralCheck {
  status: 'unchecked' | 'passed' | 'failed';
  at: number | null;
  capabilityVersion: string | null;
  issues: string[];
}

export interface Candidate {
  id: string;
  revision: number;
  status: 'candidate' | 'ready' | 'rejected' | 'revoked';
  meaning: string;
  deskId: string;
  personaVersion: number;
  evidenceRefs: EvidenceRef[];
  recipe: Recipe;
  createdAt: number;
  updatedAt: number;
  structuralCheck: StructuralCheck;
  /** Always 'unverified': structural validation is not semantic acceptance. No API upgrades this. */
  semanticStatus: 'unverified';
}

export interface Activation {
  sessionId: string;
  availableIds: string[];
  reason?: string;
}

export interface QueryEntry {
  id: string;
  revision: number;
  meaning: string;
  status: string;
  evidenceRefs: EvidenceRef[];
  structuralCheck: StructuralCheck;
  semanticStatus: 'unverified';
  matchReason: string;
}

export type AvailableRecipe = {
  ok: true;
  id: string;
  revision: number;
  meaning: string;
  deskId: string;
  personaVersion: number;
  evidenceRefs: EvidenceRef[];
  recipe: Recipe;
  structuralCheck: StructuralCheck;
  semanticStatus: 'unverified';
  sessionId: string;
};
export type Rejection = { ok: false; reason: string; detail?: string };

export type SampleResult = { ok: true; semanticStatus: 'unverified'; eyes?: Record<string, number | string>; icon?: string; gesture?: string; finished: boolean } | Rejection;

export interface ExpressionLibrary {
  propose(input: { requestId: string; meaning: string; evidenceRefs: EvidenceRef[]; deskId: string; personaVersion: number; recipe: Recipe }): Candidate;
  validateCandidate(id: string): Candidate;
  getCandidate(id: string): Candidate | { id: string; status: 'forgotten'; deletedAt: number };
  activateForSession(input: { sessionId: string; deskId: string; personaVersion: number; enabled: boolean; capabilities: Capabilities }): Activation;
  query(input: { meaning?: string; deskId: string; sessionId: string; limit?: number }): QueryEntry[];
  get(input: { id: string; sessionId: string }): AvailableRecipe | Rejection;
  sample(input: { id: string; sessionId: string; elapsedMs: number }): SampleResult;
  reconcileEvidence(): { revokedIds: string[]; checkedCount: number; reason?: string };
  forgetEvidence(id: string): { deletedCandidateIds: string[] };
  stopSession(sessionId: string): void;
  snapshot(): Record<string, unknown>;
  close(): void;
}

export function createExpressionLibrary(options: {
  path: string;
  clock?: () => number;
  capabilities?: Capabilities;
  resolveEvidence?: (id: string) => EvidenceDescriptor | null;
}): ExpressionLibrary;

/** Pure-data playback adapter types (playback.mjs). No timers, no rendering loop, no head output:
 *  the host tick drives everything and keeps owning display lease, pause and preemption. */
export interface PlaybackIntent {
  basisObservationId: string;
  durationMs: number;
  eyes?: Record<string, number | string>;
  icon?: string;
  gesture?: string;
}

export interface PrepareContext { epoch: number; deskId: string; isCurrent: () => boolean }

export interface PlaybackReceipt {
  id: string;
  status: 'accepted' | 'rejected' | 'completed' | 'cancelled';
  /** Required for accepted receipts: Unix milliseconds from the actual body acceptance. */
  at?: number;
  reason?: string;
  basisObservationId?: string;
  [key: string]: unknown;
}

export type PrepareResult =
  | { accepted: true; proposalId: string; intent: PlaybackIntent; expiresAt: number }
  | { accepted: false; reason: string; detail?: string };
export type CommitResult = { accepted: true; playbackId: string } | { accepted: false; reason: string };
export type TickResult =
  | null
  | { kind: 'frame'; receiptId: string; frame: { eyes?: Record<string, number | string>; icon?: string; gesture?: string } }
  | { kind: 'stop'; receiptId: string; reason: string };

export interface ExpressionPlayback {
  prepare(request: { recipeId: string; sessionId: string; basisObservationId: string }, context: PrepareContext): PrepareResult;
  commit(input: { proposalId: string; receipt: PlaybackReceipt }): CommitResult;
  tick(input: { enabled: boolean; epoch: number; deskId: string; expressionCommandId: string | null }): TickResult;
  stop(reason?: string): { kind: 'stop'; receiptId: string; reason: string } | null;
  snapshot(): Record<string, unknown>;
  close(): void;
}

export function createExpressionPlayback(options: { library: ExpressionLibrary; clock?: () => number }): ExpressionPlayback;
