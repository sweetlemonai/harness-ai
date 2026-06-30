import { existsSync, readFileSync } from 'node:fs';
import {
  ackBusMessage,
  ackBusMessageWithRead,
  localJsonlInboxUri,
  readBusTransactions,
  readLifecycleReceipts,
  sendBusMessage,
} from '../lib/collaboration/localJsonlBus.js';
import {
  createAdapterFailureEvidence,
  createEvidenceReceipt,
} from '../lib/evidence/ledger.js';
import { appendLedgerEntry, readLedgerEntries } from '../lib/protocol/ledger.js';
import {
  createProtocolMessage,
  createProtocolReceipt,
} from '../lib/protocol/messages.js';
import {
  loadConfiguredSidecarSigner,
  signEvidenceReceipt,
  signProtocolMessage,
  signProtocolReceipt,
  type SidecarSigner,
} from '../lib/proof/signing.js';
import { sidecarPathsForRunDir } from '../lib/protocol/sidecar.js';
import { stableId } from '../lib/protocol/hash.js';
import type {
  ProtocolAssuranceContext,
  ProtocolMessage,
  ProtocolReceipt,
} from '../lib/protocol/types.js';
import type { EvidenceReceipt } from '../lib/evidence/types.js';
import type { RllControlSignal, RllEvent, RsiCandidate } from '../lib/rll/types.js';
import {
  createRllControlSignal,
  createRllEvent,
} from '../lib/rll/ledger.js';
import type {
  AgentIdentity,
  MessageBody,
} from '../types.js';
import {
  readFleetConfig,
  resolveFleetMembers,
  secondsToMs,
  type FleetConfig,
  type FleetMemberConfig,
} from './fleet.js';

export interface AgentOpsPanelCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface AgentOpsReplayCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface AgentOpsGraphCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface AgentOpsExportCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface AgentOpsAdviseCommandArgs {
  readonly runDir: string;
  readonly prompt: string;
  readonly configPath?: string;
  readonly v1ModelsUrl?: string;
  readonly v1CatalogFile?: string;
  readonly consensusV1ModelsUrls?: readonly string[];
  readonly consensusV1CatalogFiles?: readonly string[];
  readonly minAgreeingSources?: number;
  readonly includeHosted?: boolean;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly minDissenters?: number;
  readonly assuranceContext?: ProtocolAssuranceContext;
  readonly idempotencyKey?: string;
  readonly json?: boolean;
}

interface AdvisoryFleetConfig extends FleetConfig {
  readonly advisory?: {
    readonly min_dissenters?: number;
  };
}

interface PanelModelResult {
  readonly agentId: string;
  readonly memberName: string;
  readonly model: string;
  readonly endpoint: string;
  readonly status: 'ok' | 'failed';
  readonly stance?: PanelStance;
  readonly evidenceId?: string;
  readonly messageId?: string;
  readonly receiptId?: string;
  readonly rllEventId?: string;
  readonly ackReceiptId?: string;
  readonly durationMs?: number;
  readonly contentPreview?: string;
  readonly parsed?: Record<string, unknown>;
  readonly error?: string;
}

type PanelStance = 'support' | 'dissent' | 'uncertain';

export async function agentopsPanelCommand(
  args: AgentOpsPanelCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const messages = readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile);
  const receipts = readLedgerEntries<ProtocolReceipt>(files.protocolReceiptsFile);
  const evidence = readLedgerEntries<EvidenceReceipt>(files.evidenceFile);
  const rllEvents = readLedgerEntries<RllEvent>(files.rllFile);
  const controlSignals = readLedgerEntries<RllControlSignal>(files.agentopsEventsFile);
  const rsiCandidates = readRsiCandidates(files.rsiIndexFile);
  const adapterFailures = evidence.filter((entry) => entry.kind === 'adapter_failure');
  const implementationConflicts = evidence.filter((entry) => entry.kind === 'implementation_conflict');
  const latestImplementationConflicts = latestConflictsById(implementationConflicts);
  const openImplementationConflicts = latestImplementationConflicts.filter(
    (entry) => !isIndependentlyClosedConflict(entry),
  );
  const alphaOnlyClosures = latestImplementationConflicts.filter(isAlphaOnlyClosedConflict);
  const openConflictIds = new Set(openImplementationConflicts.map(conflictIdForEvidence));
  const verdict = openImplementationConflicts.length > 0
    ? 'blocked'
    : alphaOnlyClosures.length > 0
      ? 'pass_alpha'
      : 'pass';
  const protocolDissent = messages.filter((entry) => entry.kind === 'dissent');
  const rllDissent = rllEvents.filter((entry) => entry.kind === 'dissent');
  const protocolConflicts = messages.filter((entry) => entry.kind === 'conflict');
  const rllConflicts = rllEvents.filter((entry) => entry.kind === 'conflict');
  const payload = {
    runDir: files.runDir,
    status: {
      verdict,
      reason: openImplementationConflicts.length > 0
        ? 'unresolved implementation_conflict events require independent verification'
        : alphaOnlyClosures.length > 0
          ? 'implementation_conflict events are closed for alpha with evidence-bound verifier identity; production requires cryptographic verifier binding'
          : 'no unresolved implementation_conflict events',
      blockingConflictIds: openImplementationConflicts.map(conflictIdForEvidence),
      alphaOnlyConflictIds: alphaOnlyClosures.map(conflictIdForEvidence),
    },
    counts: {
      messages: messages.length,
      receipts: receipts.length,
      evidence: evidence.length,
      adapterFailures: adapterFailures.length,
      conflicts: implementationConflicts.length + protocolConflicts.length + rllConflicts.length,
      dissent: protocolDissent.length + rllDissent.length,
      rllEvents: rllEvents.length,
      controlSignals: controlSignals.length,
      rsiCandidates: rsiCandidates.length,
    },
    latest: {
      message: last(messages),
      receipt: last(receipts),
      evidence: last(evidence),
      rllEvent: last(rllEvents),
      controlSignal: last(controlSignals),
      rsiCandidate: last(rsiCandidates),
    },
    openRisks: [
      ...adapterFailures.map((entry) => ({
        kind: 'adapter_failure',
        id: entry.evidenceId,
        summary: entry.summary,
        subjectId: entry.subject.subjectId,
      })),
      ...openImplementationConflicts.map((entry) => ({
        kind: 'conflict',
        id: entry.evidenceId,
        summary: entry.summary,
        subjectId: entry.subject.subjectId,
        blocking: true,
        resolved: Boolean(entry.metadata.resolved),
        independentVerificationSatisfied: Boolean(entry.metadata.independentVerificationSatisfied),
      })),
      ...protocolConflicts.filter((entry) => openConflictIds.has(conflictIdForSubject(entry.subject.subjectId))).map((entry) => ({
        kind: 'conflict',
        id: entry.messageId,
        summary: entry.subject.title,
        subjectId: entry.subject.subjectId,
      })),
      ...rllConflicts.filter((entry) => openConflictIds.has(conflictIdForSubject(entry.subject.subjectId))).map((entry) => ({
        kind: 'conflict',
        id: entry.eventId,
        summary: entry.summary,
        subjectId: entry.subject.subjectId,
      })),
      ...protocolDissent.map((entry) => ({
        kind: 'dissent',
        id: entry.messageId,
        summary: entry.subject.title,
        subjectId: entry.subject.subjectId,
      })),
      ...rllDissent.map((entry) => ({
        kind: 'dissent',
        id: entry.eventId,
        summary: entry.summary,
        subjectId: entry.subject.subjectId,
      })),
    ],
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`AgentOps panel: ${files.runDir}\n`);
  process.stdout.write(`status: ${payload.status.verdict}\n`);
  process.stdout.write(`reason: ${payload.status.reason}\n`);
  process.stdout.write(`messages: ${payload.counts.messages}\n`);
  process.stdout.write(`receipts: ${payload.counts.receipts}\n`);
  process.stdout.write(`evidence: ${payload.counts.evidence}\n`);
  process.stdout.write(`adapter failures: ${payload.counts.adapterFailures}\n`);
  process.stdout.write(`conflicts: ${payload.counts.conflicts}\n`);
  process.stdout.write(`dissent: ${payload.counts.dissent}\n`);
  process.stdout.write(`RLL events: ${payload.counts.rllEvents}\n`);
  process.stdout.write(`control signals: ${payload.counts.controlSignals}\n`);
  process.stdout.write(`RSI candidates: ${payload.counts.rsiCandidates}\n`);
  return 0;
}

export async function agentopsReplayCommand(
  args: AgentOpsReplayCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const sidecars = readAgentOpsSidecars(files);
  const timeline = [
    ...readBusTransactions(files.runDir).map((entry) => ({
      at: entry.createdAt,
      type: `bus.${entry.type}`,
      id: entry.transactionId,
      subject: entry.messageId,
      summary: `${entry.type} ${entry.receipts.map((receipt) => receipt.kind).join(',')}`,
    })),
    ...sidecars.messages.map((entry) => ({
      at: entry.createdAt,
      type: `message.${entry.kind}`,
      id: entry.messageId,
      subject: entry.subject.subjectId,
      summary: `${entry.from} -> ${entry.to.join(',')}`,
    })),
    ...sidecars.receipts.map((entry) => ({
      at: entry.issuedAt,
      type: `receipt.${entry.receiptType}`,
      id: entry.receiptId,
      subject: entry.subject.subjectId,
      summary: entry.status,
    })),
    ...sidecars.evidence.map((entry) => ({
      at: entry.createdAt,
      type: `evidence.${entry.kind}`,
      id: entry.evidenceId,
      subject: entry.subject.subjectId,
      summary: entry.summary,
    })),
    ...sidecars.rllEvents.map((entry) => ({
      at: entry.createdAt,
      type: `rll.${entry.kind}`,
      id: entry.eventId,
      subject: entry.subject.subjectId,
      summary: entry.summary,
    })),
    ...sidecars.controlSignals.map((entry) => ({
      at: entry.createdAt,
      type: `agentops.signal.${entry.action}`,
      id: entry.signalId,
      subject: entry.subject.subjectId,
      summary: entry.reason,
    })),
  ].sort((left, right) => compareTimeline(left.at, right.at, left.id, right.id));
  const payload = {
    runDir: files.runDir,
    timeline,
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`AgentOps replay: ${files.runDir}\n`);
  for (const entry of timeline) {
    process.stdout.write(`${entry.at} ${entry.type} ${entry.id} ${entry.summary}\n`);
  }
  return 0;
}

export async function agentopsGraphCommand(
  args: AgentOpsGraphCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const sidecars = readAgentOpsSidecars(files);
  const nodes = new Map<string, { readonly id: string; readonly kind: string; readonly label: string }>();
  const edges: Array<{ readonly from: string; readonly to: string; readonly kind: string }> = [];
  const addNode = (id: string, kind: string, label = id): void => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label });
  };
  const addEdge = (from: string, to: string, kind: string): void => {
    edges.push({ from, to, kind });
  };
  for (const message of sidecars.messages) {
    addNode(message.messageId, 'message', message.kind);
    addNode(message.from, 'agent');
    addEdge(message.from, message.messageId, 'sent');
    for (const recipient of message.to) {
      addNode(recipient, 'agent');
      addEdge(message.messageId, recipient, 'addressed_to');
    }
    addNode(message.subject.subjectId, message.subject.subjectType, message.subject.title);
    addEdge(message.messageId, message.subject.subjectId, 'about');
    for (const evidenceId of message.evidenceRefs) {
      addNode(evidenceId, 'evidence');
      addEdge(evidenceId, message.messageId, 'supports');
    }
  }
  for (const receipt of sidecars.receipts) {
    addNode(receipt.receiptId, 'receipt', receipt.receiptType);
    addNode(receipt.subject.subjectId, receipt.subject.subjectType, receipt.subject.title);
    addEdge(receipt.receiptId, receipt.subject.subjectId, 'attests');
    if (receipt.messageId !== undefined) addEdge(receipt.receiptId, receipt.messageId, 'receipt_for');
  }
  for (const evidence of sidecars.evidence) {
    addNode(evidence.evidenceId, 'evidence', evidence.kind);
    addNode(evidence.subject.subjectId, evidence.subject.subjectType, evidence.subject.title);
    addEdge(evidence.evidenceId, evidence.subject.subjectId, 'observes');
  }
  for (const event of sidecars.rllEvents) {
    addNode(event.eventId, 'rll_event', event.kind);
    addNode(event.subject.subjectId, event.subject.subjectType, event.subject.title);
    addEdge(event.eventId, event.subject.subjectId, 'learns_from');
    for (const ref of event.outputRefs) {
      addNode(ref, 'artifact_ref');
      addEdge(event.eventId, ref, 'emits');
    }
  }
  for (const signal of sidecars.controlSignals) {
    addNode(signal.signalId, 'control_signal', signal.action);
    addNode(signal.subject.subjectId, signal.subject.subjectType, signal.subject.title);
    addEdge(signal.signalId, signal.subject.subjectId, 'controls');
    for (const ref of signal.evidenceRefs) {
      addNode(ref, 'evidence');
      addEdge(ref, signal.signalId, 'supports');
    }
  }
  for (const candidate of sidecars.rsiCandidates) {
    addNode(candidate.candidateId, 'rsi_candidate', candidate.hypothesis);
    addNode(candidate.subject.subjectId, candidate.subject.subjectType, candidate.subject.title);
    addEdge(candidate.candidateId, candidate.subject.subjectId, 'proposes_for');
    for (const ref of candidate.requiredEvidenceRefs) {
      addNode(ref, 'evidence');
      addEdge(ref, candidate.candidateId, 'required_by');
    }
  }
  const payload = {
    runDir: files.runDir,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges,
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`AgentOps graph: ${payload.nodes.length} node(s), ${payload.edges.length} edge(s)\n`);
  return 0;
}

export async function agentopsExportCommand(
  args: AgentOpsExportCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const sidecars = readAgentOpsSidecars(files);
  const payload = {
    schemaVersion: 'superharness.agentops.export.v1',
    exportedAt: new Date().toISOString(),
    runDir: files.runDir,
    ledgers: {
      messages: sidecars.messages,
      receipts: sidecars.receipts,
      lifecycleReceipts: readLifecycleReceipts(files.runDir),
      evidence: sidecars.evidence,
      rllEvents: sidecars.rllEvents,
      controlSignals: sidecars.controlSignals,
      rsiCandidates: sidecars.rsiCandidates,
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 0;
}

export async function agentopsAdviseCommand(
  args: AgentOpsAdviseCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const signer = loadConfiguredSidecarSigner();
  if (args.assuranceContext === 'production') {
    ensureProductionSidecarSigner(signer);
  }
  const config = readFleetConfig(args.configPath) as AdvisoryFleetConfig;
  const timeoutMs = args.timeoutMs ?? secondsToMs(config.timeout_s ?? 30);
  const minDissenters = args.minDissenters
    ?? config.advisory?.min_dissenters
    ?? 1;
  const resolution = await resolveFleetMembers({
    config,
    ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
    ...(args.v1ModelsUrl !== undefined ? { v1ModelsUrl: args.v1ModelsUrl } : {}),
    ...(args.v1CatalogFile !== undefined ? { v1CatalogFile: args.v1CatalogFile } : {}),
    ...(args.consensusV1ModelsUrls !== undefined ? { consensusV1ModelsUrls: args.consensusV1ModelsUrls } : {}),
    ...(args.consensusV1CatalogFiles !== undefined ? { consensusV1CatalogFiles: args.consensusV1CatalogFiles } : {}),
    ...(args.minAgreeingSources !== undefined ? { minAgreeingSources: args.minAgreeingSources } : {}),
    ...(args.includeHosted !== undefined ? { includeHosted: args.includeHosted } : {}),
    requireV1Inventory: args.assuranceContext === 'production',
    timeoutMs,
  });
  if (args.assuranceContext === 'production' && !resolution.v1Consensus.ok) {
    throw new Error('production AgentOps advisory requires V1 consensus to pass');
  }
  const subject = defaultPanelSubject({
    prompt: args.prompt,
    minDissenters,
    assuranceContext: args.assuranceContext ?? 'alpha',
  });
  const busSend = sendBusMessage({
    runDir: files.runDir,
    from: {
      agentId: 'superharness.agentops',
      kind: 'system',
      displayName: 'Super Harness AgentOps',
    },
    to: resolution.members.map((member) => ({
      agentId: agentIdForMember(member),
      inboxUri: localJsonlInboxUri(agentIdForMember(member)),
      required: true,
    })),
    intent: 'review.request',
    body: advisoryRequestBody(args.prompt, minDissenters),
    requiredReceipts: ['delivered', 'accepted', 'completed'],
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
  });
  const results = await Promise.all(resolution.members.map((member) => invokePanelMember({
    runDir: files.runDir,
    member,
    config,
    signer,
    subject,
    prompt: args.prompt,
    timeoutMs,
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    requestMessageId: busSend.envelope.messageId,
  })));
  const dissentCount = results.filter((entry) => entry.status === 'ok' && entry.stance === 'dissent').length;
  const failureCount = results.filter((entry) => entry.status === 'failed').length;
  const successCount = results.filter((entry) => entry.status === 'ok').length;
  const verdict = failureCount > 0
    ? 'blocked_adapter_failure'
    : successCount === 0
      ? 'blocked_no_responses'
      : dissentCount < minDissenters
        ? 'blocked_insufficient_dissent'
        : 'survives';
  const signal = createRllControlSignal({
    action: verdict === 'survives' ? 'gather_more_evidence' : 'request_dissent',
    subject,
    reason: verdict === 'survives'
      ? 'advisory panel produced the configured dissent floor; retain evidence pressure during implementation'
      : `advisory panel verdict ${verdict}`,
    strength: verdict === 'survives' ? 0.35 : 0.9,
    sourceEventIds: results
      .map((entry) => entry.rllEventId)
      .filter((entry): entry is string => entry !== undefined),
    evidenceRefs: results
      .map((entry) => entry.evidenceId)
      .filter((entry): entry is string => entry !== undefined),
  });
  appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);
  const payload = {
    runDir: files.runDir,
    ok: verdict === 'survives',
    verdict,
    policy: {
      activeRosterAuthority: resolution.modelSource.kind === 'config_panel'
        ? 'legacy_config_panel'
        : 'v1_models_inventory',
      configRole: 'policy_overlay_not_inventory',
      localModelBudgets: 'latency_urgency_guardrails_not_token_spend_caps',
      minDissenters,
    },
    modelSource: resolution.modelSource,
    request: {
      messageId: busSend.envelope.messageId,
      threadId: busSend.envelope.threadId,
      duplicate: busSend.duplicate,
    },
    counts: {
      v1Models: resolution.v1ModelCount,
      activeMembers: resolution.members.length,
      successes: successCount,
      failures: failureCount,
      dissent: dissentCount,
      skippedNoUpstream: resolution.skippedNoUpstream,
      skippedDisabled: resolution.skippedDisabled,
      configuredAbsentFromV1: resolution.configuredAbsentFromV1.filter((entry) => !entry.disabled).length,
    },
    controlSignal: signal,
    results,
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload.ok ? 0 : 1;
  }
  process.stdout.write(`AgentOps advise: ${verdict}\n`);
  process.stdout.write(`request: ${busSend.envelope.messageId}\n`);
  process.stdout.write(`active members: ${resolution.members.length}\n`);
  process.stdout.write(`responses: ${successCount}\n`);
  process.stdout.write(`failures: ${failureCount}\n`);
  process.stdout.write(`dissent: ${dissentCount}/${minDissenters}\n`);
  process.stdout.write(`control signal: ${signal.signalId}\n`);
  return payload.ok ? 0 : 1;
}

function ensureProductionSidecarSigner(
  signer: SidecarSigner | undefined,
): asserts signer is SidecarSigner {
  if (signer === undefined) {
    throw new Error('production AgentOps advisory requires a configured sidecar signer');
  }
  if (signer.trustLevel !== 'operator_bound' && signer.trustLevel !== 'registry_verified') {
    throw new Error('production AgentOps advisory requires operator_bound or registry_verified signing');
  }
  if (signer.keyId === undefined || signer.keyId.trim() === '') {
    throw new Error('production AgentOps advisory signer must expose keyId');
  }
  if (signer.expiresAt === undefined || Number.isNaN(Date.parse(signer.expiresAt))) {
    throw new Error('production AgentOps advisory signer must expose a valid expiresAt');
  }
  if (Date.parse(signer.expiresAt) <= Date.now()) {
    throw new Error(`production AgentOps advisory signer key is expired: ${signer.keyId}`);
  }
  if (signer.revocationListRef === undefined || signer.revocationListRef.trim() === '') {
    throw new Error('production AgentOps advisory signer must expose revocationListRef');
  }
}

async function invokePanelMember(args: {
  readonly runDir: string;
  readonly member: FleetMemberConfig;
  readonly config: AdvisoryFleetConfig;
  readonly signer: SidecarSigner | undefined;
  readonly subject: ReturnType<typeof defaultPanelSubject>;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  readonly requestMessageId: string;
}): Promise<PanelModelResult> {
  const agent = agentIdentityForMember(args.member);
  const startedAt = Date.now();
  let selectedMember = args.member;
  try {
    const modelValidation = await validateMemberModelPresent(args.member, args.timeoutMs);
    if (!modelValidation.ok) {
      return recordPanelFailure({
        runDir: args.runDir,
        member: args.member,
        agent,
        signer: args.signer,
        subject: args.subject,
        requestMessageId: args.requestMessageId,
        error: modelValidation.error,
        durationMs: Date.now() - startedAt,
      });
    }
    selectedMember = {
      ...args.member,
      model: modelValidation.model,
    };
    const response = await callOpenAiCompatibleMember({
      member: selectedMember,
      config: args.config,
      prompt: args.prompt,
      minDissenters: args.subject.dissentPolicy?.minDissenters ?? 1,
      timeoutMs: args.timeoutMs,
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    });
    if (response.content.trim().length === 0) {
      return recordPanelFailure({
        runDir: args.runDir,
        member: selectedMember,
        agent,
        signer: args.signer,
        subject: args.subject,
        requestMessageId: args.requestMessageId,
        error: response.reasoningPresent
          ? 'model returned reasoning but no assistant content'
          : 'model returned empty assistant content',
        durationMs: Date.now() - startedAt,
      });
    }
    const parsed = parseAdvisoryContent(response.content);
    const stance = parsed.stance;
    const files = sidecarPathsForRunDir(args.runDir);
    const evidence = signEvidenceReceipt(createEvidenceReceipt({
      kind: 'model_output',
      subject: args.subject,
        summary: `${selectedMember.name} advisory response (${stance})`,
        observedBy: 'harness.agentops.advise',
        uri: `model:${selectedMember.v1ModelId ?? selectedMember.model}`,
      content: {
        prompt: args.prompt,
        response: response.content,
        parsed: parsed.value,
        reasoningPresent: response.reasoningPresent,
        ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
        ...(response.usage !== undefined ? { usage: response.usage } : {}),
      },
      metadata: {
        agentId: agent.agentId,
        modelId: selectedMember.v1ModelId ?? selectedMember.model,
        endpoint: selectedMember.endpoint,
        stance,
        durationMs: Date.now() - startedAt,
      },
    }), args.signer);
    const appendedEvidence = appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>)
      .entry as unknown as EvidenceReceipt;
    const message = signProtocolMessage(createProtocolMessage({
      kind: stance === 'dissent' ? 'dissent' : 'agent_proposal',
      from: agent.agentId,
      to: ['superharness.agentops'],
      subject: args.subject,
      body: {
        stance,
        content: response.content,
        parsed: parsed.value,
      },
      epistemics: {
        status: 'observed',
        confidence: parsed.confidence,
        dissentRequired: args.subject.dissentPolicy?.required,
      },
      evidenceRefs: [appendedEvidence.evidenceId],
      causalityRefs: [args.requestMessageId],
    }), args.signer);
    const appendedMessage = appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>)
      .entry as unknown as ProtocolMessage;
    const receipt = signProtocolReceipt(createProtocolReceipt({
      receiptType: stance === 'dissent' ? 'dissent_recorded' : 'message_recorded',
      subject: args.subject,
      status: 'accepted',
      messageId: appendedMessage.messageId,
      payload: appendedMessage,
      evidenceRefs: [appendedEvidence.evidenceId],
    }), args.signer);
    const appendedReceipt = appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>)
      .entry as unknown as ProtocolReceipt;
    const rllEvent = createRllEvent({
      kind: stance === 'dissent' ? 'dissent' : 'observation',
      subject: args.subject,
      source: agent.agentId,
      summary: stance === 'dissent'
        ? `${selectedMember.name} raised dissent during advisory panel`
        : `${selectedMember.name} returned advisory stance ${stance}`,
      inputRefs: [args.requestMessageId],
      outputRefs: [
        appendedEvidence.evidenceId,
        appendedMessage.messageId,
        appendedReceipt.receiptId,
      ],
      metrics: {
        durationMs: Date.now() - startedAt,
        dissent: stance === 'dissent' ? 1 : 0,
      },
      confidence: parsed.confidence,
    });
    const appendedRll = appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>)
      .entry as unknown as RllEvent;
    ackBusMessageWithRead({
      runDir: args.runDir,
      agent,
      messageId: args.requestMessageId,
      kind: 'accepted',
    });
    const completed = ackBusMessage({
      runDir: args.runDir,
      agent,
      messageId: args.requestMessageId,
      kind: 'completed',
    });
    return {
      agentId: agent.agentId,
      memberName: selectedMember.name,
      model: selectedMember.model,
      endpoint: selectedMember.endpoint,
      status: 'ok',
      stance,
      evidenceId: appendedEvidence.evidenceId,
      messageId: appendedMessage.messageId,
      receiptId: appendedReceipt.receiptId,
      rllEventId: appendedRll.eventId,
      ackReceiptId: completed.receipt.receiptId,
      durationMs: Date.now() - startedAt,
      contentPreview: preview(response.content),
      parsed: parsed.value,
    };
  } catch (err) {
    return recordPanelFailure({
      runDir: args.runDir,
      member: selectedMember,
      agent,
      signer: args.signer,
      subject: args.subject,
      requestMessageId: args.requestMessageId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

async function callOpenAiCompatibleMember(args: {
  readonly member: FleetMemberConfig;
  readonly config: AdvisoryFleetConfig;
  readonly prompt: string;
  readonly minDissenters: number;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
}): Promise<{
  readonly content: string;
  readonly raw: string;
  readonly reasoningPresent: boolean;
  readonly finishReason?: string;
  readonly usage?: unknown;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  timer.unref();
  try {
    const response = await fetch(chatEndpointFor(args.member.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: args.member.model,
        messages: [
          {
            role: 'system',
            content: advisorySystemPrompt(args.minDissenters),
          },
          {
            role: 'user',
            content: args.prompt,
          },
        ],
        stream: false,
        ...((args.maxTokens ?? args.member.max_tokens ?? args.config.max_tokens) !== undefined
          ? { max_tokens: args.maxTokens ?? args.member.max_tokens ?? args.config.max_tokens }
          : {}),
        ...((args.member.temperature ?? args.config.temperature) !== undefined
          ? { temperature: args.member.temperature ?? args.config.temperature }
          : {}),
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`chat completion failed with HTTP ${response.status}`);
    }
    return extractChatContent(raw);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`chat completion timed out after ${args.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function validateMemberModelPresent(
  member: FleetMemberConfig,
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly model: string }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const parsed = await fetchJsonWithTimeout(modelsEndpointFor(member.endpoint), timeoutMs);
    const available = modelIdsFromResponse(parsed);
    const selected = member.modelCandidates.find((candidate) => available.has(candidate));
    if (selected !== undefined) return { ok: true, model: selected };
    return {
      ok: false,
      error: `upstream /v1/models does not advertise configured model candidates for ${member.name}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `upstream /v1/models validation failed for ${member.name}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function modelIdsFromResponse(response: unknown): Set<string> {
  const records = response as {
    readonly data?: readonly unknown[];
    readonly models?: readonly unknown[];
  };
  const values = [...(records.data ?? []), ...(records.models ?? [])];
  const ids = new Set<string>();
  for (const value of values) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as {
      readonly id?: unknown;
      readonly model?: unknown;
      readonly name?: unknown;
      readonly aliases?: readonly unknown[];
    };
    for (const candidate of [record.id, record.model, record.name]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        ids.add(candidate);
      }
    }
    for (const alias of record.aliases ?? []) {
      if (typeof alias === 'string' && alias.trim().length > 0) {
        ids.add(alias);
      }
    }
  }
  return ids;
}

function recordPanelFailure(args: {
  readonly runDir: string;
  readonly member: FleetMemberConfig;
  readonly agent: AgentIdentity;
  readonly signer: SidecarSigner | undefined;
  readonly subject: ReturnType<typeof defaultPanelSubject>;
  readonly requestMessageId: string;
  readonly error: string;
  readonly durationMs: number;
  readonly stdout?: string;
  readonly stderr?: string;
}): PanelModelResult {
  const files = sidecarPathsForRunDir(args.runDir);
  const failureSubject = {
    ...args.subject,
    subjectId: `adapter:agentops:${args.agent.agentId}:${args.requestMessageId}`,
    subjectType: 'adapter' as const,
    title: `${args.member.name} advisory adapter failure`,
    ownerAgentId: args.agent.agentId,
    materiality: 'high' as const,
    parentSubjectId: args.subject.subjectId,
  };
  const evidence = signEvidenceReceipt(createAdapterFailureEvidence({
    subject: failureSubject,
    observedBy: 'harness.agentops.advise',
    failure: {
      adapterId: `openai-compatible:${args.member.endpoint}`,
      providerId: 'openai-compatible',
      modelId: args.member.v1ModelId ?? args.member.model,
      error: args.error,
      durationMs: args.durationMs,
      ...(args.stdout !== undefined ? { stdout: args.stdout } : {}),
      ...(args.stderr !== undefined ? { stderr: args.stderr } : {}),
      timedOut: args.error.toLowerCase().includes('timed out'),
    },
  }), args.signer);
  const appendedEvidence = appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>)
    .entry as unknown as EvidenceReceipt;
  const message = signProtocolMessage(createProtocolMessage({
    kind: 'adapter_failure',
    from: 'harness.agentops.advise',
    to: ['superharness.control', args.agent.agentId],
    subject: failureSubject,
    body: {
      agentId: args.agent.agentId,
      endpoint: args.member.endpoint,
      model: args.member.model,
      error: args.error,
    },
    epistemics: {
      status: 'observed',
      confidence: 1,
    },
    evidenceRefs: [appendedEvidence.evidenceId],
    causalityRefs: [args.requestMessageId],
  }), args.signer);
  const appendedMessage = appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>)
    .entry as unknown as ProtocolMessage;
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: 'adapter_failure_recorded',
    subject: failureSubject,
    status: 'degraded',
    messageId: appendedMessage.messageId,
    payload: appendedMessage,
    evidenceRefs: [appendedEvidence.evidenceId],
  }), args.signer);
  const appendedReceipt = appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>)
    .entry as unknown as ProtocolReceipt;
  const rllEvent = createRllEvent({
    kind: 'failure',
    subject: failureSubject,
    source: 'harness.agentops.advise',
    summary: `${args.member.name} advisory adapter failed: ${args.error}`,
    inputRefs: [args.requestMessageId],
    outputRefs: [
      appendedEvidence.evidenceId,
      appendedMessage.messageId,
      appendedReceipt.receiptId,
    ],
    metrics: {
      adapterFailure: 1,
      durationMs: args.durationMs,
    },
    confidence: 1,
  });
  const appendedRll = appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>)
    .entry as unknown as RllEvent;
  const failed = ackBusMessageWithRead({
    runDir: args.runDir,
    agent: args.agent,
    messageId: args.requestMessageId,
    kind: 'failed',
  });
  return {
    agentId: args.agent.agentId,
    memberName: args.member.name,
    model: args.member.model,
    endpoint: args.member.endpoint,
    status: 'failed',
    evidenceId: appendedEvidence.evidenceId,
    messageId: appendedMessage.messageId,
    receiptId: appendedReceipt.receiptId,
    rllEventId: appendedRll.eventId,
    ackReceiptId: failed.receipt.receiptId,
    durationMs: args.durationMs,
    error: args.error,
  };
}

function extractChatContent(raw: string): {
  readonly content: string;
  readonly raw: string;
  readonly reasoningPresent: boolean;
  readonly finishReason?: string;
  readonly usage?: unknown;
} {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{
      finish_reason?: unknown;
      message?: {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
      };
    }>;
    usage?: unknown;
  };
  const first = parsed.choices?.[0];
  const content = first?.message?.content;
  const reasoningPresent = first?.message?.reasoning !== undefined
    || first?.message?.reasoning_content !== undefined;
  const finishReason = typeof first?.finish_reason === 'string'
    ? first.finish_reason
    : undefined;
  if (typeof content === 'string') {
    return {
      content,
      raw,
      reasoningPresent,
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
    };
  }
  if (Array.isArray(content)) {
    const text = content.map((part) => {
      if (part !== null && typeof part === 'object' && 'text' in part) {
        const value = (part as { readonly text?: unknown }).text;
        return typeof value === 'string' ? value : '';
      }
      return '';
    }).join('');
    return {
      content: text,
      raw,
      reasoningPresent,
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
    };
  }
  return {
    content: '',
    raw,
    reasoningPresent,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
  };
}

function parseAdvisoryContent(content: string): {
  readonly stance: PanelStance;
  readonly confidence: number;
  readonly value: Record<string, unknown>;
} {
  const parsed = parseJsonObject(content);
  if (parsed !== null) {
    const explicitStance = parseStance(parsed.stance) ?? 'uncertain';
    const stance = explicitStance === 'dissent' && !isEvidenceBoundDissent(parsed)
      ? 'uncertain'
      : explicitStance;
    return {
      stance,
      confidence: confidenceFrom(parsed.confidence),
      value: stance === explicitStance
        ? parsed
        : {
          ...parsed,
          contractStatus: 'dissent_missing_required_fields',
        },
    };
  }
  return {
    stance: 'uncertain',
    confidence: 0.4,
    value: {
      text: content,
      parseStatus: 'unstructured',
    },
  };
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    fencedJson(trimmed),
    braceJson(trimmed),
  ].filter((entry): entry is string => entry !== null);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function fencedJson(content: string): string | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  return match?.[1]?.trim() ?? null;
}

function braceJson(content: string): string | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return content.slice(start, end + 1);
}

function parseStance(value: unknown): PanelStance | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'support' || normalized === 'supports' || normalized === 'survives') return 'support';
  if (normalized === 'dissent' || normalized === 'challenge' || normalized === 'blocks') return 'dissent';
  if (normalized === 'uncertain' || normalized === 'mixed') return 'uncertain';
  return null;
}

function isEvidenceBoundDissent(value: Record<string, unknown>): boolean {
  return nonEmptyStringArray(value.strongest_weaknesses)
    && nonEmptyStringArray(value.recommended_repairs)
    && nonEmptyStringArray(value.evidence_needed)
    && typeof value.residual_risk === 'string'
    && value.residual_risk.trim().length > 0;
}

function nonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value)
    && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function confidenceFrom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.7;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function advisoryRequestBody(prompt: string, minDissenters: number): MessageBody {
  return {
    contentType: 'application/json',
    json: {
      requestType: 'agentops.advisory_panel.v1',
      prompt,
      requirements: {
        evidenceBounded: true,
        adversarialReview: true,
        minDissenters,
      },
    },
  };
}

function advisorySystemPrompt(minDissenters: number): string {
  return [
    'You are an evidence-bounded advisory member for Super Harness v2.',
    'Review the operator request for material weaknesses, implementation risks, missing evidence, protocol conflicts, and repair suggestions.',
    'Reason as deeply as needed, but put the final answer in assistant content.',
    'Return JSON only with keys: stance, strongest_weaknesses, recommended_repairs, evidence_needed, residual_risk, confidence.',
    'Use stance "dissent" if any material weakness should block or materially change the plan, "support" if it survives, or "uncertain" if evidence is insufficient.',
    `The panel is configured to require at least ${minDissenters} dissenting response(s) before treating anti-groupthink as satisfied.`,
  ].join('\n');
}

function defaultPanelSubject(args: {
  readonly prompt: string;
  readonly minDissenters: number;
  readonly assuranceContext: ProtocolAssuranceContext;
}) {
  return {
    subjectId: stableId('agentops_panel', {
      prompt: args.prompt,
      minDissenters: args.minDissenters,
    }),
    subjectType: 'task' as const,
    title: 'AgentOps advisory panel',
    assuranceContext: args.assuranceContext,
    privacyZone: 'WORKSPACE' as const,
    materiality: 'high' as const,
    evidencePolicy: {
      required: true,
      minRefs: 1,
      acceptedKinds: ['model_output', 'adapter_failure', 'command_output'],
    },
    dissentPolicy: {
      required: true,
      minDissenters: args.minDissenters,
      scope: 'material_claims' as const,
    },
  };
}

function agentIdentityForMember(member: FleetMemberConfig): AgentIdentity {
  const agentId = agentIdForMember(member);
  return {
    agentId,
    kind: agentKindFor(agentId, member),
    displayName: member.name,
    ...(member.nodeId !== undefined ? { nodeId: member.nodeId } : {}),
  };
}

function agentIdForMember(member: FleetMemberConfig): string {
  return `model:${member.v1ModelId ?? member.nodeId ?? member.name}`;
}

function agentKindFor(agentId: string, member: FleetMemberConfig): AgentIdentity['kind'] {
  const haystack = `${agentId} ${member.name} ${member.model} ${member.inventorySource ?? ''}`.toLowerCase();
  if (haystack.includes('claude')) return 'claude';
  if (haystack.includes('codex')) return 'codex';
  if (haystack.includes('spark')) return 'spark_agent';
  return 'local_model';
}

function chatEndpointFor(endpoint: string): string {
  const root = endpoint
    .replace(/\/+$/, '')
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/v1\/models\/?$/, '')
    .replace(/\/models\/?$/, '')
    .replace(/\/v1\/?$/, '');
  return `${root}/v1/chat/completions`;
}

function modelsEndpointFor(endpoint: string): string {
  const root = endpoint
    .replace(/\/+$/, '')
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/v1\/models\/?$/, '')
    .replace(/\/models\/?$/, '')
    .replace(/\/v1\/?$/, '');
  return `${root}/v1/models`;
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function last<T>(values: readonly T[]): T | null {
  return values.length === 0 ? null : values[values.length - 1] ?? null;
}

function readAgentOpsSidecars(files: ReturnType<typeof sidecarPathsForRunDir>): {
  readonly messages: readonly ProtocolMessage[];
  readonly receipts: readonly ProtocolReceipt[];
  readonly evidence: readonly EvidenceReceipt[];
  readonly rllEvents: readonly RllEvent[];
  readonly controlSignals: readonly RllControlSignal[];
  readonly rsiCandidates: readonly RsiCandidate[];
} {
  return {
    messages: readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile),
    receipts: readLedgerEntries<ProtocolReceipt>(files.protocolReceiptsFile),
    evidence: readLedgerEntries<EvidenceReceipt>(files.evidenceFile),
    rllEvents: readLedgerEntries<RllEvent>(files.rllFile),
    controlSignals: readLedgerEntries<RllControlSignal>(files.agentopsEventsFile),
    rsiCandidates: readRsiCandidates(files.rsiIndexFile),
  };
}

function compareTimeline(
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

function latestConflictsById(entries: readonly EvidenceReceipt[]): EvidenceReceipt[] {
  const byId = new Map<string, EvidenceReceipt>();
  for (const entry of entries) {
    byId.set(conflictIdForEvidence(entry), entry);
  }
  return [...byId.values()];
}

function conflictIdForEvidence(entry: EvidenceReceipt): string {
  const value = entry.metadata.conflictId;
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : conflictIdForSubject(entry.subject.subjectId);
}

function conflictIdForSubject(subjectId: string): string {
  return subjectId.startsWith('conflict:') ? subjectId.slice('conflict:'.length) : subjectId;
}

function isIndependentlyClosedConflict(entry: EvidenceReceipt): boolean {
  return entry.metadata.resolved === true
    && entry.metadata.independentVerificationSatisfied === true
    && isBooleanValue(entry.metadata.blocking, false);
}

function isAlphaOnlyClosedConflict(entry: EvidenceReceipt): boolean {
  return isIndependentlyClosedConflict(entry)
    && entry.metadata.alphaOnly === true;
}

function isBooleanValue(value: unknown, expected: boolean): boolean {
  return typeof value === 'boolean' && value === expected;
}

function readRsiCandidates(file: string): RsiCandidate[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8').trim();
  if (raw.length === 0) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed as RsiCandidate[] : [];
}
