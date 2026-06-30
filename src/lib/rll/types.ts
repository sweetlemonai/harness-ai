import type { BcrxSubjectFields } from '../protocol/types.js';

export type RllEventKind =
  | 'observation'
  | 'failure'
  | 'conflict'
  | 'correction'
  | 'dissent'
  | 'control_signal'
  | 'task_growth'
  | 'rsi_candidate';

export type RllControlAction =
  | 'gather_more_evidence'
  | 'route_to_local'
  | 'route_to_frontier'
  | 'request_dissent'
  | 'narrow_scope'
  | 'expand_scope'
  | 'pause_for_human'
  | 'refresh_codegraph'
  | 'repair_adapter';

export interface RllEvent {
  readonly eventId: string;
  readonly schemaVersion: 'superharness.rll.event.v2';
  readonly kind: RllEventKind;
  readonly subject: BcrxSubjectFields;
  readonly createdAt: string;
  readonly source: string;
  readonly summary: string;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly metrics: Record<string, number>;
  readonly confidence?: number;
  readonly previousLineHash?: string | null;
}

export interface RllControlSignal {
  readonly signalId: string;
  readonly schemaVersion: 'superharness.rll.control_signal.v2';
  readonly action: RllControlAction;
  readonly subject: BcrxSubjectFields;
  readonly reason: string;
  readonly createdAt: string;
  readonly strength: number;
  readonly sourceEventIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface RsiCandidate {
  readonly candidateId: string;
  readonly subject: BcrxSubjectFields;
  readonly hypothesis: string;
  readonly expectedBenefit: string;
  readonly risk: string;
  readonly requiredEvidenceRefs: readonly string[];
}
