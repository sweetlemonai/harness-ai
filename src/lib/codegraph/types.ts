export type CodeGraphProviderKind =
  | 'gitnexus'
  | 'language_server'
  | 'static_analysis'
  | 'custom';

export type CodeGraphCapability =
  | 'symbol_lookup'
  | 'dependency_edges'
  | 'process_flows'
  | 'impact_analysis'
  | 'cluster_map'
  | 'ownership_hints'
  | 'test_mapping'
  | 'drift_detection';

export type CodeGraphFreshness = 'fresh' | 'stale' | 'missing' | 'unknown';

export type EvidenceKind =
  | 'command_output'
  | 'file_ref'
  | 'source_scan'
  | 'receipt'
  | 'fallback_notice'
  | 'provider_health'
  | 'generated_file_policy';

export interface ScopeRef {
  readonly scopeId: string;
  readonly repoRoot: string;
  readonly tenantId?: string;
  readonly project?: string;
  readonly task?: string;
  readonly privacyZone?: string;
}

export interface EvidenceRef {
  readonly evidenceId: string;
  readonly kind: EvidenceKind;
  readonly uri?: string;
  readonly label?: string;
  readonly summary: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SignatureStatus {
  readonly status: 'unsigned' | 'signed' | 'unavailable';
  readonly algorithm?: string;
  readonly signature?: string;
  readonly publicKeyRef?: string;
  readonly reason?: string;
}

export interface CodeGraphProvider {
  readonly providerId: string;
  readonly kind: CodeGraphProviderKind;
  readonly repoRoot: string;
  readonly indexRef: EvidenceRef;
  readonly freshness: CodeGraphFreshness;
  readonly capabilities: readonly CodeGraphCapability[];
}

export interface CodeGraphAdapter {
  readonly adapterId: string;
  readonly providerId: string;
  probe(scope: ScopeRef): Promise<CodeGraphProbeResult>;
  snapshot(scope: ScopeRef): Promise<CodeGraphSnapshot>;
  refresh(input: CodeGraphRefreshRequest): Promise<CodeGraphRefreshResult>;
  query(input: CodeGraphQueryRequest): Promise<CodeGraphQuery>;
  impact(input: CodeGraphImpactRequest): Promise<ImpactReceipt>;
  testCandidates(input: CodeGraphTestRequest): Promise<TestCandidateMap>;
  doctor(scope: ScopeRef): Promise<CodeGraphDoctorReport>;
  explainFailure(ref: EvidenceRef): Promise<string>;
}

export interface CodeGraphProbeResult {
  readonly providerId: string;
  readonly available: boolean;
  readonly version?: string;
  readonly healthRefs: readonly EvidenceRef[];
  readonly unavailableReason?: string;
}

export interface CodeGraphRefreshRequest {
  readonly scope: ScopeRef;
  readonly sidecarOnly: boolean;
  readonly force?: boolean;
  readonly generatedFilePolicyRef?: EvidenceRef;
}

export interface CodeGraphRefreshResult {
  readonly snapshotId?: string;
  readonly status: 'refreshed' | 'unchanged' | 'failed' | 'unavailable';
  readonly receiptId: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface CodeGraphQueryRequest {
  readonly scope: ScopeRef;
  readonly queryKind: CodeGraphQuery['queryKind'];
  readonly subject: string;
  readonly snapshotId?: string;
}

export interface CodeGraphImpactRequest {
  readonly scope: ScopeRef;
  readonly subject: string;
  readonly depth: number;
  readonly snapshotId?: string;
}

export interface CodeGraphTestRequest {
  readonly scope: ScopeRef;
  readonly subject: string;
  readonly snapshotId?: string;
}

export interface CodeGraphDoctorReport {
  readonly reportId: string;
  readonly scope: ScopeRef;
  readonly status: 'healthy' | 'stale' | 'degraded' | 'failed' | 'unavailable';
  readonly findings: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly receiptId: string;
}

export interface CodeGraphSnapshot {
  readonly snapshotId: string;
  readonly providerId: string;
  readonly repoRoot: string;
  readonly providerVersion?: string;
  readonly analyzerCommandRef?: EvidenceRef;
  readonly commitHash?: string;
  readonly indexedCommitHash?: string;
  readonly worktreeHash?: string;
  readonly worktreeStatusRef?: EvidenceRef;
  readonly dirtyWorktreeState:
    | 'clean_indexed'
    | 'dirty_indexed_with_overlay'
    | 'dirty_unindexed'
    | 'dirty_conflicting'
    | 'unknown';
  readonly dirtyWorktreePolicy?:
    | 'index_clean_only'
    | 'index_with_overlay'
    | 'block_mutation'
    | 'operator_gate';
  readonly generatedFilePolicyRef?: EvidenceRef;
  readonly ignoredPathGlobsRef?: EvidenceRef;
  readonly indexedAt: string;
  readonly freshness: 'fresh' | 'stale' | 'partial' | 'failed';
  readonly stalenessReason?: string;
  readonly indexAgeMs?: number;
  readonly lastRefreshAttemptRef?: EvidenceRef;
  readonly graphHash: string;
  readonly sourceRefs: readonly EvidenceRef[];
  readonly attestationRef?: EvidenceRef;
  readonly proofReceiptIds: readonly string[];
  readonly receiptId: string;
}

export interface CodeGraphQuery {
  readonly queryId: string;
  readonly providerId: string;
  readonly queryKind:
    | 'symbol_lookup'
    | 'callers'
    | 'callees'
    | 'impact'
    | 'process_trace'
    | 'cluster'
    | 'test_candidates'
    | 'ownership'
    | 'drift';
  readonly subject: string;
  readonly scope: ScopeRef;
  readonly resultRef: EvidenceRef;
  readonly snapshotId: string;
  readonly confidence?: number;
  readonly receiptId: string;
}

export interface CodeGraphAttestation {
  readonly attestationId: string;
  readonly providerId: string;
  readonly snapshotId: string;
  readonly statement:
    | 'snapshot_built_from_commit'
    | 'query_result_derived_from_snapshot'
    | 'impact_result_derived_from_snapshot'
    | 'test_mapping_derived_from_snapshot'
    | 'index_fresh_at_time'
    | 'index_stale_at_time'
    | 'fallback_source_read_used';
  readonly publicInputsHash: string;
  readonly graphRoot: string;
  readonly queryHash?: string;
  readonly resultHash?: string;
  readonly sourceCommitHash?: string;
  readonly worktreeStatusHash?: string;
  readonly issuedAt: string;
  readonly signature: SignatureStatus;
  readonly zkReceiptId?: string;
}

export interface ImpactReceipt {
  readonly receiptId: string;
  readonly snapshotId: string;
  readonly scope: ScopeRef;
  readonly changedSymbols: readonly string[];
  readonly changedPathRefs: readonly EvidenceRef[];
  readonly affectedCallers: readonly string[];
  readonly affectedCallees: readonly string[];
  readonly affectedFiles: readonly string[];
  readonly depth: number;
  readonly confidence?: number;
  readonly ambiguousMatches: readonly string[];
  readonly unresolvedEdges: readonly string[];
  readonly generatedFileExclusions: readonly string[];
  readonly reviewerRequired: boolean;
  readonly signature: SignatureStatus;
}

export interface TestCandidateMap {
  readonly mapId: string;
  readonly snapshotId: string;
  readonly scope: ScopeRef;
  readonly sourceRefs: readonly EvidenceRef[];
  readonly candidateTests: ReadonlyArray<{
    readonly testRef: EvidenceRef;
    readonly classification: 'focused' | 'broad' | 'smoke' | 'unknown';
    readonly confidence?: number;
    readonly rationaleRef?: EvidenceRef;
    readonly historicalFailureRefs: readonly string[];
  }>;
  readonly verificationResultRefs: readonly EvidenceRef[];
  readonly receiptId: string;
}

export interface CodeGraphReceipt {
  readonly receiptId: string;
  readonly schemaVersion: 'codegraph.receipt.v1';
  readonly receiptType:
    | 'code_graph_snapshot'
    | 'code_graph_query'
    | 'code_graph_impact'
    | 'code_graph_test_mapping'
    | 'code_graph_refresh_failed'
    | 'code_graph_unavailable'
    | 'code_graph_doctor';
  readonly providerId: string;
  readonly scope: ScopeRef;
  readonly issuedAt: string;
  readonly subject?: string;
  readonly snapshotId?: string;
  readonly status?: string;
  readonly publicInputsHash: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly signature: SignatureStatus;
  readonly payloadHash: string;
}

export interface CodeGraphAdapterOptions {
  readonly repoRoot?: string | undefined;
  readonly gitnexusBin?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}
