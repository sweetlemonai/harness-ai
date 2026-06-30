import { resolve } from 'node:path';
import {
  PROTOCOL_VERSION_V2,
  type AgentIdentity,
  type AgentRecipient,
  type EvidenceRef,
  type MessageBody,
  type MessageEnvelopeV2,
  type MessageIntent,
  type ReceiptKind,
  type ReceiptV2,
  type ScopeRef,
} from '../../types.js';
import type {
  VerificationIssue,
  VerificationReport,
} from '../../types.js';
import { appendLedgerEntry, readLedgerEntries } from '../protocol/ledger.js';
import { createReceipt } from '../protocol/receipts.js';
import { createScopeRef } from '../protocol/scope.js';
import { createVerificationReport, issue } from '../protocol/verify.js';
import { sidecarPathsForRunDir } from '../protocol/sidecar.js';
import { sha256Hex, stableId, stableStringify } from '../protocol/hash.js';

const BUS_IDENTITY: AgentIdentity = {
  agentId: 'superharness.local-jsonl-bus',
  kind: 'system',
  displayName: 'Super Harness local JSONL bus',
};

export interface BusDeliveryEntry {
  readonly schemaVersion: 'superharness.bus.delivery.v2';
  readonly messageId: string;
  readonly agentId: string;
  readonly direction: 'inbox' | 'outbox';
  readonly envelope: MessageEnvelopeV2;
  readonly receiptIds: readonly string[];
  readonly createdAt: string;
  readonly previousLineHash?: string | null;
}

export interface BusTransactionEntry {
  readonly schemaVersion: 'superharness.bus.transaction.v2';
  readonly transactionId: string;
  readonly type: 'send' | 'read' | 'ack';
  readonly messageId: string;
  readonly idempotencyKey?: string;
  readonly agentId?: string;
  readonly envelope?: MessageEnvelopeV2;
  readonly receipts: readonly ReceiptV2[];
  readonly createdAt: string;
  readonly previousLineHash?: string | null;
}

export interface SendBusMessageInput {
  readonly runDir: string;
  readonly from: AgentIdentity;
  readonly to: readonly AgentRecipient[];
  readonly intent: MessageIntent;
  readonly body: MessageBody;
  readonly scope?: ScopeRef;
  readonly threadId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly taskRef?: string;
  readonly requiredReceipts?: readonly ReceiptKind[];
  readonly deadline?: string;
  readonly idempotencyKey?: string;
  readonly createdAt?: string;
}

export interface SendBusMessageResult {
  readonly envelope: MessageEnvelopeV2;
  readonly sentReceipt: ReceiptV2;
  readonly deliveredReceipts: readonly ReceiptV2[];
  readonly undeliverableReceipts: readonly ReceiptV2[];
  readonly duplicate: boolean;
}

export interface InboxReadResult {
  readonly agentId: string;
  readonly messages: readonly MessageEnvelopeV2[];
  readonly readReceipts: readonly ReceiptV2[];
}

export interface AckBusMessageInput {
  readonly runDir: string;
  readonly agent: AgentIdentity;
  readonly messageId: string;
  readonly kind: Extract<ReceiptKind, 'accepted' | 'rejected' | 'completed' | 'failed' | 'challenged'>;
  readonly issuedAt?: string;
}

export interface AckBusMessageResult {
  readonly receipt: ReceiptV2;
  readonly duplicate: boolean;
}

export function sendBusMessage(input: SendBusMessageInput): SendBusMessageResult {
  const files = sidecarPathsForRunDir(input.runDir);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const scope = input.scope ?? defaultScope(files.runDir);
  const threadId = input.threadId ?? stableId('thread', {
    runDir: files.runDir,
    from: input.from.agentId,
    to: input.to.map((recipient) => recipient.agentId),
    createdAt,
  });
  const idempotencyKey = input.idempotencyKey ?? stableId('idem', {
    threadId,
    from: input.from.agentId,
    to: input.to.map((recipient) => recipient.agentId),
    intent: input.intent,
    body: input.body,
    createdAt,
  });
  const existing = readBusTransactions(files.runDir)
    .filter((entry) => entry.type === 'send')
    .find((entry) => entry.idempotencyKey === idempotencyKey);
  if (existing !== undefined) {
    const receipts = existing.receipts;
    const envelope = existing.envelope;
    if (envelope === undefined) {
      throw new Error(`committed send transaction is missing envelope: ${existing.transactionId}`);
    }
    return {
      envelope,
      sentReceipt: receipts.find((receipt) => receipt.kind === 'sent') ?? createReceipt({
        kind: 'sent',
        subjectId: envelope.messageId,
        issuer: input.from,
        evidenceRefs: [busEvidenceRef({
          kind: 'sent',
          subjectId: envelope.messageId,
          issuer: input.from,
          issuedAt: createdAt,
        })],
        signature: busSignature({
          kind: 'sent',
          subjectId: envelope.messageId,
          issuer: input.from,
          issuedAt: createdAt,
        }),
      }),
      deliveredReceipts: receipts.filter((receipt) => receipt.kind === 'delivered'),
      undeliverableReceipts: receipts.filter((receipt) => receipt.kind === 'undeliverable'),
      duplicate: true,
    };
  }
  const envelope = createEnvelope({
    runDir: files.runDir,
    from: input.from,
    to: input.to,
    scope,
    threadId,
    intent: input.intent,
    body: input.body,
    createdAt,
    idempotencyKey,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    ...(input.taskRef !== undefined ? { taskRef: input.taskRef } : {}),
    ...(input.requiredReceipts !== undefined ? { requiredReceipts: input.requiredReceipts } : {}),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
  });
  appendLedgerEntry(files.protocolEnvelopesFile, envelope as unknown as Record<string, unknown>);
  const sentReceipt = appendReceipt(files.runDir, createBusReceipt({
    kind: 'sent',
    subjectId: envelope.messageId,
    issuer: input.from,
    issuedAt: createdAt,
  }));
  const deliveredReceipts: ReceiptV2[] = [];
  const undeliverableReceipts: ReceiptV2[] = [];
  for (const recipient of envelope.recipients) {
    if (!isReachableLocalInbox(recipient)) {
      const undeliverable = appendReceipt(files.runDir, createBusReceipt({
        kind: 'undeliverable',
        subjectId: envelope.messageId,
        issuer: BUS_IDENTITY,
        recipient: agentIdentity(recipient.agentId),
        previousReceiptId: sentReceipt.receiptId,
        issuedAt: createdAt,
      }));
      undeliverableReceipts.push(undeliverable);
      continue;
    }
    const delivered = appendReceipt(files.runDir, createBusReceipt({
      kind: 'delivered',
      subjectId: envelope.messageId,
      issuer: BUS_IDENTITY,
      recipient: agentIdentity(recipient.agentId),
      previousReceiptId: sentReceipt.receiptId,
      issuedAt: createdAt,
    }));
    deliveredReceipts.push(delivered);
    appendDelivery(files.runDir, recipient.agentId, 'inbox', envelope, [sentReceipt.receiptId, delivered.receiptId], createdAt);
  }
  appendDelivery(files.runDir, envelope.sender.agentId, 'outbox', envelope, [
    sentReceipt.receiptId,
    ...deliveredReceipts.map((receipt) => receipt.receiptId),
    ...undeliverableReceipts.map((receipt) => receipt.receiptId),
  ], createdAt);
  appendBusTransaction(files.runDir, {
    type: 'send',
    messageId: envelope.messageId,
    idempotencyKey,
    envelope,
    receipts: [sentReceipt, ...deliveredReceipts, ...undeliverableReceipts],
    createdAt,
  });
  return {
    envelope,
    sentReceipt,
    deliveredReceipts,
    undeliverableReceipts,
    duplicate: false,
  };
}

export function localJsonlInboxUri(agentId: string): string {
  return `local-jsonl://inbox/${encodeURIComponent(agentId)}`;
}

export function readInbox(args: {
  readonly runDir: string;
  readonly agentId: string;
  readonly markRead?: boolean;
  readonly issuedAt?: string;
}): InboxReadResult {
  const files = sidecarPathsForRunDir(args.runDir);
  const committedIds = new Set(readBusEnvelopes(files.runDir).map((entry) => entry.messageId));
  const entries = readLedgerEntries<BusDeliveryEntry>(inboxFile(files.runDir, args.agentId));
  const messages = entries
    .map((entry) => entry.envelope)
    .filter((entry) => committedIds.has(entry.messageId));
  const readReceipts: ReceiptV2[] = [];
  if (args.markRead === true) {
    for (const envelope of messages) {
      const existing = findReceipt(files.runDir, envelope.messageId, 'read', args.agentId);
      if (existing !== undefined) {
        readReceipts.push(existing);
        continue;
      }
      const receipt = appendReceipt(files.runDir, createBusReceipt({
        kind: 'read',
        subjectId: envelope.messageId,
        issuer: agentIdentity(args.agentId),
        ...(latestReceipt(files.runDir, envelope.messageId)?.receiptId !== undefined
          ? { previousReceiptId: latestReceipt(files.runDir, envelope.messageId)!.receiptId }
          : {}),
        ...(args.issuedAt !== undefined ? { issuedAt: args.issuedAt } : {}),
      }));
      appendBusTransaction(files.runDir, {
        type: 'read',
        messageId: envelope.messageId,
        agentId: args.agentId,
        receipts: [receipt],
        createdAt: receipt.issuedAt,
      });
      readReceipts.push(receipt);
    }
  }
  return {
    agentId: args.agentId,
    messages,
    readReceipts,
  };
}

export function ackBusMessage(input: AckBusMessageInput): AckBusMessageResult {
  const existing = findReceipt(input.runDir, input.messageId, input.kind, input.agent.agentId);
  if (existing !== undefined) {
    return { receipt: existing, duplicate: true };
  }
  const receipt = appendReceipt(input.runDir, createBusReceipt({
    kind: input.kind,
    subjectId: input.messageId,
    issuer: input.agent,
    ...(latestReceipt(input.runDir, input.messageId)?.receiptId !== undefined
      ? { previousReceiptId: latestReceipt(input.runDir, input.messageId)!.receiptId }
      : {}),
    ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
  }));
  appendBusTransaction(input.runDir, {
    type: 'ack',
    messageId: input.messageId,
    agentId: input.agent.agentId,
    receipts: [receipt],
    createdAt: receipt.issuedAt,
  });
  return { receipt, duplicate: false };
}

export function ackBusMessageWithRead(input: AckBusMessageInput): AckBusMessageResult {
  const existing = findReceipt(input.runDir, input.messageId, input.kind, input.agent.agentId);
  if (existing !== undefined) {
    return { receipt: existing, duplicate: true };
  }
  const receipts: ReceiptV2[] = [];
  const existingRead = findReceipt(input.runDir, input.messageId, 'read', input.agent.agentId);
  const readReceipt = existingRead ?? appendReceipt(input.runDir, createBusReceipt({
    kind: 'read',
    subjectId: input.messageId,
    issuer: input.agent,
    ...(latestReceipt(input.runDir, input.messageId)?.receiptId !== undefined
      ? { previousReceiptId: latestReceipt(input.runDir, input.messageId)!.receiptId }
      : {}),
    ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
  }));
  if (existingRead === undefined) receipts.push(readReceipt);
  const receipt = appendReceipt(input.runDir, createBusReceipt({
    kind: input.kind,
    subjectId: input.messageId,
    issuer: input.agent,
    previousReceiptId: readReceipt.receiptId,
    ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
  }));
  receipts.push(receipt);
  appendBusTransaction(input.runDir, {
    type: 'ack',
    messageId: input.messageId,
    agentId: input.agent.agentId,
    receipts,
    createdAt: receipt.issuedAt,
  });
  return { receipt, duplicate: false };
}

export function readBusEnvelopes(runDir: string): MessageEnvelopeV2[] {
  return readBusTransactions(runDir)
    .filter((entry) => entry.type === 'send' && entry.envelope !== undefined)
    .map((entry) => entry.envelope!);
}

export function readLifecycleReceipts(runDir: string): ReceiptV2[] {
  return readBusTransactions(runDir).flatMap((entry) => [...entry.receipts]);
}

export function readBusTransactions(runDir: string): BusTransactionEntry[] {
  return readLedgerEntries<BusTransactionEntry>(sidecarPathsForRunDir(runDir).protocolBusTransactionsFile);
}

export function auditBusProjections(runDir: string): VerificationReport {
  const files = sidecarPathsForRunDir(runDir);
  const issues: VerificationIssue[] = [];
  const committedEnvelopes = new Map(
    readBusEnvelopes(runDir).map((envelope) => [envelope.messageId, envelope]),
  );
  const committedReceipts = new Map(
    readLifecycleReceipts(runDir).map((receipt) => [receipt.receiptId, receipt]),
  );
  const projectedEnvelopes = readLedgerEntries<MessageEnvelopeV2>(files.protocolEnvelopesFile);
  const projectedReceipts = readLedgerEntries<ReceiptV2>(files.protocolLifecycleReceiptsFile);
  for (const envelope of projectedEnvelopes) {
    const committed = committedEnvelopes.get(envelope.messageId);
    if (committed === undefined) {
      issues.push(issue('warning', 'bus_projection.orphan_envelope', 'projection envelope has no committed bus transaction', {
        subjectId: envelope.messageId,
      }));
      continue;
    }
    if (stableStringify(withoutLedgerMetadata(envelope)) !== stableStringify(withoutLedgerMetadata(committed))) {
      issues.push(issue('error', 'bus_projection.envelope_diverged', 'projection envelope diverges from committed bus transaction', {
        subjectId: envelope.messageId,
      }));
    }
  }
  for (const [messageId] of committedEnvelopes) {
    if (!projectedEnvelopes.some((entry) => entry.messageId === messageId)) {
      issues.push(issue('warning', 'bus_projection.envelope_missing', 'committed bus envelope is missing from projection file and should be rebuilt', {
        subjectId: messageId,
      }));
    }
  }
  for (const receipt of projectedReceipts) {
    const committed = committedReceipts.get(receipt.receiptId);
    if (committed === undefined) {
      issues.push(issue('warning', 'bus_projection.orphan_receipt', 'projection receipt has no committed bus transaction', {
        subjectId: receipt.receiptId,
      }));
      continue;
    }
    if (stableStringify(withoutLedgerMetadata(receipt)) !== stableStringify(withoutLedgerMetadata(committed))) {
      issues.push(issue('error', 'bus_projection.receipt_diverged', 'projection receipt diverges from committed bus transaction', {
        subjectId: receipt.receiptId,
      }));
    }
  }
  for (const [receiptId] of committedReceipts) {
    if (!projectedReceipts.some((entry) => entry.receiptId === receiptId)) {
      issues.push(issue('warning', 'bus_projection.receipt_missing', 'committed bus receipt is missing from projection file and should be rebuilt', {
        subjectId: receiptId,
      }));
    }
  }
  return createVerificationReport({
    subject: `${files.runDir}/protocol/projections`,
    issues,
  });
}

function withoutLedgerMetadata<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const {
    previousLineHash: _previousLineHash,
    ...rest
  } = value as T & { readonly previousLineHash?: string | null };
  return rest as T;
}

function createEnvelope(args: {
  readonly runDir: string;
  readonly from: AgentIdentity;
  readonly to: readonly AgentRecipient[];
  readonly scope: ScopeRef;
  readonly threadId: string;
  readonly intent: MessageIntent;
  readonly body: MessageBody;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly taskRef?: string;
  readonly requiredReceipts?: readonly ReceiptKind[];
  readonly deadline?: string;
}): MessageEnvelopeV2 {
  const requiredReceipts = args.requiredReceipts ?? ['delivered', 'read', 'accepted'];
  const idBase = {
    protocolVersion: PROTOCOL_VERSION_V2,
    threadId: args.threadId,
    correlationId: args.correlationId ?? null,
    causationId: args.causationId ?? null,
    runId: args.scope.runId,
    scope: args.scope,
    tenantId: args.scope.tenantId ?? null,
    taskRef: args.taskRef ?? null,
    createdAt: args.createdAt,
    privacyZone: args.scope.privacyZone,
    visibility: args.scope.visibility,
    sender: args.from,
    recipients: args.to,
    intent: args.intent,
    body: args.body,
    requiredReceipts,
    deadline: args.deadline ?? null,
    idempotencyKey: args.idempotencyKey,
  };
  return {
    protocolVersion: PROTOCOL_VERSION_V2,
    messageId: stableId('env', idBase),
    threadId: args.threadId,
    ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
    ...(args.causationId !== undefined ? { causationId: args.causationId } : {}),
    runId: args.scope.runId,
    scope: args.scope,
    ...(args.scope.tenantId !== undefined ? { tenantId: args.scope.tenantId } : {}),
    ...(args.taskRef !== undefined ? { taskRef: args.taskRef } : {}),
    createdAt: args.createdAt,
    privacyZone: args.scope.privacyZone,
    visibility: args.scope.visibility,
    sender: args.from,
    recipients: args.to,
    intent: args.intent,
    body: args.body,
    claims: [],
    evidenceRefs: [],
    requiredReceipts,
    ...(args.deadline !== undefined ? { deadline: args.deadline } : {}),
    idempotencyKey: args.idempotencyKey,
    externalRefs: [],
    signature: busSignature(idBase),
  };
}

function createBusReceipt(args: {
  readonly kind: ReceiptKind;
  readonly subjectId: string;
  readonly issuer: AgentIdentity;
  readonly recipient?: AgentIdentity;
  readonly previousReceiptId?: string;
  readonly issuedAt?: string;
}): ReceiptV2 {
  const issuedAt = args.issuedAt ?? new Date().toISOString();
  const evidenceRefs = [busEvidenceRef({
    kind: args.kind,
    subjectId: args.subjectId,
    issuer: args.issuer,
    ...(args.recipient !== undefined ? { recipient: args.recipient } : {}),
    ...(args.previousReceiptId !== undefined ? { previousReceiptId: args.previousReceiptId } : {}),
    issuedAt,
  })];
  return createReceipt({
    kind: args.kind,
    subjectId: args.subjectId,
    issuer: args.issuer,
    ...(args.recipient !== undefined ? { recipient: args.recipient } : {}),
    evidenceRefs,
    ...(args.previousReceiptId !== undefined ? { previousReceiptId: args.previousReceiptId } : {}),
    issuedAt,
    signature: busSignature({
      kind: args.kind,
      subjectId: args.subjectId,
      issuer: args.issuer,
      recipient: args.recipient ?? null,
      previousReceiptId: args.previousReceiptId ?? null,
      issuedAt,
      evidenceRefs,
    }),
  });
}

function busEvidenceRef(args: {
  readonly kind: ReceiptKind;
  readonly subjectId: string;
  readonly issuer: AgentIdentity;
  readonly recipient?: AgentIdentity;
  readonly previousReceiptId?: string;
  readonly issuedAt: string;
}): EvidenceRef {
  const content = {
    protocolVersion: PROTOCOL_VERSION_V2,
    kind: args.kind,
    subjectId: args.subjectId,
    issuer: args.issuer,
    recipient: args.recipient ?? null,
    previousReceiptId: args.previousReceiptId ?? null,
    issuedAt: args.issuedAt,
  };
  const sha256 = sha256Hex(stableStringify(content));
  return {
    evidenceId: stableId('evidence', {
      kind: 'receipt',
      uri: `bus://${args.subjectId}/${args.kind}/${args.issuer.agentId}`,
      sha256,
      observedAt: args.issuedAt,
    }),
    kind: 'receipt',
    uri: `bus://${args.subjectId}/${args.kind}/${args.issuer.agentId}`,
    sha256,
    contentType: 'application/vnd.superharness.bus-receipt+json',
    producedBy: BUS_IDENTITY,
    observedAt: args.issuedAt,
    retentionPolicy: 'run_sidecar',
  };
}

function busSignature(payload: unknown) {
  return {
    status: 'signed' as const,
    algorithm: 'sha256-local-integrity',
    signature: `sha256:${sha256Hex(stableStringify(payload))}`,
    publicKeyRef: 'local-jsonl-bus',
    reason: 'local bus integrity signature; not registry identity-bound',
  };
}

function appendReceipt(runDir: string, receipt: ReceiptV2): ReceiptV2 {
  const files = sidecarPathsForRunDir(runDir);
  const appended = appendLedgerEntry(files.protocolLifecycleReceiptsFile, receipt as unknown as Record<string, unknown>);
  return appended.entry as unknown as ReceiptV2;
}

function appendDelivery(
  runDir: string,
  agentId: string,
  direction: BusDeliveryEntry['direction'],
  envelope: MessageEnvelopeV2,
  receiptIds: readonly string[],
  createdAt: string,
): void {
  appendLedgerEntry((direction === 'inbox' ? inboxFile : outboxFile)(runDir, agentId), {
    schemaVersion: 'superharness.bus.delivery.v2',
    messageId: envelope.messageId,
    agentId,
    direction,
    envelope,
    receiptIds,
    createdAt,
  });
}

function appendBusTransaction(
  runDir: string,
  args: {
    readonly type: BusTransactionEntry['type'];
    readonly messageId: string;
    readonly idempotencyKey?: string;
    readonly agentId?: string;
    readonly envelope?: MessageEnvelopeV2;
    readonly receipts: readonly ReceiptV2[];
    readonly createdAt: string;
  },
): BusTransactionEntry {
  const entry: Omit<BusTransactionEntry, 'transactionId'> = {
    schemaVersion: 'superharness.bus.transaction.v2',
    type: args.type,
    messageId: args.messageId,
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    ...(args.envelope !== undefined ? { envelope: args.envelope } : {}),
    receipts: args.receipts,
    createdAt: args.createdAt,
  };
  const transaction = {
    ...entry,
    transactionId: stableId('bus_tx', {
      type: entry.type,
      messageId: entry.messageId,
      idempotencyKey: entry.idempotencyKey ?? null,
      agentId: entry.agentId ?? null,
      receiptIds: entry.receipts.map((receipt) => receipt.receiptId),
      createdAt: entry.createdAt,
    }),
  };
  const files = sidecarPathsForRunDir(runDir);
  return appendLedgerEntry(
    files.protocolBusTransactionsFile,
    transaction as unknown as Record<string, unknown>,
  ).entry as unknown as BusTransactionEntry;
}

function findReceipt(
  runDir: string,
  subjectId: string,
  kind: ReceiptKind,
  issuerAgentId: string,
): ReceiptV2 | undefined {
  return readLifecycleReceipts(runDir)
    .find((receipt) =>
      receipt.subjectId === subjectId
      && receipt.kind === kind
      && receipt.issuer.agentId === issuerAgentId,
    );
}

function latestReceipt(runDir: string, subjectId: string): ReceiptV2 | undefined {
  return readLifecycleReceipts(runDir)
    .filter((receipt) => receipt.subjectId === subjectId)
    .at(-1);
}

function isReachableLocalInbox(recipient: AgentRecipient): boolean {
  return recipient.inboxUri === localJsonlInboxUri(recipient.agentId);
}

function inboxFile(runDir: string, agentId: string): string {
  return resolve(sidecarPathsForRunDir(runDir).protocolInboxDir, `${safeAgentFile(agentId)}.jsonl`);
}

function outboxFile(runDir: string, agentId: string): string {
  return resolve(sidecarPathsForRunDir(runDir).protocolOutboxDir, `${safeAgentFile(agentId)}.jsonl`);
}

function safeAgentFile(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function agentIdentity(agentId: string): AgentIdentity {
  return {
    agentId,
    kind: 'system',
  };
}

function defaultScope(runDir: string): ScopeRef {
  const runId = runDir.split('/').filter((part) => part.length > 0).at(-1) ?? 'manual-run';
  return createScopeRef({
    runId,
    workspaceId: 'workspace:local',
    tenantMode: false,
    privacyZone: 'WORKSPACE',
    visibility: 'operator_visible',
  });
}
