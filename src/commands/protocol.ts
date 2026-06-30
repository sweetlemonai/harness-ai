import {
  appendLedgerEntry,
  readLedgerEntries,
} from '../lib/protocol/ledger.js';
import {
  ackBusMessage,
  auditBusProjections,
  localJsonlInboxUri,
  readInbox,
  readBusEnvelopes,
  readLifecycleReceipts,
  readBusTransactions,
  sendBusMessage,
} from '../lib/collaboration/localJsonlBus.js';
import {
  doctorProtocol,
  doctorProtocolSidecars,
  type ProtocolDoctorAuditMode,
  type ProtocolDoctorProfile,
} from '../lib/protocol/doctor.js';
import {
  createProtocolMessage,
  createProtocolReceipt,
} from '../lib/protocol/messages.js';
import { sidecarPathsForRunDir } from '../lib/protocol/sidecar.js';
import type {
  BcrxSubjectFields,
  EpistemicStatus,
  IdentityBindingStatus,
  ProtocolAssuranceContext,
  ProtocolMessage,
  ProtocolMessageKind,
  ProtocolReceipt,
  VerifierSelectionMethod,
} from '../lib/protocol/types.js';
import {
  stableHash,
  stableId,
} from '../lib/protocol/hash.js';
import {
  createAdapterRecoveryEvidence,
  createAdapterFailureEvidence,
  createEvidenceReceipt,
} from '../lib/evidence/ledger.js';
import { evaluateProductionPromotion } from '../lib/protocol/promotion.js';
import type { AdapterFailureInput, AdapterRecoveryInput, EvidenceReceipt } from '../lib/evidence/types.js';
import { createRllEvent } from '../lib/rll/ledger.js';
import {
  loadConfiguredSidecarSigner,
  signEvidenceReceipt,
  signProtocolMessage,
  signProtocolReceipt,
  type SidecarSigner,
} from '../lib/proof/signing.js';
import type {
  AgentIdentity,
  MessageBody,
  MessageIntent,
  ReceiptKind,
} from '../types.js';

export interface ProtocolDoctorCommandArgs {
  readonly runDir: string;
  readonly auditMode?: ProtocolDoctorAuditMode;
  readonly profile?: ProtocolDoctorProfile;
  readonly json?: boolean;
}

export interface ProtocolEmitCommandArgs {
  readonly runDir: string;
  readonly kind: ProtocolMessageKind;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject?: string;
  readonly body?: string;
  readonly evidenceRefs?: readonly string[];
  readonly epistemicStatus?: EpistemicStatus;
  readonly json?: boolean;
}

export interface ProtocolSendCommandArgs {
  readonly runDir: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly intent: MessageIntent;
  readonly body?: string;
  readonly threadId?: string;
  readonly idempotencyKey?: string;
  readonly deadline?: string;
  readonly requiredReceipts?: readonly ReceiptKind[];
  readonly json?: boolean;
}

export interface ProtocolInboxCommandArgs {
  readonly runDir: string;
  readonly agentId: string;
  readonly markRead?: boolean;
  readonly json?: boolean;
}

export interface ProtocolInboxView {
  readonly agentId: string;
  readonly messages: ReturnType<typeof readInbox>['messages'];
  readonly readReceipts: ReturnType<typeof readInbox>['readReceipts'];
  readonly sidecarMessages: readonly ProtocolMessage[];
  readonly sidecarReceipts: readonly ProtocolReceipt[];
}

export interface ProtocolAckCommandArgs {
  readonly runDir: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly kind: Extract<ReceiptKind, 'accepted' | 'rejected' | 'completed' | 'failed' | 'challenged'>;
  readonly json?: boolean;
}

export interface ProtocolAdapterFailureCommandArgs {
  readonly runDir: string;
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
  readonly assuranceContext?: ProtocolAssuranceContext;
  readonly json?: boolean;
}

export interface ProtocolAdapterRecoveryCommandArgs {
  readonly runDir: string;
  readonly adapterId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly adapterInstanceId?: string;
  readonly adapterVersion?: string;
  readonly recoveredByAgentId?: string;
  readonly verifierAgentId: string;
  readonly identityVerifierAgentId?: string;
  readonly verifierSelectionMethod?: VerifierSelectionMethod;
  readonly verifierPolicyRef?: string;
  readonly verifierTrustAnchorRef?: string;
  readonly verifierAttestationRefs?: readonly string[];
  readonly identityVerifierTrustAnchorRef?: string;
  readonly identityVerifierAttestationRefs?: readonly string[];
  readonly recoveryEvidenceRefs: readonly string[];
  readonly verificationEvidenceRefs?: readonly string[];
  readonly identityBindingRefs?: readonly string[];
  readonly identityBindingStatus?: IdentityBindingStatus;
  readonly transactionId?: string;
  readonly transactionStatus?: 'unstarted' | 'prepared' | 'committed' | 'aborted';
  readonly transactionPreparedAt?: string;
  readonly transactionCommittedAt?: string;
  readonly resolvesEvidenceIds?: readonly string[];
  readonly resolvesSubjectIds?: readonly string[];
  readonly note?: string;
  readonly assuranceContext?: ProtocolAssuranceContext;
  readonly json?: boolean;
}

export interface ProtocolInstrumentationMissingCommandArgs {
  readonly runDir: string;
  readonly observer: string;
  readonly expectedSignal: string;
  readonly reason: string;
  readonly assuranceContext?: ProtocolAssuranceContext;
  readonly json?: boolean;
}

export interface ProtocolConflictCommandArgs {
  readonly runDir: string;
  readonly conflictId: string;
  readonly title: string;
  readonly description: string;
  readonly severity?: BcrxSubjectFields['materiality'];
  readonly evidenceRefs?: readonly string[];
  readonly implementerAgentId?: string;
  readonly verifierAgentId?: string;
  readonly identityVerifierAgentId?: string;
  readonly verifierSelectionMethod?: VerifierSelectionMethod;
  readonly verifierPolicyRef?: string;
  readonly verifierTrustAnchorRef?: string;
  readonly verifierAttestationRefs?: readonly string[];
  readonly identityVerifierTrustAnchorRef?: string;
  readonly identityVerifierAttestationRefs?: readonly string[];
  readonly verificationEvidenceRefs?: readonly string[];
  readonly instrumentationRefs?: readonly string[];
  readonly identityBindingRefs?: readonly string[];
  readonly identityBindingStatus?: IdentityBindingStatus;
  readonly resolved?: boolean;
  readonly assuranceContext?: ProtocolAssuranceContext;
  readonly json?: boolean;
}

export interface ProtocolPromoteCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface ProtocolReplayCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export async function protocolDoctorCommand(
  args: ProtocolDoctorCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const sidecarReport = doctorProtocolSidecars({
    runDir: args.runDir,
    auditMode: args.auditMode ?? 'tip',
    profile: args.profile ?? 'alpha',
  });
  const busReport = doctorProtocol({
    messages: readBusEnvelopes(files.runDir),
    receipts: readLifecycleReceipts(files.runDir),
    profile: args.profile ?? 'alpha',
  });
  const busProjectionReport = auditBusProjections(files.runDir);
  const ok = sidecarReport.ok && busReport.ok && busProjectionReport.ok;
  const payload = {
    runDir: files.runDir,
    ok,
    auditMode: sidecarReport.auditMode,
    profile: sidecarReport.profile,
    messages: ledgerSummary(sidecarReport.ledgers.messages),
    receipts: ledgerSummary(sidecarReport.ledgers.receipts),
    evidence: ledgerSummary(sidecarReport.ledgers.evidence),
    rll: ledgerSummary(sidecarReport.ledgers.rll),
    agentops: ledgerSummary(sidecarReport.ledgers.agentops),
    rsiIndex: sidecarReport.rsiIndex,
    sidecars: sidecarReport,
    bus: {
      messages: readBusEnvelopes(files.runDir).length,
      receipts: readLifecycleReceipts(files.runDir).length,
      report: busReport,
      projections: busProjectionReport,
    },
  };
  writeOutput(payload, args.json === true);
  return ok ? 0 : 1;
}

export async function protocolPromoteCommand(
  args: ProtocolPromoteCommandArgs,
): Promise<number> {
  const decision = evaluateProductionPromotion({
    runDir: args.runDir,
  });
  writeOutput(decision, args.json === true);
  return decision.allowed ? 0 : 1;
}

export async function protocolReplayCommand(
  args: ProtocolReplayCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const busTransactions = readBusTransactions(files.runDir);
  const sidecarMessages = readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile);
  const sidecarReceipts = readLedgerEntries<ProtocolReceipt>(files.protocolReceiptsFile);
  const evidence = readLedgerEntries<EvidenceReceipt>(files.evidenceFile);
  const rll = readLedgerEntries<{ readonly eventId?: string; readonly kind?: string; readonly createdAt?: string; readonly summary?: string }>(files.rllFile);
  const timeline = [
    ...busTransactions.map((entry) => ({
      at: entry.createdAt,
      source: 'bus',
      type: `bus.${entry.type}`,
      id: entry.transactionId,
      messageId: entry.messageId,
      receipts: entry.receipts.map((receipt) => receipt.kind),
    })),
    ...sidecarMessages.map((entry) => ({
      at: entry.createdAt,
      source: 'protocol',
      type: `message.${entry.kind}`,
      id: entry.messageId,
      subjectId: entry.subject.subjectId,
      from: entry.from,
      to: entry.to,
      evidenceRefs: entry.evidenceRefs,
    })),
    ...sidecarReceipts.map((entry) => ({
      at: entry.issuedAt,
      source: 'protocol',
      type: `receipt.${entry.receiptType}`,
      id: entry.receiptId,
      subjectId: entry.subject.subjectId,
      messageId: entry.messageId ?? null,
      evidenceRefs: entry.evidenceRefs,
    })),
    ...evidence.map((entry) => ({
      at: entry.createdAt,
      source: 'evidence',
      type: `evidence.${entry.kind}`,
      id: entry.evidenceId,
      subjectId: entry.subject.subjectId,
      summary: entry.summary,
    })),
    ...rll.map((entry) => ({
      at: entry.createdAt ?? '',
      source: 'rll',
      type: `rll.${entry.kind ?? 'event'}`,
      id: entry.eventId ?? 'unknown',
      summary: entry.summary ?? '',
    })),
  ].sort((left, right) => compareReplayEntries(left.at, right.at, left.id, right.id));
  const payload = {
    runDir: files.runDir,
    counts: {
      busTransactions: busTransactions.length,
      sidecarMessages: sidecarMessages.length,
      sidecarReceipts: sidecarReceipts.length,
      evidence: evidence.length,
      rll: rll.length,
      timeline: timeline.length,
    },
    timeline,
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Protocol replay: ${files.runDir}\n`);
  for (const entry of timeline) {
    process.stdout.write(`${entry.at || 'unknown-time'} ${entry.type} ${entry.id}\n`);
  }
  return 0;
}

function ledgerSummary(summary: {
  readonly exists: boolean;
  readonly entriesTotal: number | null;
  readonly entriesChecked: number;
  readonly tipHash: string | null;
  readonly issues: readonly unknown[];
}): {
  readonly exists: boolean;
  readonly entriesTotal: number | null;
  readonly entriesChecked: number;
  readonly tipHash: string | null;
  readonly issueCount: number;
} {
  return {
    exists: summary.exists,
    entriesTotal: summary.entriesTotal,
    entriesChecked: summary.entriesChecked,
    tipHash: summary.tipHash,
    issueCount: summary.issues.length,
  };
}

function compareReplayEntries(
  leftAt: string,
  rightAt: string,
  leftId: string,
  rightId: string,
): number {
  const leftTime = Date.parse(leftAt);
  const rightTime = Date.parse(rightAt);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (!Number.isNaN(leftTime) && Number.isNaN(rightTime)) return -1;
  if (Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return 1;
  return leftId.localeCompare(rightId);
}

export async function protocolEmitCommand(
  args: ProtocolEmitCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const signer = configuredSidecarSigner();
  const subject = parseSubject(args.subject);
  const body = parseBody(args.body);
  const epistemics = args.epistemicStatus === undefined
    ? {
      status: 'uncertain' as const,
      uncertainty: 'CLI did not provide epistemic status',
    }
    : {
      status: args.epistemicStatus,
    };
  const message = signProtocolMessage(createProtocolMessage({
    kind: args.kind,
    from: args.from,
    to: args.to,
    subject,
    body,
    evidenceRefs: args.evidenceRefs ?? [],
    epistemics,
  }), signer);
  const messageAppend = appendLedgerEntry(
    files.protocolMessagesFile,
    message as unknown as Record<string, unknown>,
  );
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: args.kind === 'dissent' ? 'dissent_recorded' : 'message_recorded',
    subject,
    status: 'accepted',
    messageId: message.messageId,
    payload: message,
    evidenceRefs: args.evidenceRefs ?? [],
  }), signer);
  const receiptAppend = appendLedgerEntry(
    files.protocolReceiptsFile,
    receipt as unknown as Record<string, unknown>,
  );
  writeOutput({
    messageId: message.messageId,
    messageLineHash: messageAppend.lineHash,
    receiptId: receipt.receiptId,
    receiptLineHash: receiptAppend.lineHash,
  }, args.json === true);
  return 0;
}

export async function protocolSendCommand(args: ProtocolSendCommandArgs): Promise<number> {
  const result = sendBusMessage({
    runDir: args.runDir,
    from: parseAgentIdentity(args.from),
    to: args.to.map((agentId) => ({
      agentId,
      inboxUri: localJsonlInboxUri(agentId),
      required: true,
    })),
    intent: args.intent,
    body: parseMessageBody(args.body),
    ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(args.deadline !== undefined ? { deadline: args.deadline } : {}),
    ...(args.requiredReceipts !== undefined ? { requiredReceipts: args.requiredReceipts } : {}),
  });
  writeOutput({
    messageId: result.envelope.messageId,
    threadId: result.envelope.threadId,
    idempotencyKey: result.envelope.idempotencyKey,
    duplicate: result.duplicate,
    sentReceiptId: result.sentReceipt.receiptId,
    deliveredReceiptIds: result.deliveredReceipts.map((receipt) => receipt.receiptId),
    undeliverableReceiptIds: result.undeliverableReceipts.map((receipt) => receipt.receiptId),
    envelope: result.envelope,
  }, args.json === true);
  return 0;
}

export async function protocolInboxCommand(args: ProtocolInboxCommandArgs): Promise<number> {
  const result = readProtocolInboxView(args);
  writeOutput(result, args.json === true);
  return 0;
}

export function readProtocolInboxView(args: Omit<ProtocolInboxCommandArgs, 'json'>): ProtocolInboxView {
  const busInbox = readInbox({
    runDir: args.runDir,
    agentId: args.agentId,
    markRead: args.markRead === true,
  });
  const files = sidecarPathsForRunDir(args.runDir);
  const sidecarMessages = readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile)
    .filter((message) => message.to.includes(args.agentId) || message.to.includes('*'));
  const sidecarMessageIds = new Set(sidecarMessages.map((message) => message.messageId));
  const sidecarReceipts = readLedgerEntries<ProtocolReceipt>(files.protocolReceiptsFile)
    .filter((receipt) => receipt.messageId !== undefined && sidecarMessageIds.has(receipt.messageId));
  return {
    agentId: args.agentId,
    messages: busInbox.messages,
    readReceipts: busInbox.readReceipts,
    sidecarMessages,
    sidecarReceipts,
  };
}

export async function protocolAckCommand(args: ProtocolAckCommandArgs): Promise<number> {
  const result = ackBusMessage({
    runDir: args.runDir,
    agent: parseAgentIdentity(args.agentId),
    messageId: args.messageId,
    kind: args.kind,
  });
  writeOutput(result, args.json === true);
  return 0;
}

export async function protocolAdapterFailureCommand(
  args: ProtocolAdapterFailureCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const signer = configuredSidecarSigner();
  const subject = defaultSubject({
    subjectId: `adapter:${args.adapterId}`,
    subjectType: 'adapter',
    title: `${args.adapterId} adapter failure`,
    materiality: 'high',
    ...(args.assuranceContext !== undefined ? { assuranceContext: args.assuranceContext } : {}),
  });
  const failure: AdapterFailureInput = {
    adapterId: args.adapterId,
    providerId: args.providerId,
    ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.stderr !== undefined ? { stderr: args.stderr } : {}),
    ...(args.stdout !== undefined ? { stdout: args.stdout } : {}),
    error: args.error,
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    ...(args.timedOut !== undefined ? { timedOut: args.timedOut } : {}),
  };
  const evidence = signEvidenceReceipt(createAdapterFailureEvidence({
    subject,
    observedBy: 'harness.protocol.cli',
    failure,
  }), signer);
  appendEvidence(files.evidenceFile, evidence);
  const message = signProtocolMessage(createProtocolMessage({
    kind: 'adapter_failure',
    from: 'harness.protocol.cli',
    to: ['superharness.control'],
    subject,
    body: failure,
    epistemics: {
      status: 'observed',
      confidence: 1,
    },
    evidenceRefs: [evidence.evidenceId],
  }), signer);
  appendLedgerEntry(
    files.protocolMessagesFile,
    message as unknown as Record<string, unknown>,
  );
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: 'adapter_failure_recorded',
    subject,
    status: 'degraded',
    messageId: message.messageId,
    payload: { message, evidence },
    evidenceRefs: [evidence.evidenceId],
  }), signer);
  appendLedgerEntry(
    files.protocolReceiptsFile,
    receipt as unknown as Record<string, unknown>,
  );
  const rllEvent = createRllEvent({
    kind: 'failure',
    subject,
    source: 'harness.protocol.cli',
    summary: `${args.adapterId} adapter failed: ${args.error}`,
    outputRefs: [evidence.evidenceId, receipt.receiptId],
    metrics: {
      adapterFailure: 1,
      timedOut: args.timedOut === true ? 1 : 0,
    },
    confidence: 1,
  });
  appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
  writeOutput({
    evidenceId: evidence.evidenceId,
    messageId: message.messageId,
    receiptId: receipt.receiptId,
    rllEventId: rllEvent.eventId,
  }, args.json === true);
  return 0;
}

export async function protocolAdapterRecoveryCommand(
  args: ProtocolAdapterRecoveryCommandArgs,
): Promise<number> {
  if (args.recoveryEvidenceRefs.length === 0) {
    throw new Error('adapter recovery requires at least one recovery evidence ref');
  }
  const files = sidecarPathsForRunDir(args.runDir);
  const signer = configuredSidecarSigner();
  const recoveredBy = args.recoveredByAgentId ?? 'harness.protocol.cli';
  const verificationEvidenceRefs = args.verificationEvidenceRefs ?? args.recoveryEvidenceRefs;
  const identityBindingRefs = args.identityBindingRefs ?? [];
  const verifierAttestationRefs = args.verifierAttestationRefs ?? [];
  const identityVerifierAttestationRefs = args.identityVerifierAttestationRefs ?? [];
  const identityVerifierAgentId = args.identityVerifierAgentId ?? '';
  const adapterInstanceId = args.adapterInstanceId ?? '';
  const adapterVersion = args.adapterVersion ?? '';
  const verifierTrustAnchorRef = args.verifierTrustAnchorRef ?? '';
  const identityVerifierTrustAnchorRef = args.identityVerifierTrustAnchorRef ?? '';
  const identityBindingStatus = args.identityBindingStatus
    ?? deriveIdentityBindingStatus(identityBindingRefs);
  const resolvesEvidenceIds = args.resolvesEvidenceIds ?? [];
  const resolvesSubjectIds = args.resolvesSubjectIds ?? [`adapter:${args.adapterId}`];
  const recoveryBindingPayload = adapterRecoveryBindingPayload({
    adapterId: args.adapterId,
    providerId: args.providerId,
    modelId: args.modelId ?? null,
    adapterInstanceId,
    adapterVersion,
    recoveredBy,
    verifierAgentId: args.verifierAgentId,
    identityVerifierAgentId,
    verifierTrustAnchorRef,
    identityVerifierTrustAnchorRef,
    recoveryEvidenceRefs: args.recoveryEvidenceRefs,
    verificationEvidenceRefs,
    identityBindingRefs,
    resolvesEvidenceIds,
    resolvesSubjectIds,
  });
  const bindingPayloadHash = stableHash(recoveryBindingPayload);
  const transactionId = args.transactionId ?? stableId('verify_bind_tx', recoveryBindingPayload);
  const transactionStatus = args.transactionStatus ?? 'committed';
  const transactionPreparedAt = args.transactionPreparedAt ?? new Date().toISOString();
  const transactionCommittedAt = args.transactionCommittedAt ?? new Date().toISOString();
  const independentVerification = computeIndependentVerification({
    requestedResolved: true,
    implementerAgentId: recoveredBy,
    verifierAgentId: args.verifierAgentId,
    identityVerifierAgentId,
    verifierTrustAnchorRef,
    verifierAttestationRefs,
    identityVerifierTrustAnchorRef,
    identityVerifierAttestationRefs,
    verificationEvidenceRefs,
    identityBindingRefs,
    identityBindingStatus,
    transactionId,
    transactionStatus,
    bindingPayloadHash,
    ...(args.verifierSelectionMethod !== undefined ? { verifierSelectionMethod: args.verifierSelectionMethod } : {}),
    ...(args.verifierPolicyRef !== undefined ? { verifierPolicyRef: args.verifierPolicyRef } : {}),
  });
  const bindingReady = nonEmptyString(adapterInstanceId)
    && nonEmptyString(adapterVersion)
    && nonEmptyString(identityVerifierAgentId)
    && nonEmptyString(verifierTrustAnchorRef)
    && nonEmptyString(identityVerifierTrustAnchorRef)
    && verifierAttestationRefs.length > 0
    && identityVerifierAttestationRefs.length > 0
    && transactionStatus === 'committed'
    && nonEmptyString(transactionId)
    && resolvesEvidenceIds.length > 0;
  const productionReadyRecovery = independentVerification.satisfied
    && identityBindingStatus === 'cryptographically_verified'
    && bindingReady;
  const subject = defaultSubject({
    subjectId: `adapter:${args.adapterId}`,
    subjectType: 'adapter',
    title: `${args.adapterId} adapter recovery`,
    materiality: 'high',
    ...(args.assuranceContext !== undefined ? { assuranceContext: args.assuranceContext } : {}),
    implementerAgentId: recoveredBy,
    verifierAgentId: args.verifierAgentId,
    ...(args.verifierSelectionMethod !== undefined ? { verifierSelectionMethod: args.verifierSelectionMethod } : {}),
    ...(args.verifierPolicyRef !== undefined ? { verifierPolicyRef: args.verifierPolicyRef } : {}),
    ...(nonEmptyString(verifierTrustAnchorRef) ? { verifierTrustAnchorRef } : {}),
    ...(verifierAttestationRefs.length > 0 ? { verifierAttestationRefs } : {}),
    ...(nonEmptyString(identityVerifierAgentId) ? { identityVerifierAgentId } : {}),
    ...(nonEmptyString(identityVerifierTrustAnchorRef) ? { identityVerifierTrustAnchorRef } : {}),
    ...(identityVerifierAttestationRefs.length > 0 ? { identityVerifierAttestationRefs } : {}),
    identityBindingStatus,
    verificationStatus: independentVerification.satisfied
      ? 'independently_verified'
      : 'unverified',
    blocking: !productionReadyRecovery,
  });
  const recovery: AdapterRecoveryInput = {
    adapterId: args.adapterId,
    providerId: args.providerId,
    ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
    adapterInstanceId,
    adapterVersion,
    recoveredBy,
    verifierAgentId: args.verifierAgentId,
    identityVerifierAgentId,
    verifierTrustAnchorRef,
    verifierAttestationRefs,
    identityVerifierTrustAnchorRef,
    identityVerifierAttestationRefs,
    transactionId,
    transactionStatus,
    transactionPreparedAt,
    transactionCommittedAt,
    bindingPayloadHash,
    recoveredAt: new Date().toISOString(),
    recoveryEvidenceRefs: args.recoveryEvidenceRefs,
    verificationEvidenceRefs,
    identityBindingRefs,
    resolvesEvidenceIds,
    resolvesSubjectIds,
    ...(args.note !== undefined ? { note: args.note } : {}),
  };
  const unsignedEvidence = createAdapterRecoveryEvidence({
    subject,
    observedBy: 'harness.protocol.cli',
    recovery,
  });
  const recoveryEvidence = signEvidenceReceipt({
    ...unsignedEvidence,
    metadata: {
      ...unsignedEvidence.metadata,
      recovered: productionReadyRecovery,
      blocking: !productionReadyRecovery,
      independentVerificationSatisfied: independentVerification.satisfied,
      identityBindingStatus,
      identityBindingRefs,
      bindingPayloadHash,
      transactionId,
      transactionStatus,
      transactionPreparedAt,
      transactionCommittedAt,
      adapterInstanceId,
      adapterVersion,
      identityVerifierAgentId,
      verifierTrustAnchorRef,
      verifierAttestationRefs,
      identityVerifierTrustAnchorRef,
      identityVerifierAttestationRefs,
      verifierSelectionMethod: args.verifierSelectionMethod ?? null,
      verifierPolicyRef: args.verifierPolicyRef ?? null,
      bindingReady,
    },
  }, signer);
  appendEvidence(files.evidenceFile, recoveryEvidence);
  const message = signProtocolMessage(createProtocolMessage({
    kind: 'adapter_recovery',
    from: 'harness.protocol.cli',
    to: ['superharness.control'],
    subject,
    body: {
      ...recovery,
      recovered: productionReadyRecovery,
      independentVerification,
      identityBindingStatus,
      identityBindingRefs,
      bindingPayloadHash,
      transactionId,
      transactionStatus,
    },
    epistemics: {
      status: productionReadyRecovery ? 'observed' : 'uncertain',
      confidence: productionReadyRecovery ? 1 : 0.5,
      dissentRequired: !productionReadyRecovery,
    },
    evidenceRefs: uniqueRefs([
      recoveryEvidence.evidenceId,
      ...args.recoveryEvidenceRefs,
      ...verificationEvidenceRefs,
      ...identityBindingRefs,
    ]),
  }), signer);
  appendLedgerEntry(
    files.protocolMessagesFile,
    message as unknown as Record<string, unknown>,
  );
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: 'adapter_recovery_recorded',
    subject,
    status: productionReadyRecovery ? 'accepted' : 'degraded',
    messageId: message.messageId,
    payload: { message, evidence: recoveryEvidence },
    evidenceRefs: uniqueRefs([
      recoveryEvidence.evidenceId,
      ...args.recoveryEvidenceRefs,
      ...verificationEvidenceRefs,
      ...identityBindingRefs,
    ]),
    implementerAgentId: recoveredBy,
    verifierAgentId: args.verifierAgentId,
    independentVerification,
  }), signer);
  appendLedgerEntry(
    files.protocolReceiptsFile,
    receipt as unknown as Record<string, unknown>,
  );
  const rllEvent = createRllEvent({
    kind: 'correction',
    subject,
    source: 'harness.protocol.cli',
    summary: `${args.adapterId} adapter recovery recorded`,
    outputRefs: uniqueRefs([
      recoveryEvidence.evidenceId,
      receipt.receiptId,
      ...args.recoveryEvidenceRefs,
      ...verificationEvidenceRefs,
      ...identityBindingRefs,
    ]),
    metrics: {
      adapterRecovery: 1,
      recovered: productionReadyRecovery ? 1 : 0,
      independentVerification: independentVerification.satisfied ? 1 : 0,
      cryptographicIdentityBinding: identityBindingStatus === 'cryptographically_verified' ? 1 : 0,
      transactionCommitted: transactionStatus === 'committed' ? 1 : 0,
      bindingReady: bindingReady ? 1 : 0,
    },
    confidence: productionReadyRecovery ? 1 : 0.5,
  });
  appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
  writeOutput({
    evidenceId: recoveryEvidence.evidenceId,
    messageId: message.messageId,
    receiptId: receipt.receiptId,
    rllEventId: rllEvent.eventId,
    recovered: productionReadyRecovery,
    blocking: !productionReadyRecovery,
    independentVerification,
  }, args.json === true);
  return productionReadyRecovery ? 0 : 1;
}

export async function protocolInstrumentationMissingCommand(
  args: ProtocolInstrumentationMissingCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const signer = configuredSidecarSigner();
  const subject = defaultSubject({
    subjectId: `instrumentation:${args.observer}:${args.expectedSignal}`,
    subjectType: 'claim',
    title: `missing observer instrumentation for ${args.expectedSignal}`,
    materiality: 'critical',
    ...(args.assuranceContext !== undefined ? { assuranceContext: args.assuranceContext } : {}),
  });
  const evidence = signEvidenceReceipt(createEvidenceReceipt({
    kind: 'instrumentation_missing',
    subject,
    summary: `observer ${args.observer} does not prove ${args.expectedSignal}`,
    observedBy: 'harness.protocol.cli',
    content: {
      observer: args.observer,
      expectedSignal: args.expectedSignal,
      reason: args.reason,
    },
    uri: `observer:${args.observer}`,
    metadata: {
      observer: args.observer,
      expectedSignal: args.expectedSignal,
    },
  }), signer);
  appendEvidence(files.evidenceFile, evidence);
  const message = signProtocolMessage(createProtocolMessage({
    kind: 'agent_observation',
    from: 'harness.protocol.cli',
    to: ['superharness.control'],
    subject,
    body: {
      observer: args.observer,
      expectedSignal: args.expectedSignal,
      reason: args.reason,
      verdict: 'measure_first',
    },
    epistemics: {
      status: 'observed',
      confidence: 1,
    },
    evidenceRefs: [evidence.evidenceId],
  }), signer);
  appendLedgerEntry(
    files.protocolMessagesFile,
    message as unknown as Record<string, unknown>,
  );
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: 'instrumentation_missing',
    subject,
    status: 'degraded',
    messageId: message.messageId,
    payload: { message, evidence },
    evidenceRefs: [evidence.evidenceId],
  }), signer);
  appendLedgerEntry(
    files.protocolReceiptsFile,
    receipt as unknown as Record<string, unknown>,
  );
  const rllEvent = createRllEvent({
    kind: 'failure',
    subject,
    source: 'harness.protocol.cli',
    summary: `instrumentation missing for ${args.expectedSignal}: ${args.reason}`,
    outputRefs: [evidence.evidenceId, receipt.receiptId],
    metrics: {
      instrumentationMissing: 1,
    },
    confidence: 1,
  });
  appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
  writeOutput({
    evidenceId: evidence.evidenceId,
    messageId: message.messageId,
    receiptId: receipt.receiptId,
    rllEventId: rllEvent.eventId,
  }, args.json === true);
  return 0;
}

export async function protocolConflictCommand(
  args: ProtocolConflictCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const signer = configuredSidecarSigner();
  const implementerAgentId = args.implementerAgentId ?? 'harness.protocol.cli';
  const verificationEvidenceRefs = args.verificationEvidenceRefs ?? [];
  const instrumentationRefs = args.instrumentationRefs ?? [];
  const identityBindingRefs = args.identityBindingRefs ?? [];
  const verifierAttestationRefs = args.verifierAttestationRefs ?? [];
  const identityVerifierAttestationRefs = args.identityVerifierAttestationRefs ?? [];
  const identityVerifierAgentId = args.identityVerifierAgentId ?? '';
  const verifierTrustAnchorRef = args.verifierTrustAnchorRef ?? '';
  const identityVerifierTrustAnchorRef = args.identityVerifierTrustAnchorRef ?? '';
  const conflictBindingPayload = adapterRecoveryBindingPayload({
    adapterId: args.conflictId,
    providerId: 'implementation_conflict',
    modelId: null,
    adapterInstanceId: args.conflictId,
    adapterVersion: 'conflict-v2',
    recoveredBy: implementerAgentId,
    verifierAgentId: args.verifierAgentId ?? '',
    identityVerifierAgentId,
    verifierTrustAnchorRef,
    identityVerifierTrustAnchorRef,
    recoveryEvidenceRefs: args.evidenceRefs ?? [],
    verificationEvidenceRefs,
    identityBindingRefs,
    resolvesEvidenceIds: args.evidenceRefs ?? [],
    resolvesSubjectIds: [`conflict:${args.conflictId}`],
  });
  const identityBindingStatus = args.identityBindingStatus
    ?? deriveIdentityBindingStatus(identityBindingRefs);
  const requestedResolved = args.resolved === true;
  const independentVerification = computeIndependentVerification({
    requestedResolved,
    implementerAgentId,
    verificationEvidenceRefs,
    identityBindingRefs,
    identityBindingStatus,
    identityVerifierAgentId,
    verifierTrustAnchorRef,
    verifierAttestationRefs,
    identityVerifierTrustAnchorRef,
    identityVerifierAttestationRefs,
    transactionId: stableId('verify_bind_tx', conflictBindingPayload),
    transactionStatus: requestedResolved ? 'committed' : 'unstarted',
    bindingPayloadHash: stableHash(conflictBindingPayload),
    ...(args.verifierAgentId !== undefined ? { verifierAgentId: args.verifierAgentId } : {}),
    ...(args.verifierSelectionMethod !== undefined ? { verifierSelectionMethod: args.verifierSelectionMethod } : {}),
    ...(args.verifierPolicyRef !== undefined ? { verifierPolicyRef: args.verifierPolicyRef } : {}),
  });
  const resolved = requestedResolved && independentVerification.satisfied;
  const subject = defaultSubject({
    subjectId: `conflict:${args.conflictId}`,
    subjectType: 'claim',
    title: args.title,
    materiality: args.severity ?? 'high',
    ...(args.assuranceContext !== undefined ? { assuranceContext: args.assuranceContext } : {}),
    implementerAgentId,
    ...(args.verifierAgentId !== undefined ? { verifierAgentId: args.verifierAgentId } : {}),
    ...(args.verifierSelectionMethod !== undefined ? { verifierSelectionMethod: args.verifierSelectionMethod } : {}),
    ...(args.verifierPolicyRef !== undefined ? { verifierPolicyRef: args.verifierPolicyRef } : {}),
    ...(nonEmptyString(verifierTrustAnchorRef) ? { verifierTrustAnchorRef } : {}),
    ...(verifierAttestationRefs.length > 0 ? { verifierAttestationRefs } : {}),
    ...(nonEmptyString(identityVerifierAgentId) ? { identityVerifierAgentId } : {}),
    ...(nonEmptyString(identityVerifierTrustAnchorRef) ? { identityVerifierTrustAnchorRef } : {}),
    ...(identityVerifierAttestationRefs.length > 0 ? { identityVerifierAttestationRefs } : {}),
    identityBindingStatus,
    verificationStatus: independentVerification.satisfied
      ? 'independently_verified'
      : requestedResolved && args.verifierAgentId === implementerAgentId
        ? 'self_verified'
        : 'unverified',
    instrumentationRefs,
    blocking: !resolved,
  });
  const evidence = signEvidenceReceipt(createEvidenceReceipt({
    kind: 'implementation_conflict',
    subject,
    summary: args.title,
    observedBy: 'harness.protocol.cli',
    content: {
      conflictId: args.conflictId,
      title: args.title,
      description: args.description,
      requestedResolved,
      resolved,
      implementerAgentId,
      verifierAgentId: args.verifierAgentId ?? null,
      verifierSelectionMethod: args.verifierSelectionMethod ?? null,
      verifierPolicyRef: args.verifierPolicyRef ?? null,
      verifierTrustAnchorRef,
      verifierAttestationRefs,
      identityVerifierAgentId,
      identityVerifierTrustAnchorRef,
      identityVerifierAttestationRefs,
      identityBindingStatus,
      identityBindingRefs,
      alphaOnly: independentVerification.alphaOnly ?? false,
      independentVerification,
      instrumentationRefs,
      evidenceRefs: args.evidenceRefs ?? [],
      verificationEvidenceRefs,
    },
    uri: `conflict:${args.conflictId}`,
    metadata: {
      conflictId: args.conflictId,
      requestedResolved,
      resolved,
      blocking: !resolved,
      implementerAgentId,
      verifierAgentId: args.verifierAgentId ?? null,
      verifierSelectionMethod: args.verifierSelectionMethod ?? null,
      verifierPolicyRef: args.verifierPolicyRef ?? null,
      verifierTrustAnchorRef,
      verifierAttestationRefs,
      identityVerifierAgentId,
      identityVerifierTrustAnchorRef,
      identityVerifierAttestationRefs,
      identityBindingStatus,
      identityBindingRefs,
      transactionId: independentVerification.transactionId ?? null,
      transactionStatus: independentVerification.transactionStatus ?? null,
      bindingPayloadHash: independentVerification.bindingPayloadHash ?? null,
      alphaOnly: independentVerification.alphaOnly ?? false,
      independentVerificationSatisfied: independentVerification.satisfied,
      verificationEvidenceRefs,
      instrumentationRefs,
    },
  }), signer);
  appendEvidence(files.evidenceFile, evidence);
  const message = signProtocolMessage(createProtocolMessage({
    kind: 'conflict',
    from: 'harness.protocol.cli',
    to: ['superharness.control'],
    subject,
    body: {
      conflictId: args.conflictId,
      title: args.title,
      description: args.description,
      requestedResolved,
      resolved,
      blocking: !resolved,
      independentVerification,
      identityBindingStatus,
      instrumentationRefs,
    },
    epistemics: {
      status: 'observed',
      confidence: 1,
      dissentRequired: true,
    },
    evidenceRefs: [evidence.evidenceId, ...(args.evidenceRefs ?? [])],
  }), signer);
  appendLedgerEntry(
    files.protocolMessagesFile,
    message as unknown as Record<string, unknown>,
  );
  const receiptEvidenceRefs = uniqueRefs([
    evidence.evidenceId,
    ...(args.evidenceRefs ?? []),
    ...verificationEvidenceRefs,
    ...instrumentationRefs,
    ...identityBindingRefs,
  ]);
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: 'conflict_recorded',
    subject,
    status: resolved ? 'accepted' : 'degraded',
    messageId: message.messageId,
    payload: { message, evidence },
    evidenceRefs: receiptEvidenceRefs,
    implementerAgentId,
    ...(args.verifierAgentId !== undefined ? { verifierAgentId: args.verifierAgentId } : {}),
    independentVerification,
  }), signer);
  appendLedgerEntry(
    files.protocolReceiptsFile,
    receipt as unknown as Record<string, unknown>,
  );
  const rllEvent = createRllEvent({
    kind: 'conflict',
    subject,
    source: 'harness.protocol.cli',
    summary: args.title,
    outputRefs: [evidence.evidenceId, receipt.receiptId, ...(args.evidenceRefs ?? [])],
    metrics: {
      implementationConflict: 1,
      resolved: resolved ? 1 : 0,
      blocked: resolved ? 0 : 1,
      independentVerification: independentVerification.satisfied ? 1 : 0,
      identityBinding: identityBindingRefs.length > 0 ? 1 : 0,
      alphaOnly: independentVerification.alphaOnly === true ? 1 : 0,
    },
    confidence: 1,
  });
  appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
  writeOutput({
    evidenceId: evidence.evidenceId,
    messageId: message.messageId,
    receiptId: receipt.receiptId,
    rllEventId: rllEvent.eventId,
    resolved,
    blocking: !resolved,
    independentVerification,
    alphaOnly: independentVerification.alphaOnly ?? false,
  }, args.json === true);
  return 0;
}

function appendEvidence(file: string, evidence: EvidenceReceipt): void {
  appendLedgerEntry(file, evidence as unknown as Record<string, unknown>);
}

function configuredSidecarSigner(): SidecarSigner | undefined {
  return loadConfiguredSidecarSigner();
}

function parseSubject(raw: string | undefined): BcrxSubjectFields {
  if (raw === undefined) {
    return defaultSubject({
      subjectId: 'manual:protocol-cli',
      subjectType: 'claim',
      title: 'manual protocol message',
      materiality: 'medium',
    });
  }
  const parsed = JSON.parse(raw) as BcrxSubjectFields;
  return parsed;
}

function parseBody(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseMessageBody(raw: string | undefined): MessageBody {
  const body = parseBody(raw);
  if (typeof body === 'string') {
    return {
      contentType: 'text/plain',
      text: body,
    };
  }
  return {
    contentType: 'application/json',
    json: body,
  };
}

function parseAgentIdentity(agentId: string): AgentIdentity {
  const lower = agentId.toLowerCase();
  return {
    agentId,
    kind: lower.includes('codex')
      ? 'codex'
      : lower.includes('claude')
        ? 'claude'
        : lower.includes('spark')
          ? 'spark_agent'
          : lower.includes('human') || lower.includes('operator')
            ? 'human'
            : 'local_model',
  };
}

function defaultSubject(args: {
  readonly subjectId: string;
  readonly subjectType: BcrxSubjectFields['subjectType'];
  readonly title: string;
  readonly materiality: BcrxSubjectFields['materiality'];
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
  readonly verificationStatus?: BcrxSubjectFields['verificationStatus'];
  readonly instrumentationRefs?: readonly string[];
  readonly semanticDriftIndex?: number;
  readonly laneIntegrityScore?: number;
  readonly blocking?: boolean;
  readonly assuranceContext?: ProtocolAssuranceContext;
}): BcrxSubjectFields {
  return {
    subjectId: args.subjectId,
    subjectType: args.subjectType,
    title: args.title,
    assuranceContext: args.assuranceContext ?? 'alpha',
    privacyZone: 'WORKSPACE',
    materiality: args.materiality,
    ...(args.implementerAgentId !== undefined ? { implementerAgentId: args.implementerAgentId } : {}),
    ...(args.verifierAgentId !== undefined ? { verifierAgentId: args.verifierAgentId } : {}),
    ...(args.verifierSelectionMethod !== undefined ? { verifierSelectionMethod: args.verifierSelectionMethod } : {}),
    ...(args.verifierPolicyRef !== undefined ? { verifierPolicyRef: args.verifierPolicyRef } : {}),
    ...(args.verifierTrustAnchorRef !== undefined ? { verifierTrustAnchorRef: args.verifierTrustAnchorRef } : {}),
    ...(args.verifierAttestationRefs !== undefined ? { verifierAttestationRefs: args.verifierAttestationRefs } : {}),
    ...(args.identityVerifierAgentId !== undefined ? { identityVerifierAgentId: args.identityVerifierAgentId } : {}),
    ...(args.identityVerifierTrustAnchorRef !== undefined ? { identityVerifierTrustAnchorRef: args.identityVerifierTrustAnchorRef } : {}),
    ...(args.identityVerifierAttestationRefs !== undefined ? { identityVerifierAttestationRefs: args.identityVerifierAttestationRefs } : {}),
    ...(args.identityBindingStatus !== undefined ? { identityBindingStatus: args.identityBindingStatus } : {}),
    ...(args.verificationStatus !== undefined ? { verificationStatus: args.verificationStatus } : {}),
    ...(args.instrumentationRefs !== undefined ? { instrumentationRefs: args.instrumentationRefs } : {}),
    ...(args.semanticDriftIndex !== undefined ? { semanticDriftIndex: args.semanticDriftIndex } : {}),
    ...(args.laneIntegrityScore !== undefined ? { laneIntegrityScore: args.laneIntegrityScore } : {}),
    ...(args.blocking !== undefined ? { blocking: args.blocking } : {}),
    evidencePolicy: {
      required: true,
      minRefs: 1,
      acceptedKinds: [
        'adapter_failure',
        'adapter_recovery',
        'command_output',
        'implementation_conflict',
        'instrumentation_missing',
        'instrumentation_proof',
        'model_output',
      ],
    },
    dissentPolicy: {
      required: true,
      minDissenters: 1,
      scope: 'material_claims',
    },
  };
}

function computeIndependentVerification(args: {
  readonly requestedResolved: boolean;
  readonly implementerAgentId: string;
  readonly verifierAgentId?: string;
  readonly identityVerifierAgentId?: string;
  readonly verifierSelectionMethod?: VerifierSelectionMethod;
  readonly verifierPolicyRef?: string;
  readonly verifierTrustAnchorRef?: string;
  readonly verifierAttestationRefs?: readonly string[];
  readonly identityVerifierTrustAnchorRef?: string;
  readonly identityVerifierAttestationRefs?: readonly string[];
  readonly verificationEvidenceRefs: readonly string[];
  readonly identityBindingRefs: readonly string[];
  readonly identityBindingStatus: IdentityBindingStatus;
  readonly transactionId?: string;
  readonly transactionStatus?: 'unstarted' | 'prepared' | 'committed' | 'aborted';
  readonly bindingPayloadHash?: string;
}): NonNullable<ReturnType<typeof createProtocolReceipt>['independentVerification']> {
  const verifierProvided = args.verifierAgentId !== undefined && args.verifierAgentId.trim().length > 0;
  const distinctVerifier = verifierProvided && args.verifierAgentId !== args.implementerAgentId;
  const identityVerifierProvided = args.identityVerifierAgentId !== undefined && args.identityVerifierAgentId.trim().length > 0;
  const distinctIdentityVerifier = identityVerifierProvided
    && args.identityVerifierAgentId !== args.implementerAgentId
    && args.identityVerifierAgentId !== args.verifierAgentId;
  const hasEvidence = args.verificationEvidenceRefs.length > 0;
  const policySelected = args.verifierSelectionMethod !== undefined
    && args.verifierSelectionMethod !== 'manual_by_implementer'
    && args.verifierPolicyRef !== undefined
    && args.verifierPolicyRef.trim().length > 0;
  const identityBound = args.identityBindingRefs.length > 0 && args.identityBindingStatus !== 'unverified';
  const trustAnchored = nonEmptyString(args.verifierTrustAnchorRef)
    && nonEmptyString(args.identityVerifierTrustAnchorRef)
    && (args.verifierAttestationRefs?.length ?? 0) > 0
    && (args.identityVerifierAttestationRefs?.length ?? 0) > 0;
  const transactionBound = args.transactionStatus === 'committed'
    && nonEmptyString(args.transactionId)
    && nonEmptyString(args.bindingPayloadHash);
  const alphaOnly = args.identityBindingStatus !== 'cryptographically_verified';
  const satisfied = args.requestedResolved
    && distinctVerifier
    && distinctIdentityVerifier
    && hasEvidence
    && policySelected
    && identityBound
    && trustAnchored
    && transactionBound;
  const reason = satisfied
    ? 'resolved by independent verifier with trust-anchored identity binding and committed verify-bind transaction'
    : args.requestedResolved
      ? !verifierProvided
        ? 'resolved was requested without verifier identity'
        : !distinctVerifier
          ? 'resolved was requested by the implementer or same identity'
          : !distinctIdentityVerifier
            ? 'resolved was requested without a distinct identity-binding verifier'
          : !policySelected
            ? 'resolved was requested without policy-based verifier selection'
            : !identityBound
              ? 'resolved was requested without verifier identity-binding evidence'
              : !trustAnchored
                ? 'resolved was requested without verifier trust anchors and attestation refs'
                : !transactionBound
                  ? 'resolved was requested without a committed verify-bind transaction'
                  : 'resolved was requested without verification evidence'
      : 'conflict remains unresolved';
  return {
    required: args.requestedResolved,
    satisfied,
    implementerAgentId: args.implementerAgentId,
    ...(args.verifierAgentId !== undefined ? { verifierAgentId: args.verifierAgentId } : {}),
    ...(args.verifierSelectionMethod !== undefined ? { verifierSelectionMethod: args.verifierSelectionMethod } : {}),
    ...(args.verifierPolicyRef !== undefined ? { verifierPolicyRef: args.verifierPolicyRef } : {}),
    ...(args.verifierTrustAnchorRef !== undefined ? { verifierTrustAnchorRef: args.verifierTrustAnchorRef } : {}),
    ...(args.verifierAttestationRefs !== undefined ? { verifierAttestationRefs: args.verifierAttestationRefs } : {}),
    ...(args.identityVerifierAgentId !== undefined ? { identityVerifierAgentId: args.identityVerifierAgentId } : {}),
    ...(args.identityVerifierTrustAnchorRef !== undefined ? { identityVerifierTrustAnchorRef: args.identityVerifierTrustAnchorRef } : {}),
    ...(args.identityVerifierAttestationRefs !== undefined ? { identityVerifierAttestationRefs: args.identityVerifierAttestationRefs } : {}),
    identityBindingStatus: args.identityBindingStatus,
    identityBindingRefs: args.identityBindingRefs,
    ...(args.transactionId !== undefined ? { transactionId: args.transactionId } : {}),
    ...(args.transactionStatus !== undefined ? { transactionStatus: args.transactionStatus } : {}),
    ...(args.bindingPayloadHash !== undefined ? { bindingPayloadHash: args.bindingPayloadHash } : {}),
    alphaOnly,
    evidenceRefs: args.verificationEvidenceRefs,
    reason,
  };
}

function deriveIdentityBindingStatus(identityBindingRefs: readonly string[]): IdentityBindingStatus {
  return identityBindingRefs.length === 0 ? 'unverified' : 'evidence_bound';
}

function adapterRecoveryBindingPayload(args: {
  readonly adapterId: string;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly adapterInstanceId: string;
  readonly adapterVersion: string;
  readonly recoveredBy: string;
  readonly verifierAgentId: string;
  readonly identityVerifierAgentId: string;
  readonly verifierTrustAnchorRef: string;
  readonly identityVerifierTrustAnchorRef: string;
  readonly recoveryEvidenceRefs: readonly string[];
  readonly verificationEvidenceRefs: readonly string[];
  readonly identityBindingRefs: readonly string[];
  readonly resolvesEvidenceIds: readonly string[];
  readonly resolvesSubjectIds: readonly string[];
}): Record<string, unknown> {
  return {
    schemaVersion: 'superharness.adapter_recovery_binding.v2',
    adapterId: args.adapterId,
    providerId: args.providerId,
    modelId: args.modelId,
    adapterInstanceId: args.adapterInstanceId,
    adapterVersion: args.adapterVersion,
    recoveredBy: args.recoveredBy,
    verifierAgentId: args.verifierAgentId,
    identityVerifierAgentId: args.identityVerifierAgentId,
    verifierTrustAnchorRef: args.verifierTrustAnchorRef,
    identityVerifierTrustAnchorRef: args.identityVerifierTrustAnchorRef,
    recoveryEvidenceRefs: args.recoveryEvidenceRefs,
    verificationEvidenceRefs: args.verificationEvidenceRefs,
    identityBindingRefs: args.identityBindingRefs,
    resolvesEvidenceIds: args.resolvesEvidenceIds,
    resolvesSubjectIds: args.resolvesSubjectIds,
  };
}

function uniqueRefs(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function createManualEvidence(args: {
  readonly subject: BcrxSubjectFields;
  readonly summary: string;
  readonly content: unknown;
}): EvidenceReceipt {
  return createEvidenceReceipt({
    kind: 'human_assertion',
    subject: args.subject,
    summary: args.summary,
    observedBy: 'harness.protocol.cli',
    content: args.content,
  });
}
