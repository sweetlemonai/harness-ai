import type {
  AgentIdentity,
  EvidenceRef,
  ReceiptKind,
  ReceiptV2,
  SignatureStatus,
  VerificationIssue,
  VerificationReport,
} from '../../types.js';
import { stableId } from './hash.js';
import { createVerificationReport, issue } from './verify.js';

export const UNSIGNED_LOCAL_SIGNATURE: SignatureStatus = {
  status: 'unsigned',
  algorithm: 'sha256',
  reason: 'local hash receipt; signing backend not configured',
};

export function createReceipt(args: {
  readonly kind: ReceiptKind;
  readonly subjectId: string;
  readonly issuer: AgentIdentity;
  readonly recipient?: AgentIdentity;
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly previousReceiptId?: string;
  readonly issuedAt?: string;
  readonly signature?: SignatureStatus;
}): ReceiptV2 {
  const payload = {
    kind: args.kind,
    subjectId: args.subjectId,
    issuer: args.issuer,
    ...(args.recipient !== undefined ? { recipient: args.recipient } : {}),
    issuedAt: args.issuedAt ?? new Date().toISOString(),
    evidenceRefs: args.evidenceRefs ?? [],
    ...(args.previousReceiptId !== undefined ? { previousReceiptId: args.previousReceiptId } : {}),
    signature: args.signature ?? UNSIGNED_LOCAL_SIGNATURE,
  };
  return {
    receiptId: computeReceiptId(payload),
    ...payload,
  };
}

export function computeReceiptId(receipt: Omit<ReceiptV2, 'receiptId'>): string {
  return stableId('receipt', receipt);
}

export function verifyReceipt(receipt: ReceiptV2): VerificationReport {
  const issues: VerificationIssue[] = [];
  const receiptLike = receipt as Partial<ReceiptV2>;
  const expected = computeReceiptId(receiptPayload(receipt));
  if (receipt.receiptId !== expected) {
    issues.push(issue('error', 'receipt.id_mismatch', 'receiptId does not match canonical receipt payload', {
      subjectId: receipt.receiptId,
    }));
  }
  if (typeof receiptLike.subjectId !== 'string' || receiptLike.subjectId.trim() === '') {
    issues.push(issue('error', 'receipt.subject_missing', 'receipt subjectId must be non-empty', {
      subjectId: receipt.receiptId,
    }));
  }
  if (!Array.isArray(receiptLike.evidenceRefs)) {
    issues.push(issue('error', 'receipt.evidence_refs_invalid', 'receipt evidenceRefs must be an array', {
      subjectId: receipt.receiptId,
    }));
  } else if (receiptLike.evidenceRefs.length === 0 && receipt.kind !== 'proof_unavailable') {
    issues.push(issue('warning', 'receipt.evidence_missing', 'receipt has no evidence refs', {
      subjectId: receipt.receiptId,
    }));
  }
  if (receiptLike.signature?.status !== 'signed') {
    issues.push(issue('warning', 'receipt.signature_not_signed', 'receipt is not cryptographically signed', {
      subjectId: receipt.receiptId,
    }));
  }
  return createVerificationReport({ subject: receipt.receiptId, issues });
}

export function verifyReceiptChain(receipts: readonly ReceiptV2[]): VerificationReport {
  const issues: VerificationIssue[] = [];
  const seen = new Set<string>();
  const indexById = new Map<string, number>();

  receipts.forEach((receipt, index) => {
    const report = verifyReceipt(receipt);
    issues.push(...report.issues.map((entry) => ({ ...entry, line: entry.line ?? index + 1 })));

    if (seen.has(receipt.receiptId)) {
      issues.push(issue('error', 'receipt.duplicate_id', 'duplicate receiptId in chain', {
        subjectId: receipt.receiptId,
        line: index + 1,
      }));
    }
    seen.add(receipt.receiptId);
    indexById.set(receipt.receiptId, index);
  });

  receipts.forEach((receipt, index) => {
    if (receipt.previousReceiptId === undefined) return;
    const previousIndex = indexById.get(receipt.previousReceiptId);
    if (previousIndex === undefined) {
      issues.push(issue('error', 'receipt.previous_missing', 'previousReceiptId is not present', {
        subjectId: receipt.receiptId,
        line: index + 1,
      }));
      return;
    }
    if (previousIndex >= index) {
      issues.push(issue('error', 'receipt.previous_not_earlier', 'previousReceiptId must point to an earlier receipt', {
        subjectId: receipt.receiptId,
        line: index + 1,
      }));
    }
    const previous = receipts[previousIndex];
    if (previous !== undefined && previous.subjectId !== receipt.subjectId) {
      issues.push(issue('error', 'receipt.subject_chain_mismatch', 'receipt chain crosses subject ids', {
        subjectId: receipt.receiptId,
        line: index + 1,
      }));
    }
  });

  return createVerificationReport({
    subject: 'receipt-chain',
    issues,
    ...(receipts.at(-1)?.receiptId !== undefined ? { headHash: receipts.at(-1)!.receiptId } : {}),
  });
}

function receiptPayload(receipt: ReceiptV2): Omit<ReceiptV2, 'receiptId'> {
  const {
    receiptId: _receiptId,
    previousLineHash: _previousLineHash,
    ...payload
  } = receipt as ReceiptV2 & { readonly previousLineHash?: string | null };
  return payload;
}
