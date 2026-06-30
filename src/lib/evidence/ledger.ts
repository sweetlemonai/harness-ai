import type {
  AgentIdentity,
  EvidenceKind as CoreEvidenceKind,
  EvidenceRef,
  VerificationIssue,
  VerificationReport,
  RunContext,
} from '../../types.js';
import { stableHash, stableId } from '../protocol/hash.js';
import { appendJsonl, readJsonl } from '../protocol/jsonl.js';
import { appendLedgerEntry, ledgerStats } from '../protocol/ledger.js';
import { createVerificationReport, issue } from '../protocol/verify.js';
import type {
  BcrxSubjectFields,
  SignatureDescriptor,
  ZkSnarkDescriptor,
} from '../protocol/types.js';
import type {
  AdapterFailureInput,
  AdapterRecoveryInput,
  EvidenceKind as SidecarEvidenceKind,
  EvidenceReceipt,
} from './types.js';

export interface EvidenceLedgerEntry {
  readonly schemaVersion: 'evidence.ledger.v2';
  readonly seq: number;
  readonly ref: EvidenceRef;
  readonly prevHash?: string;
  readonly hash: string;
}

export function createEvidenceRef(args: {
  readonly kind: CoreEvidenceKind;
  readonly uri: string;
  readonly producedBy: AgentIdentity;
  readonly observedAt?: string;
  readonly content?: unknown;
  readonly sha256?: string;
  readonly contentType?: string;
  readonly command?: readonly string[];
  readonly exitCode?: number;
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly retentionPolicy?: string;
}): EvidenceRef {
  const observedAt = args.observedAt ?? new Date().toISOString();
  const sha256 = args.sha256 ?? (args.content === undefined ? undefined : stableHash(args.content));
  const idPayload = {
    kind: args.kind,
    uri: args.uri,
    sha256: sha256 ?? null,
    producedBy: args.producedBy,
    observedAt,
    command: args.command ?? null,
    exitCode: args.exitCode ?? null,
    lineStart: args.lineStart ?? null,
    lineEnd: args.lineEnd ?? null,
  };
  return {
    evidenceId: stableId('evidence', idPayload),
    kind: args.kind,
    uri: args.uri,
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
    producedBy: args.producedBy,
    observedAt,
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.lineStart !== undefined ? { lineStart: args.lineStart } : {}),
    ...(args.lineEnd !== undefined ? { lineEnd: args.lineEnd } : {}),
    ...(args.retentionPolicy !== undefined ? { retentionPolicy: args.retentionPolicy } : {}),
  };
}

export function appendEvidenceRef(path: string, ref: EvidenceRef): EvidenceLedgerEntry {
  const previous = readEvidenceLedger(path).at(-1);
  const payload = {
    schemaVersion: 'evidence.ledger.v2' as const,
    seq: previous === undefined ? 1 : previous.seq + 1,
    ref,
    ...(previous !== undefined ? { prevHash: previous.hash } : {}),
  };
  const entry = {
    ...payload,
    hash: stableHash(payload),
  };
  appendJsonl(path, entry);
  return entry;
}

export function readEvidenceLedger(path: string): readonly EvidenceLedgerEntry[] {
  return readJsonl<EvidenceLedgerEntry>(path).map((record) => record.value);
}

export function verifyEvidenceLedger(path: string): VerificationReport {
  const records = readJsonl<EvidenceLedgerEntry>(path);
  const issues: VerificationIssue[] = [];
  let expectedPrev: string | undefined;

  for (const record of records) {
    const entry = record.value;
    if (entry.schemaVersion !== 'evidence.ledger.v2') {
      issues.push(issue('error', 'evidence.schema_invalid', 'evidence ledger schemaVersion is invalid', {
        subjectId: entry.ref?.evidenceId,
        line: record.line,
      }));
    }
    if (entry.seq !== record.line) {
      issues.push(issue('error', 'evidence.seq_mismatch', 'evidence ledger seq must match append order', {
        subjectId: entry.ref.evidenceId,
        line: record.line,
      }));
    }
    if (entry.prevHash !== expectedPrev) {
      issues.push(issue('error', 'evidence.prev_hash_mismatch', 'evidence ledger prevHash does not match previous entry', {
        subjectId: entry.ref.evidenceId,
        line: record.line,
      }));
    }
    const expectedHash = stableHash(entryPayload(entry));
    if (entry.hash !== expectedHash) {
      issues.push(issue('error', 'evidence.hash_mismatch', 'evidence ledger entry hash does not match canonical payload', {
        subjectId: entry.ref.evidenceId,
        line: record.line,
      }));
    }
    expectedPrev = entry.hash;
  }

  return createVerificationReport({
    subject: path,
    issues,
    ...(records.at(-1)?.value.hash !== undefined ? { headHash: records.at(-1)!.value.hash } : {}),
  });
}

export const doctorEvidenceLedger = verifyEvidenceLedger;

function entryPayload(entry: EvidenceLedgerEntry): Omit<EvidenceLedgerEntry, 'hash'> {
  const { hash: _hash, ...payload } = entry;
  return payload;
}

const UNSIGNED_SIDE_CAR_SIGNATURE: SignatureDescriptor = {
  status: 'unsigned',
  algorithm: 'sha256',
  reason: 'signing backend not configured',
};

const ZK_NOT_REQUESTED: ZkSnarkDescriptor = {
  status: 'not_requested',
  mode: 'not_requested',
  backend: 'mock_local',
};

export function createEvidenceReceipt(args: {
  readonly kind: SidecarEvidenceKind;
  readonly subject: BcrxSubjectFields;
  readonly summary: string;
  readonly observedBy: string;
  readonly content: unknown;
  readonly uri?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly createdAt?: string;
  readonly signature?: SignatureDescriptor | undefined;
  readonly zkSnark?: ZkSnarkDescriptor | undefined;
}): EvidenceReceipt {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const contentHash = stableHash(args.content);
  return {
    evidenceId: stableId('evidence', {
      kind: args.kind,
      subjectId: args.subject.subjectId,
      contentHash,
      uri: args.uri ?? null,
      observedBy: args.observedBy,
    }),
    schemaVersion: 'superharness.evidence.receipt.v2',
    kind: args.kind,
    subject: args.subject,
    summary: args.summary,
    createdAt,
    ...(args.uri !== undefined ? { uri: args.uri } : {}),
    observedBy: args.observedBy,
    contentHash,
    contentPreview: previewContent(args.content),
    metadata: args.metadata ?? {},
    signature: args.signature ?? UNSIGNED_SIDE_CAR_SIGNATURE,
    zkSnark: args.zkSnark ?? ZK_NOT_REQUESTED,
  };
}

export function createAdapterFailureEvidence(args: {
  readonly subject: BcrxSubjectFields;
  readonly observedBy: string;
  readonly failure: AdapterFailureInput;
  readonly createdAt?: string;
}): EvidenceReceipt {
  return createEvidenceReceipt({
    kind: 'adapter_failure',
    subject: args.subject,
    summary: `${args.failure.adapterId} failed: ${args.failure.error}`,
    observedBy: args.observedBy,
    content: args.failure,
    ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
    uri: `adapter:${args.failure.adapterId}`,
    metadata: {
      adapterId: args.failure.adapterId,
      providerId: args.failure.providerId,
      modelId: args.failure.modelId ?? null,
      exitCode: args.failure.exitCode ?? null,
      timedOut: args.failure.timedOut ?? false,
    },
  });
}

export function createAdapterRecoveryEvidence(args: {
  readonly subject: BcrxSubjectFields;
  readonly observedBy: string;
  readonly recovery: AdapterRecoveryInput;
  readonly createdAt?: string;
}): EvidenceReceipt {
  return createEvidenceReceipt({
    kind: 'adapter_recovery',
    subject: args.subject,
    summary: `${args.recovery.adapterId} recovered with independent verification evidence`,
    observedBy: args.observedBy,
    content: args.recovery,
    ...(args.createdAt !== undefined ? { createdAt: args.createdAt } : {}),
    uri: `adapter:${args.recovery.adapterId}:recovery`,
    metadata: {
      adapterId: args.recovery.adapterId,
      providerId: args.recovery.providerId,
      modelId: args.recovery.modelId ?? null,
      adapterInstanceId: args.recovery.adapterInstanceId,
      adapterVersion: args.recovery.adapterVersion,
      recovered: true,
      recoveredBy: args.recovery.recoveredBy,
      verifierAgentId: args.recovery.verifierAgentId,
      identityVerifierAgentId: args.recovery.identityVerifierAgentId,
      verifierTrustAnchorRef: args.recovery.verifierTrustAnchorRef,
      verifierAttestationRefs: args.recovery.verifierAttestationRefs,
      identityVerifierTrustAnchorRef: args.recovery.identityVerifierTrustAnchorRef,
      identityVerifierAttestationRefs: args.recovery.identityVerifierAttestationRefs,
      transactionId: args.recovery.transactionId,
      transactionStatus: args.recovery.transactionStatus,
      transactionPreparedAt: args.recovery.transactionPreparedAt ?? null,
      transactionCommittedAt: args.recovery.transactionCommittedAt ?? null,
      bindingPayloadHash: args.recovery.bindingPayloadHash,
      recoveredAt: args.recovery.recoveredAt ?? null,
      recoveryEvidenceRefs: args.recovery.recoveryEvidenceRefs,
      verificationEvidenceRefs: args.recovery.verificationEvidenceRefs,
      identityBindingRefs: args.recovery.identityBindingRefs,
      resolvesEvidenceIds: args.recovery.resolvesEvidenceIds ?? [],
      resolvesSubjectIds: args.recovery.resolvesSubjectIds ?? [],
      note: args.recovery.note ?? null,
    },
  });
}

export function appendEvidenceReceipt(
  ctx: RunContext,
  evidence: EvidenceReceipt,
): EvidenceReceipt {
  const result = appendLedgerEntry(
    ctx.runPaths.evidenceFile,
    evidence as unknown as Record<string, unknown>,
  );
  const entry = result.entry as unknown as EvidenceReceipt;
  ctx.logger.event('evidence_ref', {
    evidenceId: entry.evidenceId,
    kind: entry.kind,
    subjectId: entry.subject.subjectId,
    lineHash: result.lineHash,
  });
  return entry;
}

export function readEvidenceReceipts(path: string): EvidenceReceipt[] {
  return readJsonl<EvidenceReceipt>(path).map((record) => record.value);
}

export function evidenceLedgerStats(path: string): {
  readonly entries: number;
  readonly tipHash: string | null;
} {
  return ledgerStats(path);
}

function previewContent(value: unknown): string {
  const text = stableHash(value);
  const rendered = JSON.stringify({ sha256: text });
  return rendered.length <= 800 ? rendered : `${rendered.slice(0, 800)}...`;
}
