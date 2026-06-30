import type { RunContext } from '../../types.js';
import { appendLedgerEntry } from './ledger.js';
import { sha256Hex, stableId, stableStringify } from './hash.js';
import {
  createLocalAttestation,
  ZK_NOT_REQUESTED,
} from '../proof/local.js';
import type {
  BcrxSubjectFields,
  EpistemicState,
  ProtocolAttestation,
  ProtocolMessage,
  ProtocolMessageKind,
  ProtocolReceipt,
  SignatureDescriptor,
  ZkSnarkDescriptor,
} from './types.js';

const UNSIGNED: SignatureDescriptor = {
  status: 'unsigned',
  algorithm: 'sha256',
  reason: 'signing backend not configured',
};

export function createProtocolMessage(args: {
  readonly kind: ProtocolMessageKind;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: BcrxSubjectFields;
  readonly body: unknown;
  readonly epistemics?: EpistemicState;
  readonly evidenceRefs?: readonly string[];
  readonly inReplyTo?: string | undefined;
  readonly causalityRefs?: readonly string[];
  readonly createdAt?: string;
  readonly signature?: SignatureDescriptor | undefined;
  readonly attestation?: ProtocolAttestation | undefined;
}): ProtocolMessage {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const epistemics = args.epistemics ?? {
    status: 'uncertain',
    uncertainty: 'caller did not provide an epistemic status',
  };
  const base = {
    protocolVersion: '2.0',
    kind: args.kind,
    from: args.from,
    to: args.to,
    subject: args.subject,
    createdAt,
    body: args.body,
    epistemics,
    evidenceRefs: args.evidenceRefs ?? [],
    inReplyTo: args.inReplyTo ?? null,
    causalityRefs: args.causalityRefs ?? [],
  };
  return {
    messageId: stableId('msg', base),
    schemaVersion: 'superharness.protocol.message.v2',
    protocolVersion: '2.0',
    kind: args.kind,
    from: args.from,
    to: args.to,
    subject: args.subject,
    createdAt,
    body: args.body,
    epistemics,
    evidenceRefs: args.evidenceRefs ?? [],
    ...(args.inReplyTo !== undefined ? { inReplyTo: args.inReplyTo } : {}),
    causalityRefs: args.causalityRefs ?? [],
    signature: args.signature ?? UNSIGNED,
    ...(args.attestation !== undefined ? { attestation: args.attestation } : {}),
  };
}

export function createProtocolReceipt(args: {
  readonly receiptType: ProtocolReceipt['receiptType'];
  readonly subject: BcrxSubjectFields;
  readonly status: ProtocolReceipt['status'];
  readonly messageId?: string | undefined;
  readonly payload: unknown;
  readonly evidenceRefs?: readonly string[];
  readonly implementerAgentId?: string | undefined;
  readonly verifierAgentId?: string | undefined;
  readonly independentVerification?: ProtocolReceipt['independentVerification'];
  readonly issuedAt?: string;
  readonly signature?: SignatureDescriptor;
  readonly zkSnark?: ZkSnarkDescriptor;
}): ProtocolReceipt {
  const issuedAt = args.issuedAt ?? new Date().toISOString();
  const evidenceRefs = args.evidenceRefs ?? [];
  const publicInputs = {
    receiptType: args.receiptType,
    subject: args.subject,
    messageId: args.messageId ?? null,
    status: args.status,
    evidenceRefs,
    implementerAgentId: args.implementerAgentId ?? null,
    verifierAgentId: args.verifierAgentId ?? null,
    independentVerification: args.independentVerification ?? null,
  };
  const publicInputsHash = sha256Hex(stableStringify(publicInputs));
  const payloadHash = sha256Hex(stableStringify(args.payload));
  return {
    receiptId: stableId('receipt', {
      publicInputsHash,
      payloadHash,
      issuedAt,
    }),
    schemaVersion: 'superharness.protocol.receipt.v2',
    protocolVersion: '2.0',
    receiptType: args.receiptType,
    subject: args.subject,
    issuedAt,
    ...(args.messageId !== undefined ? { messageId: args.messageId } : {}),
    status: args.status,
    publicInputsHash,
    payloadHash,
    evidenceRefs,
    ...(args.implementerAgentId !== undefined ? { implementerAgentId: args.implementerAgentId } : {}),
    ...(args.verifierAgentId !== undefined ? { verifierAgentId: args.verifierAgentId } : {}),
    ...(args.independentVerification !== undefined ? { independentVerification: args.independentVerification } : {}),
    signature: args.signature ?? UNSIGNED,
    zkSnark: args.zkSnark ?? ZK_NOT_REQUESTED,
  };
}

export function appendProtocolMessage(
  ctx: RunContext,
  message: ProtocolMessage,
): ProtocolMessage {
  const result = appendLedgerEntry(
    ctx.runPaths.protocolMessagesFile,
    message as unknown as Record<string, unknown>,
  );
  const entry = result.entry as unknown as ProtocolMessage;
  ctx.logger.event('protocol_ref', {
    messageId: entry.messageId,
    kind: entry.kind,
    subjectId: entry.subject.subjectId,
    lineHash: result.lineHash,
  });
  return entry;
}

export function appendProtocolReceipt(
  ctx: RunContext,
  receipt: ProtocolReceipt,
): ProtocolReceipt {
  const result = appendLedgerEntry(
    ctx.runPaths.protocolReceiptsFile,
    receipt as unknown as Record<string, unknown>,
  );
  const entry = result.entry as unknown as ProtocolReceipt;
  ctx.logger.event('receipt_ref', {
    receiptId: entry.receiptId,
    receiptType: entry.receiptType,
    subjectId: entry.subject.subjectId,
    lineHash: result.lineHash,
  });
  return entry;
}

export function buildLocalAttestation(args: {
  readonly statement: string;
  readonly publicInputs: unknown;
  readonly zkEnabled?: boolean;
}): ProtocolAttestation {
  return createLocalAttestation({
    statement: args.statement,
    publicInputs: args.publicInputs,
    includeMockZk: args.zkEnabled === true,
  });
}
