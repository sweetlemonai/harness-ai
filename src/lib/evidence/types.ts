import type {
  BcrxSubjectFields,
  SignatureDescriptor,
  ZkSnarkDescriptor,
} from '../protocol/types.js';

export type EvidenceKind =
  | 'command_output'
  | 'file_ref'
  | 'model_output'
  | 'adapter_failure'
  | 'adapter_recovery'
  | 'implementation_conflict'
  | 'human_assertion'
  | 'codegraph_receipt'
  | 'fleet_probe'
  | 'privacy_preflight'
  | 'instrumentation_proof'
  | 'instrumentation_missing'
  | 'rll_observation';

export interface EvidenceReceipt {
  readonly evidenceId: string;
  readonly schemaVersion: 'superharness.evidence.receipt.v2';
  readonly kind: EvidenceKind;
  readonly subject: BcrxSubjectFields;
  readonly summary: string;
  readonly createdAt: string;
  readonly uri?: string;
  readonly observedBy: string;
  readonly contentHash: string;
  readonly contentPreview?: string;
  readonly metadata: Record<string, unknown>;
  readonly signature: SignatureDescriptor;
  readonly zkSnark: ZkSnarkDescriptor;
  readonly previousLineHash?: string | null;
}

export interface AdapterFailureInput {
  readonly adapterId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly stderr?: string;
  readonly stdout?: string;
  readonly error: string;
  readonly durationMs?: number;
  readonly timedOut?: boolean;
}

export interface AdapterRecoveryInput {
  readonly adapterId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly adapterInstanceId: string;
  readonly adapterVersion: string;
  readonly recoveredBy: string;
  readonly verifierAgentId: string;
  readonly identityVerifierAgentId: string;
  readonly verifierTrustAnchorRef: string;
  readonly verifierAttestationRefs: readonly string[];
  readonly identityVerifierTrustAnchorRef: string;
  readonly identityVerifierAttestationRefs: readonly string[];
  readonly transactionId: string;
  readonly transactionStatus: 'unstarted' | 'prepared' | 'committed' | 'aborted';
  readonly transactionPreparedAt?: string;
  readonly transactionCommittedAt?: string;
  readonly bindingPayloadHash: string;
  readonly recoveredAt?: string;
  readonly recoveryEvidenceRefs: readonly string[];
  readonly verificationEvidenceRefs: readonly string[];
  readonly identityBindingRefs: readonly string[];
  readonly resolvesEvidenceIds?: readonly string[];
  readonly resolvesSubjectIds?: readonly string[];
  readonly note?: string;
}
