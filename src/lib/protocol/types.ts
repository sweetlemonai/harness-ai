export type PrivacyZone =
  | 'WORKSPACE'
  | 'LOCAL_ONLY'
  | 'HOSTED_REGIONAL'
  | 'ZDR_FRONTIER'
  | 'BLIND_SUBTASK'
  | 'SECRET_COMMITMENT_ONLY';

export type ProtocolMessageKind =
  | 'task_request'
  | 'agent_observation'
  | 'agent_proposal'
  | 'dissent'
  | 'decision'
  | 'handoff'
  | 'tool_result'
  | 'adapter_failure'
  | 'adapter_recovery'
  | 'conflict'
  | 'rll_signal'
  | 'receipt_notice';

export type EpistemicStatus =
  | 'observed'
  | 'inferred'
  | 'uncertain'
  | 'unsupported'
  | 'contradicted';

export interface ModelIdentity {
  readonly modelId: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly hostId?: string;
}

export interface EvidenceRequirement {
  readonly required: boolean;
  readonly minRefs: number;
  readonly acceptedKinds: readonly string[];
}

export interface DissentRequirement {
  readonly required: boolean;
  readonly minDissenters: number;
  readonly scope: 'none' | 'material_claims' | 'all_decisions';
}

export type ProtocolAssuranceContext = 'alpha' | 'production';

export interface ProofRequirement {
  readonly required: boolean;
  readonly minProofs: number;
  readonly acceptedModes: readonly ('external_snark' | 'mock_transcript' | 'not_requested')[];
}

export interface EpistemicState {
  readonly status: EpistemicStatus;
  readonly confidence?: number;
  readonly uncertainty?: string;
  readonly dissentRequired?: boolean;
}

export type VerifierSelectionMethod =
  | 'policy_registry'
  | 'fleet_consensus'
  | 'operator_assigned'
  | 'manual_by_implementer';

export type IdentityBindingStatus =
  | 'unverified'
  | 'evidence_bound'
  | 'cryptographically_verified';

export type VerificationTransactionStatus =
  | 'unstarted'
  | 'prepared'
  | 'committed'
  | 'aborted';

export type ZkFailurePolicy =
  | 'fail_closed'
  | 'manual_hold'
  | 'degrade_to_signature_only_alpha';

export type ZkFailureState =
  | 'none'
  | 'rejected_fail_closed'
  | 'manual_hold'
  | 'degraded_signature_only_alpha';

export interface BcrxSubjectFields {
  readonly subjectId: string;
  readonly subjectType:
    | 'task'
    | 'run'
    | 'claim'
    | 'adapter'
    | 'model'
    | 'code_ref'
    | 'receipt'
    | 'tenant'
    | 'fleet_member';
  readonly title: string;
  readonly assuranceContext?: ProtocolAssuranceContext;
  readonly ownerAgentId?: string;
  readonly privacyZone: PrivacyZone;
  readonly materiality: 'low' | 'medium' | 'high' | 'critical';
  readonly implementerAgentId?: string;
  readonly verifierAgentId?: string;
  readonly verifierSelectionMethod?: VerifierSelectionMethod;
  readonly verifierPolicyRef?: string;
  readonly verifierTrustAnchorRef?: string;
  readonly verifierAttestationRefs?: readonly string[];
  readonly identityVerifierAgentId?: string;
  readonly identityVerifierTrustAnchorRef?: string;
  readonly identityVerifierAttestationRefs?: readonly string[];
  readonly identityBindingStatus?: IdentityBindingStatus;
  readonly verificationStatus?:
    | 'unverified'
    | 'self_verified'
    | 'independently_verified'
    | 'rejected';
  readonly instrumentationRefs?: readonly string[];
  readonly semanticDriftIndex?: number;
  readonly laneIntegrityScore?: number;
  readonly blocking?: boolean;
  readonly evidencePolicy?: EvidenceRequirement;
  readonly dissentPolicy?: DissentRequirement;
  readonly proofPolicy?: ProofRequirement;
  readonly correlationId?: string;
  readonly parentSubjectId?: string;
  readonly supersedesSubjectId?: string;
  readonly ttlSeconds?: number;
}

export interface ZkSnarkDescriptor {
  readonly status: 'not_requested' | 'pending' | 'proved' | 'failed' | 'unavailable';
  readonly mode: 'not_requested' | 'mock_transcript' | 'external_snark';
  readonly backend: 'mock_local' | 'external';
  readonly circuitId?: string;
  readonly circuitVersion?: string;
  readonly publicInputsHash?: string;
  readonly proofHash?: string;
  readonly verifierRef?: string;
  readonly provedAt?: string;
  readonly expiresAt?: string;
  readonly latencyMs?: number;
  readonly maxLatencyMs?: number;
  readonly failurePolicy?: ZkFailurePolicy;
  readonly failureState?: ZkFailureState;
  readonly setupHash?: string;
  readonly reason?: string;
}

export interface SignatureDescriptor {
  readonly status: 'unsigned' | 'signed' | 'unavailable';
  readonly algorithm?: string;
  readonly signature?: string;
  readonly publicKeyRef?: string;
  readonly trustLevel?: 'self_signed' | 'registry_verified' | 'operator_bound' | 'unknown';
  readonly keyId?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly revocationListRef?: string;
  readonly reason?: string;
}

export interface ProtocolAttestation {
  readonly attestationId: string;
  readonly statement: string;
  readonly publicInputsHash: string;
  readonly issuedAt: string;
  readonly signature: SignatureDescriptor;
  readonly zkSnark: ZkSnarkDescriptor;
}

export interface ProtocolMessage {
  readonly messageId: string;
  readonly schemaVersion: 'superharness.protocol.message.v2';
  readonly protocolVersion: '2.0';
  readonly kind: ProtocolMessageKind;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: BcrxSubjectFields;
  readonly createdAt: string;
  readonly body: unknown;
  readonly epistemics: EpistemicState;
  readonly evidenceRefs: readonly string[];
  readonly inReplyTo?: string;
  readonly causalityRefs: readonly string[];
  readonly signature: SignatureDescriptor;
  readonly attestation?: ProtocolAttestation;
  readonly previousLineHash?: string | null;
}

export interface ProtocolReceipt {
  readonly receiptId: string;
  readonly schemaVersion: 'superharness.protocol.receipt.v2';
  readonly protocolVersion: '2.0';
  readonly receiptType:
    | 'message_recorded'
    | 'message_rejected'
    | 'adapter_failure_recorded'
    | 'adapter_recovery_recorded'
    | 'conflict_recorded'
    | 'evidence_bound'
    | 'dissent_recorded'
    | 'instrumentation_missing';
  readonly subject: BcrxSubjectFields;
  readonly issuedAt: string;
  readonly messageId?: string;
  readonly status: 'accepted' | 'rejected' | 'degraded';
  readonly publicInputsHash: string;
  readonly payloadHash: string;
  readonly evidenceRefs: readonly string[];
  readonly implementerAgentId?: string;
  readonly verifierAgentId?: string;
  readonly independentVerification?: {
    readonly required: boolean;
    readonly satisfied: boolean;
    readonly implementerAgentId?: string;
    readonly verifierAgentId?: string;
    readonly verifierSelectionMethod?: VerifierSelectionMethod;
    readonly verifierPolicyRef?: string;
    readonly verifierTrustAnchorRef?: string;
    readonly verifierAttestationRefs?: readonly string[];
    readonly identityVerifierAgentId?: string;
    readonly identityVerifierTrustAnchorRef?: string;
    readonly identityVerifierAttestationRefs?: readonly string[];
    readonly identityBindingStatus?: IdentityBindingStatus;
    readonly identityBindingRefs: readonly string[];
    readonly transactionId?: string;
    readonly transactionStatus?: VerificationTransactionStatus;
    readonly bindingPayloadHash?: string;
    readonly alphaOnly?: boolean;
    readonly evidenceRefs: readonly string[];
    readonly reason?: string;
  };
  readonly signature: SignatureDescriptor;
  readonly zkSnark: ZkSnarkDescriptor;
  readonly previousLineHash?: string | null;
}
