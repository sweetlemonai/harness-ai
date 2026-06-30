import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type EvidenceRef,
  RLL_EVENT_SCHEMA_VERSION,
  type RLLEvent as CoreRllEvent,
} from '../../types.js';
import type {
  MessageEnvelopeV2,
  ReceiptKind,
  ReceiptV2,
  SignatureStatus,
  VerificationIssue,
  VerificationReport,
} from '../../types.js';
import type { EvidenceReceipt } from '../evidence/types.js';
import type { RllControlSignal, RllEvent, RsiCandidate } from '../rll/types.js';
import { validateScopeRef } from './scope.js';
import { createVerificationReport, issue } from './verify.js';
import { verifyReceiptChain } from './receipts.js';
import { sha256Hex, stableId, stableStringify } from './hash.js';
import { sidecarPathsForRunDir } from './sidecar.js';
import type {
  BcrxSubjectFields,
  ProtocolMessage,
  ProtocolReceipt,
  SignatureDescriptor,
  ZkSnarkDescriptor,
} from './types.js';
import {
  verifyProtocolAttestation,
  verifySignatureDescriptor,
} from '../proof/local.js';
import {
  evidenceReceiptSigningPayload,
  protocolMessageSigningPayload,
  protocolReceiptSigningPayload,
} from './signingPayloads.js';

export type ProtocolDoctorAuditMode = 'tip' | 'full';
export type ProtocolDoctorProfile = 'alpha' | 'production';

export interface ProtocolDoctorInput {
  readonly messages?: readonly MessageEnvelopeV2[];
  readonly receipts?: readonly ReceiptV2[];
  readonly now?: Date;
  readonly profile?: ProtocolDoctorProfile;
}

export interface ProtocolSidecarDoctorInput {
  readonly runDir: string;
  readonly auditMode?: ProtocolDoctorAuditMode;
  readonly now?: Date;
  readonly profile?: ProtocolDoctorProfile;
}

export interface LedgerDoctorSummary {
  readonly file: string;
  readonly exists: boolean;
  readonly auditMode: ProtocolDoctorAuditMode;
  readonly entriesTotal: number | null;
  readonly entriesChecked: number;
  readonly tipHash: string | null;
  readonly issues: readonly VerificationIssue[];
}

export interface ProtocolSidecarDoctorReport {
  readonly ok: boolean;
  readonly runDir: string;
  readonly checkedAt: string;
  readonly auditMode: ProtocolDoctorAuditMode;
  readonly profile: ProtocolDoctorProfile;
  readonly ledgers: {
    readonly messages: LedgerDoctorSummary;
    readonly receipts: LedgerDoctorSummary;
    readonly evidence: LedgerDoctorSummary;
    readonly rll: LedgerDoctorSummary;
    readonly agentops: LedgerDoctorSummary;
  };
  readonly rsiIndex: {
    readonly file: string;
    readonly exists: boolean;
    readonly candidateCount: number;
    readonly issues: readonly VerificationIssue[];
  };
  readonly report: VerificationReport;
}

interface LedgerLine {
  readonly line: number | null;
  readonly raw: string;
  readonly value?: unknown;
}

interface LedgerReadResult {
  readonly exists: boolean;
  readonly entriesTotal: number | null;
  readonly lines: readonly LedgerLine[];
  readonly tipHash: string | null;
}

const LEDGER_MISSING_ENTRIES: readonly LedgerLine[] = [];
const EVIDENCE_KINDS = new Set([
  'file',
  'command',
  'http',
  'model_output',
  'implementation_conflict',
  'adapter_recovery',
  'receipt',
  'signature',
  'proof',
  'instrumentation_proof',
  'instrumentation_missing',
  'human_observation',
  'external_record',
]);
const SIDECAR_EVIDENCE_KINDS = new Set([
  'command_output',
  'file_ref',
  'model_output',
  'adapter_failure',
  'adapter_recovery',
  'implementation_conflict',
  'human_assertion',
  'codegraph_receipt',
  'fleet_probe',
  'privacy_preflight',
  'instrumentation_proof',
  'instrumentation_missing',
  'rll_observation',
]);

export function doctorProtocol(input: ProtocolDoctorInput): VerificationReport {
  const messages = input.messages ?? [];
  const receipts = input.receipts ?? [];
  const profile = input.profile ?? 'alpha';
  const issues: VerificationIssue[] = [
    ...verifyReceiptChain(receipts).issues.map((entry) => applyProfileToIssue(entry, profile)),
  ];
  const receiptsBySubject = groupReceiptsBySubject(receipts);
  const now = input.now ?? new Date();

  messages.forEach((message, index) => {
    const line = index + 1;
    issues.push(...validateMessage(message, line, profile));

    const subjectReceipts = receiptsBySubject.get(message.messageId) ?? [];
    for (const kind of message.requiredReceipts) {
      if (!subjectReceipts.some((receipt) => receipt.kind === kind)) {
        issues.push(issue('error', 'protocol.required_receipt_missing', `message missing required ${kind} receipt`, {
          subjectId: message.messageId,
          line,
        }));
      }
    }

    if (message.deadline !== undefined && Date.parse(message.deadline) < now.getTime()) {
      const hasTerminal = subjectReceipts.some((receipt) => isTerminalReceipt(receipt.kind));
      if (!hasTerminal) {
        issues.push(issue('warning', 'protocol.deadline_without_terminal_receipt', 'message deadline passed without terminal receipt', {
          subjectId: message.messageId,
          line,
        }));
      }
    }
  });
  receipts.forEach((receipt, index) => {
    issues.push(...validateCoreReceipt(receipt, index + 1, profile));
  });
  issues.push(...validateCoreReplay(messages, receipts, profile));

  return createVerificationReport({
    subject: 'protocol',
    issues,
    ...(receipts.at(-1)?.receiptId !== undefined ? { headHash: receipts.at(-1)!.receiptId } : {}),
  });
}

export function doctorProtocolSidecars(
  input: ProtocolSidecarDoctorInput,
): ProtocolSidecarDoctorReport {
  const files = sidecarPathsForRunDir(input.runDir);
  const auditMode = input.auditMode ?? 'tip';
  const profile = input.profile ?? 'alpha';
  const checkedAt = (input.now ?? new Date()).toISOString();
  const evidenceIds = new Set<string>();
  const messageIds = new Set<string>();

  const evidence = validateLedger<EvidenceReceipt>({
    file: files.evidenceFile,
    auditMode,
    label: 'evidence',
    validateEntry: (entry, line) => validateEvidenceReceipt(entry, line, evidenceIds, profile),
  });
  const crossEvidenceIds = auditMode === 'full' ? evidenceIds : new Set<string>();
  const messages = validateLedger<ProtocolMessage>({
    file: files.protocolMessagesFile,
    auditMode,
    label: 'protocol_message',
    validateEntry: (entry, line) => validateProtocolMessage(entry, line, crossEvidenceIds, messageIds, profile),
  });
  const crossMessageIds = auditMode === 'full' ? messageIds : new Set<string>();
  const receipts = validateLedger<ProtocolReceipt>({
    file: files.protocolReceiptsFile,
    auditMode,
    label: 'protocol_receipt',
    validateEntry: (entry, line) => validateProtocolReceipt(entry, line, crossEvidenceIds, crossMessageIds, profile),
  });
  const rll = validateLedger<RllEvent | CoreRllEvent>({
    file: files.rllFile,
    auditMode,
    label: 'rll_event',
    validateEntry: (entry, line) => validateAnyRllEvent(entry, line, profile),
  });
  const agentops = validateLedger<RllControlSignal>({
    file: files.agentopsEventsFile,
    auditMode,
    label: 'agentops_event',
    validateEntry: (entry, line) => validateControlSignal(entry, line, profile),
  });
  const auditedMessages = readLedgerValuesForAudit<ProtocolMessage>(files.protocolMessagesFile, auditMode);
  const auditedReceipts = readLedgerValuesForAudit<ProtocolReceipt>(files.protocolReceiptsFile, auditMode);
  const auditedEvidence = readLedgerValuesForAudit<EvidenceReceipt>(files.evidenceFile, auditMode);
  const auditedRll = readLedgerValuesForAudit<RllEvent | CoreRllEvent>(files.rllFile, auditMode);
  const auditedAgentops = readLedgerValuesForAudit<RllControlSignal>(files.agentopsEventsFile, auditMode);
  const rsiIndex = validateRsiIndex(files.rsiIndexFile, profile);
  const allIssues = [
    ...messages.issues,
    ...receipts.issues,
    ...evidence.issues,
    ...rll.issues,
    ...agentops.issues,
    ...rsiIndex.issues,
    ...validateDissentPolicyCoverage({
      messages: auditedMessages,
      receipts: auditedReceipts,
      evidence: auditedEvidence,
      rll: auditedRll,
      agentops: auditedAgentops,
      profile,
    }),
    ...validateAuditCoverage({
      auditMode,
      profile,
      messages,
      receipts,
      evidence,
      rll,
      agentops,
    }),
  ];
  const report = createVerificationReport({
    subject: files.runDir,
    issues: allIssues,
    headHash: [
      messages.tipHash,
      receipts.tipHash,
      evidence.tipHash,
      rll.tipHash,
      agentops.tipHash,
    ].filter((value) => value !== null).join(':') || undefined,
    checkedAt,
  });
  return {
    ok: report.ok,
    runDir: files.runDir,
    checkedAt,
    auditMode,
    profile,
    ledgers: {
      messages,
      receipts,
      evidence,
      rll,
      agentops,
    },
    rsiIndex,
    report,
  };
}

function validateLedger<T>(args: {
  readonly file: string;
  readonly auditMode: ProtocolDoctorAuditMode;
  readonly label: string;
  readonly validateEntry: (entry: T, line: number | undefined) => readonly VerificationIssue[];
}): LedgerDoctorSummary {
  const read = readLedgerForAudit(args.file, args.auditMode);
  const issues: VerificationIssue[] = [...validateLedgerHashLinks(read.lines, args.label)];
  for (const line of read.lines) {
    if (line.value === undefined) continue;
    issues.push(...args.validateEntry(line.value as T, line.line ?? undefined));
  }
  return {
    file: args.file,
    exists: read.exists,
    auditMode: args.auditMode,
    entriesTotal: read.entriesTotal,
    entriesChecked: read.lines.length,
    tipHash: read.tipHash,
    issues,
  };
}

function readLedgerValuesForAudit<T>(
  file: string,
  auditMode: ProtocolDoctorAuditMode,
): readonly { readonly value: T; readonly line?: number }[] {
  return readLedgerForAudit(file, auditMode).lines
    .filter((line): line is LedgerLine & { readonly value: unknown } => line.value !== undefined)
    .map((line) => ({
      value: line.value as T,
      ...(line.line !== null ? { line: line.line } : {}),
    }));
}

function validateDissentPolicyCoverage(args: {
  readonly messages: readonly { readonly value: ProtocolMessage; readonly line?: number }[];
  readonly receipts: readonly { readonly value: ProtocolReceipt; readonly line?: number }[];
  readonly evidence: readonly { readonly value: EvidenceReceipt; readonly line?: number }[];
  readonly rll: readonly { readonly value: RllEvent | CoreRllEvent; readonly line?: number }[];
  readonly agentops: readonly { readonly value: RllControlSignal; readonly line?: number }[];
  readonly profile: ProtocolDoctorProfile;
}): readonly VerificationIssue[] {
  const required = new Map<string, {
    readonly subject: BcrxSubjectFields;
    readonly minDissenters: number;
    readonly line?: number;
  }>();
  const addRequired = (subject: BcrxSubjectFields, line?: number): void => {
    const policy = subject.dissentPolicy;
    if (policy?.required !== true || policy.scope === 'none' || policy.minDissenters <= 0) return;
    const prior = required.get(subject.subjectId);
    if (prior === undefined || policy.minDissenters > prior.minDissenters) {
      required.set(subject.subjectId, {
        subject,
        minDissenters: policy.minDissenters,
        ...(line !== undefined ? { line } : {}),
      });
    }
  };

  for (const entry of args.messages) addRequired(entry.value.subject, entry.line);
  for (const entry of args.receipts) addRequired(entry.value.subject, entry.line);
  for (const entry of args.evidence) addRequired(entry.value.subject, entry.line);
  for (const entry of args.rll) {
    if (isSidecarRllEvent(entry.value)) {
      addRequired(entry.value.subject, entry.line);
    }
  }
  for (const entry of args.agentops) addRequired(entry.value.subject, entry.line);
  if (required.size === 0) return [];

  const acceptedDissentReceiptByMessageId = new Set(
    args.receipts
      .map((entry) => entry.value)
      .filter((receipt) => (
        receipt.receiptType === 'dissent_recorded'
        && receipt.status === 'accepted'
        && nonEmpty(receipt.messageId)
      ))
      .map((receipt) => receipt.messageId!),
  );
  const dissentersBySubject = new Map<string, Set<string>>();
  for (const { value: message } of args.messages) {
    if (message.kind !== 'dissent') continue;
    if (message.evidenceRefs.length === 0) continue;
    if (message.epistemics.status === 'unsupported') continue;
    if (args.profile === 'production' && !acceptedDissentReceiptByMessageId.has(message.messageId)) {
      continue;
    }
    const dissenters = dissentersBySubject.get(message.subject.subjectId) ?? new Set<string>();
    dissenters.add(message.from);
    dissentersBySubject.set(message.subject.subjectId, dissenters);
  }

  const issues: VerificationIssue[] = [];
  for (const requirement of required.values()) {
    const dissenters = dissentersBySubject.get(requirement.subject.subjectId);
    const count = dissenters?.size ?? 0;
    if (count >= requirement.minDissenters) continue;
    issues.push(profileIssue(
      args.profile,
      'dissent.requirement_unmet',
      `subject requires ${requirement.minDissenters} evidence-bound dissenting agent(s), but ${count} accepted dissent receipt(s) were found`,
      {
        subjectId: requirement.subject.subjectId,
        line: requirement.line,
      },
    ));
  }
  return issues;
}

function isSidecarRllEvent(value: RllEvent | CoreRllEvent): value is RllEvent {
  return 'subject' in value;
}

function validateAuditCoverage(args: {
  readonly auditMode: ProtocolDoctorAuditMode;
  readonly profile: ProtocolDoctorProfile;
  readonly messages: LedgerDoctorSummary;
  readonly receipts: LedgerDoctorSummary;
  readonly evidence: LedgerDoctorSummary;
  readonly rll: LedgerDoctorSummary;
  readonly agentops: LedgerDoctorSummary;
}): readonly VerificationIssue[] {
  const ledgers = [
    args.messages,
    args.receipts,
    args.evidence,
    args.rll,
    args.agentops,
  ];
  const checkedEntries = ledgers.reduce((total, entry) => total + entry.entriesChecked, 0);
  const issues: VerificationIssue[] = [];
  if (args.auditMode === 'full' && checkedEntries === 0) {
    issues.push(issue('error', 'sidecar_audit.no_entries_checked', 'full sidecar audit checked no ledger entries; absence is not proof of readiness'));
  }
  if (args.profile === 'production') {
    for (const [label, summary] of [
      ['protocol_messages', args.messages],
      ['protocol_receipts', args.receipts],
      ['evidence', args.evidence],
      ['rll', args.rll],
      ['agentops', args.agentops],
    ] as const) {
      if (!summary.exists) {
        issues.push(issue('error', `sidecar_audit.${label}_missing`, `production audit requires ${label} ledger to exist`));
      }
    }
  }
  return issues;
}

function readLedgerForAudit(file: string, auditMode: ProtocolDoctorAuditMode): LedgerReadResult {
  if (!existsSync(file)) {
    return {
      exists: false,
      entriesTotal: 0,
      lines: LEDGER_MISSING_ENTRIES,
      tipHash: null,
    };
  }
  const rawLines = auditMode === 'full'
    ? readAllLedgerLines(file)
    : readTailLedgerLines(file, 2);
  const parsed = rawLines.map((entry) => parseLedgerLine(entry));
  return {
    exists: true,
    entriesTotal: auditMode === 'full' ? rawLines.length : null,
    lines: parsed,
    tipHash: parsed.at(-1) === undefined ? null : sha256Hex(parsed.at(-1)!.raw),
  };
}

function readAllLedgerLines(file: string): readonly LedgerLine[] {
  const raw = readFileSync(file, 'utf8').trimEnd();
  if (raw.length === 0) return [];
  return raw
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, raw: line }))
    .filter((line) => line.raw.trim().length > 0);
}

function readTailLedgerLines(file: string, wantedLines: number): readonly LedgerLine[] {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (stat.size === 0) return [];
    const chunks: Buffer[] = [];
    let position = stat.size;
    let newlineCount = 0;
    while (position > 0 && newlineCount <= wantedLines) {
      const size = Math.min(8192, position);
      position -= size;
      const buffer = Buffer.allocUnsafe(size);
      readSync(fd, buffer, 0, size, position);
      chunks.unshift(buffer);
      newlineCount += countNewlines(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trimEnd();
    if (text.length === 0) return [];
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-wantedLines)
      .map((line) => ({ line: null, raw: line }));
  } finally {
    closeSync(fd);
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const value of buffer.values()) {
    if (value === 10) count += 1;
  }
  return count;
}

function parseLedgerLine(line: LedgerLine): LedgerLine {
  try {
    return {
      ...line,
      value: JSON.parse(line.raw),
    };
  } catch {
    return line;
  }
}

function validateLedgerHashLinks(
  lines: readonly LedgerLine[],
  label: string,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]!;
    if (current.value === undefined) {
      issues.push(issue('error', `${label}.json_invalid`, `${label} ledger line is not valid JSON`, {
        line: current.line ?? undefined,
      }));
      continue;
    }
    const record = current.value as { readonly previousLineHash?: unknown };
    const previous = lines[index - 1];
    if (previous !== undefined) {
      const expected = sha256Hex(previous.raw);
      if (record.previousLineHash !== expected) {
        issues.push(issue('error', `${label}.previous_line_hash_mismatch`, `${label} previousLineHash does not match previous ledger line`, {
          line: current.line ?? undefined,
        }));
      }
      continue;
    }
    if (current.line === 1 && record.previousLineHash !== null) {
      issues.push(issue('error', `${label}.previous_line_hash_mismatch`, `${label} first line previousLineHash must be null`, {
        line: current.line,
      }));
    }
  }
  return issues;
}

function validateProtocolMessage(
  message: ProtocolMessage,
  line: number | undefined,
  evidenceIds: ReadonlySet<string>,
  messageIds: Set<string>,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (message.schemaVersion !== 'superharness.protocol.message.v2') {
    issues.push(issue('error', 'protocol_message.schema_invalid', 'protocol message schemaVersion is invalid', { subjectId: message.messageId, line }));
  }
  if (message.protocolVersion !== '2.0') {
    issues.push(issue('error', 'protocol_message.version_invalid', 'protocol message protocolVersion must be 2.0', { subjectId: message.messageId, line }));
  }
  if (!nonEmpty(message.messageId)) {
    issues.push(issue('error', 'protocol_message.id_missing', 'protocol messageId must be non-empty', { line }));
  } else {
    messageIds.add(message.messageId);
  }
  if (!nonEmpty(message.from)) {
    issues.push(issue('error', 'protocol_message.sender_missing', 'protocol message from must be non-empty', { subjectId: message.messageId, line }));
  }
  if (!validIsoTimestamp(message.createdAt)) {
    issues.push(issue('error', 'protocol_message.created_at_invalid', 'protocol message createdAt must be a parseable timestamp', { subjectId: message.messageId, line }));
  }
  if (!Array.isArray(message.to) || message.to.length === 0) {
    issues.push(issue('error', 'protocol_message.recipient_missing', 'protocol message must have at least one recipient', { subjectId: message.messageId, line }));
  }
  const expectedId = stableId('msg', {
    protocolVersion: '2.0',
    kind: message.kind,
    from: message.from,
    to: message.to,
    subject: message.subject,
    createdAt: message.createdAt,
    body: message.body,
    epistemics: message.epistemics,
    evidenceRefs: message.evidenceRefs,
    inReplyTo: message.inReplyTo ?? null,
    causalityRefs: message.causalityRefs,
  });
  if (message.messageId !== expectedId) {
    issues.push(issue('error', 'protocol_message.id_mismatch', 'protocol messageId does not match canonical payload', { subjectId: message.messageId, line }));
  }
  issues.push(...validateSubject(message.subject, `message:${message.messageId}`, line, profile));
  const minRefs = message.subject.evidencePolicy?.required === true
    ? message.subject.evidencePolicy.minRefs
    : 0;
  if (message.evidenceRefs.length < minRefs) {
    issues.push(issue('error', 'protocol_message.evidence_requirement_unmet', 'protocol message does not satisfy subject evidence policy', { subjectId: message.messageId, line }));
  }
  if (evidenceIds.size > 0) {
    for (const ref of message.evidenceRefs) {
      if (!evidenceIds.has(ref)) {
        issues.push(issue('error', 'protocol_message.evidence_ref_missing', `message references unknown evidence ${ref}`, { subjectId: message.messageId, line }));
      }
    }
  }
  if (message.signature?.status !== 'signed') {
    issues.push(profileIssue(profile, 'protocol_message.signature_not_signed', 'protocol message is not cryptographically signed', { subjectId: message.messageId, line }));
  } else {
    if (profile === 'production') {
      issues.push(...validateProductionSignature(message.signature, message.messageId, line, 'protocol_message'));
    }
    issues.push(...validateSidecarSignature(
      protocolMessageSigningPayload(message),
      message.signature,
      message.messageId,
      line,
      'protocol_message',
      profile,
    ));
  }
  if (message.attestation !== undefined) {
    issues.push(...validateAttestation(message.attestation, message.subject, message.messageId, line, profile));
  }
  return issues;
}

function validateProtocolReceipt(
  receipt: ProtocolReceipt,
  line: number | undefined,
  evidenceIds: ReadonlySet<string>,
  messageIds: ReadonlySet<string>,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (receipt.schemaVersion !== 'superharness.protocol.receipt.v2') {
    issues.push(issue('error', 'protocol_receipt.schema_invalid', 'protocol receipt schemaVersion is invalid', { subjectId: receipt.receiptId, line }));
  }
  if (receipt.protocolVersion !== '2.0') {
    issues.push(issue('error', 'protocol_receipt.version_invalid', 'protocol receipt protocolVersion must be 2.0', { subjectId: receipt.receiptId, line }));
  }
  if (!validIsoTimestamp(receipt.issuedAt)) {
    issues.push(issue('error', 'protocol_receipt.issued_at_invalid', 'protocol receipt issuedAt must be a parseable timestamp', { subjectId: receipt.receiptId, line }));
  }
  const publicInputs = {
    receiptType: receipt.receiptType,
    subject: receipt.subject,
    messageId: receipt.messageId ?? null,
    status: receipt.status,
    evidenceRefs: receipt.evidenceRefs,
    implementerAgentId: receipt.implementerAgentId ?? null,
    verifierAgentId: receipt.verifierAgentId ?? null,
    independentVerification: receipt.independentVerification ?? null,
  };
  const expectedPublicInputsHash = sha256Hex(stableStringify(publicInputs));
  if (receipt.publicInputsHash !== expectedPublicInputsHash) {
    issues.push(issue('error', 'protocol_receipt.public_inputs_hash_mismatch', 'protocol receipt publicInputsHash does not match public inputs', { subjectId: receipt.receiptId, line }));
  }
  const expectedId = stableId('receipt', {
    publicInputsHash: receipt.publicInputsHash,
    payloadHash: receipt.payloadHash,
    issuedAt: receipt.issuedAt,
  });
  if (receipt.receiptId !== expectedId) {
    issues.push(issue('error', 'protocol_receipt.id_mismatch', 'protocol receiptId does not match canonical public payload', { subjectId: receipt.receiptId, line }));
  }
  if (receipt.messageId !== undefined && messageIds.size > 0 && !messageIds.has(receipt.messageId)) {
    issues.push(issue('error', 'protocol_receipt.message_ref_missing', `receipt references unknown message ${receipt.messageId}`, { subjectId: receipt.receiptId, line }));
  }
  for (const ref of receipt.evidenceRefs) {
    if (evidenceIds.size > 0 && !evidenceIds.has(ref)) {
      issues.push(issue('error', 'protocol_receipt.evidence_ref_missing', `receipt references unknown evidence ${ref}`, { subjectId: receipt.receiptId, line }));
    }
  }
  if (receipt.evidenceRefs.length === 0) {
    issues.push(profileIssue(profile, 'protocol_receipt.evidence_missing', 'protocol receipt has no evidence refs', { subjectId: receipt.receiptId, line }));
  }
  issues.push(...validateSubject(receipt.subject, `receipt:${receipt.receiptId}`, line, profile));
  issues.push(...validateSignatureAndZk(receipt.signature, receipt.zkSnark, receipt.subject, receipt.receiptId, line, 'protocol_receipt', profile));
  if (receipt.signature.status === 'signed') {
    issues.push(...validateSidecarSignature(
      protocolReceiptSigningPayload(receipt),
      receipt.signature,
      receipt.receiptId,
      line,
      'protocol_receipt',
      profile,
    ));
  }
  return issues;
}

function validateEvidenceReceipt(
  evidence: EvidenceReceipt,
  line: number | undefined,
  evidenceIds: Set<string>,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (evidence.schemaVersion !== 'superharness.evidence.receipt.v2') {
    issues.push(issue('error', 'evidence_receipt.schema_invalid', 'evidence receipt schemaVersion is invalid', { subjectId: evidence.evidenceId, line }));
  }
  if (!SIDECAR_EVIDENCE_KINDS.has(evidence.kind)) {
    issues.push(issue('error', 'evidence_receipt.kind_invalid', 'evidence receipt kind is not supported by the sidecar schema', { subjectId: evidence.evidenceId, line }));
  }
  if (!validIsoTimestamp(evidence.createdAt)) {
    issues.push(issue('error', 'evidence_receipt.created_at_invalid', 'evidence receipt createdAt must be a parseable timestamp', { subjectId: evidence.evidenceId, line }));
  }
  const expectedId = stableId('evidence', {
    kind: evidence.kind,
    subjectId: evidence.subject.subjectId,
    contentHash: evidence.contentHash,
    uri: evidence.uri ?? null,
    observedBy: evidence.observedBy,
  });
  if (evidence.evidenceId !== expectedId) {
    issues.push(issue('error', 'evidence_receipt.id_mismatch', 'evidenceId does not match canonical evidence receipt payload', { subjectId: evidence.evidenceId, line }));
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.contentHash)) {
    issues.push(issue('error', 'evidence_receipt.content_hash_invalid', 'evidence contentHash must be sha256 hex', { subjectId: evidence.evidenceId, line }));
  }
  if (!nonEmpty(evidence.summary)) {
    issues.push(issue('error', 'evidence_receipt.summary_missing', 'evidence summary must be non-empty', { subjectId: evidence.evidenceId, line }));
  }
  evidenceIds.add(evidence.evidenceId);
  issues.push(...validateSubject(evidence.subject, `evidence:${evidence.evidenceId}`, line, profile));
  issues.push(...validateSignatureAndZk(evidence.signature, evidence.zkSnark, evidence.subject, evidence.evidenceId, line, 'evidence_receipt', profile));
  if (evidence.signature.status === 'signed') {
    issues.push(...validateSidecarSignature(
      evidenceReceiptSigningPayload(evidence),
      evidence.signature,
      evidence.evidenceId,
      line,
      'evidence_receipt',
      profile,
    ));
  }
  return issues;
}

function validateAnyRllEvent(
  event: RllEvent | CoreRllEvent,
  line: number | undefined,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  if (event.schemaVersion === RLL_EVENT_SCHEMA_VERSION) {
    return validateCoreRllEvent(event as CoreRllEvent, line);
  }
  return validateRllSidecarEvent(event as RllEvent, line, profile);
}

function validateRllSidecarEvent(
  event: RllEvent,
  line: number | undefined,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (event.schemaVersion !== 'superharness.rll.event.v2') {
    issues.push(issue('error', 'rll_event.schema_invalid', 'RLL event schemaVersion is invalid', { subjectId: event.eventId, line }));
  }
  const expectedId = stableId('rll', {
    kind: event.kind,
    subjectId: event.subject.subjectId,
    source: event.source,
    summary: event.summary,
    inputRefs: event.inputRefs,
    outputRefs: event.outputRefs,
    metrics: event.metrics,
    createdAt: event.createdAt,
  });
  if (event.eventId !== expectedId) {
    issues.push(issue('error', 'rll_event.id_mismatch', 'RLL eventId does not match canonical payload', { subjectId: event.eventId, line }));
  }
  if (event.confidence !== undefined && (event.confidence < 0 || event.confidence > 1)) {
    issues.push(issue('error', 'rll_event.confidence_invalid', 'RLL confidence must be between 0 and 1', { subjectId: event.eventId, line }));
  }
  for (const [key, value] of Object.entries(event.metrics)) {
    if (!Number.isFinite(value)) {
      issues.push(issue('error', 'rll_event.metric_invalid', `RLL metric ${key} must be finite`, { subjectId: event.eventId, line }));
    }
  }
  issues.push(...validateSubject(event.subject, `rll:${event.eventId}`, line, profile));
  return issues;
}

function validateCoreRllEvent(event: CoreRllEvent, line: number | undefined): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (event.schemaVersion !== RLL_EVENT_SCHEMA_VERSION) {
    issues.push(issue('error', 'rll_core_event.schema_invalid', 'core RLL event schemaVersion is invalid', { subjectId: event.eventId, line }));
  }
  if (!nonEmpty(event.eventId)) {
    issues.push(issue('error', 'rll_core_event.id_missing', 'core RLL eventId must be non-empty', { line }));
  }
  if (event.runId !== event.scope.runId) {
    issues.push(issue('error', 'rll_core_event.scope_run_mismatch', 'core RLL event runId must match scope.runId', { subjectId: event.eventId, line }));
  }
  if (event.privacyZone !== event.scope.privacyZone) {
    issues.push(issue('error', 'rll_core_event.scope_privacy_mismatch', 'core RLL event privacyZone must match scope privacyZone', { subjectId: event.eventId, line }));
  }
  if (event.visibility !== event.scope.visibility) {
    issues.push(issue('error', 'rll_core_event.scope_visibility_mismatch', 'core RLL event visibility must match scope visibility', { subjectId: event.eventId, line }));
  }
  const { hash: _hash, ...payload } = event;
  const expectedHash = sha256Hex(stableStringify(payload));
  if (event.hash !== expectedHash) {
    issues.push(issue('error', 'rll_core_event.hash_mismatch', 'core RLL event hash does not match canonical payload', { subjectId: event.eventId, line }));
  }
  return issues;
}

function validateControlSignal(
  signal: RllControlSignal,
  line: number | undefined,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (signal.schemaVersion !== 'superharness.rll.control_signal.v2') {
    issues.push(issue('error', 'control_signal.schema_invalid', 'control signal schemaVersion is invalid', { subjectId: signal.signalId, line }));
  }
  const expectedId = stableId('rll_signal', {
    action: signal.action,
    subjectId: signal.subject.subjectId,
    reason: signal.reason,
    sourceEventIds: signal.sourceEventIds,
    evidenceRefs: signal.evidenceRefs,
    createdAt: signal.createdAt,
  });
  if (signal.signalId !== expectedId) {
    issues.push(issue('error', 'control_signal.id_mismatch', 'control signalId does not match canonical payload', { subjectId: signal.signalId, line }));
  }
  if (!validIsoTimestamp(signal.createdAt)) {
    issues.push(issue('error', 'control_signal.created_at_invalid', 'control signal createdAt must be a parseable timestamp', { subjectId: signal.signalId, line }));
  }
  if (signal.strength < 0 || signal.strength > 1) {
    issues.push(issue('error', 'control_signal.strength_invalid', 'control signal strength must be between 0 and 1', { subjectId: signal.signalId, line }));
  }
  issues.push(...validateSubject(signal.subject, `signal:${signal.signalId}`, line, profile));
  return issues;
}

function validateRsiIndex(
  file: string,
  profile: ProtocolDoctorProfile,
): ProtocolSidecarDoctorReport['rsiIndex'] {
  if (!existsSync(file)) {
    return {
      file,
      exists: false,
      candidateCount: 0,
      issues: [],
    };
  }
  const issues: VerificationIssue[] = [];
  let candidates: RsiCandidate[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      issues.push(issue('error', 'rsi_index.schema_invalid', 'RSI index must be a JSON array'));
    } else {
      candidates = parsed as RsiCandidate[];
    }
  } catch {
    issues.push(issue('error', 'rsi_index.json_invalid', 'RSI index is not valid JSON'));
  }
  for (const candidate of candidates) {
    const expectedId = stableId('rsi', {
      subjectId: candidate.subject.subjectId,
      hypothesis: candidate.hypothesis,
      requiredEvidenceRefs: candidate.requiredEvidenceRefs,
    });
    if (candidate.candidateId !== expectedId) {
      issues.push(issue('error', 'rsi_index.id_mismatch', 'RSI candidateId does not match canonical payload', {
        subjectId: candidate.candidateId,
      }));
    }
    issues.push(...validateSubject(candidate.subject, `rsi:${candidate.candidateId}`, undefined, profile));
  }
  return {
    file,
    exists: true,
    candidateCount: candidates.length,
    issues,
  };
}

function validateSubject(
  subject: BcrxSubjectFields,
  subjectId: string,
  line: number | undefined,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (!nonEmpty(subject.subjectId)) {
    issues.push(issue('error', 'bcrx_subject.id_missing', 'BCRX subjectId must be non-empty', { subjectId, line }));
  }
  if (!nonEmpty(subject.title)) {
    issues.push(issue('error', 'bcrx_subject.title_missing', 'BCRX subject title must be non-empty', { subjectId, line }));
  }
  if (subject.evidencePolicy !== undefined && subject.evidencePolicy.minRefs < 0) {
    issues.push(issue('error', 'bcrx_subject.evidence_policy_invalid', 'evidencePolicy.minRefs must be non-negative', { subjectId, line }));
  }
  if (subject.dissentPolicy !== undefined && subject.dissentPolicy.minDissenters < 0) {
    issues.push(issue('error', 'bcrx_subject.dissent_policy_invalid', 'dissentPolicy.minDissenters must be non-negative', { subjectId, line }));
  }
  if (subject.proofPolicy !== undefined && subject.proofPolicy.minProofs < 0) {
    issues.push(issue('error', 'bcrx_subject.proof_policy_invalid', 'proofPolicy.minProofs must be non-negative', { subjectId, line }));
  }
  if (
    subject.proofPolicy !== undefined
    && subject.proofPolicy.required
    && subject.proofPolicy.minProofs < 1
  ) {
    issues.push(issue('error', 'bcrx_subject.proof_policy_invalid', 'proofPolicy.minProofs must be at least 1 when proof is required', { subjectId, line }));
  }
  if (subject.assuranceContext === undefined) {
    issues.push(profile === 'production'
      ? issue('error', 'bcrx_subject.assurance_context_missing', 'production doctor requires an explicit production assuranceContext on every subject', { subjectId, line })
      : issue('info', 'bcrx_subject.assurance_context_missing_alpha', 'subject has no explicit assuranceContext; alpha treats it as development-only', { subjectId, line }));
  } else if (subject.assuranceContext !== 'alpha' && subject.assuranceContext !== 'production') {
    issues.push(issue('error', 'bcrx_subject.assurance_context_invalid', 'assuranceContext must be alpha or production', { subjectId, line }));
  } else if (profile === 'production' && subject.assuranceContext !== 'production') {
    issues.push(issue('error', 'bcrx_subject.production_context_required', 'production doctor requires assuranceContext=production', { subjectId, line }));
  }
  return issues;
}

function validateAttestation(
  attestation: NonNullable<ProtocolMessage['attestation']>,
  subject: BcrxSubjectFields,
  subjectId: string,
  line: number | undefined,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (!nonEmpty(attestation.attestationId)) {
    issues.push(issue('error', 'attestation.id_missing', 'attestationId must be non-empty', { subjectId, line }));
  }
  if (!nonEmpty(attestation.publicInputsHash)) {
    issues.push(issue('error', 'attestation.public_inputs_hash_missing', 'attestation publicInputsHash must be non-empty', { subjectId, line }));
  }
  const report = verifyProtocolAttestation(attestation);
  issues.push(...report.issues.map((entry) => ({
    severity: profile === 'production' && isProductionBlockingProofOrSignatureIssue(entry.code, subject)
      ? 'error' as const
      : entry.severity,
    code: `attestation.${entry.code}`,
    message: entry.message,
    ...(entry.subjectId !== undefined ? { subjectId: entry.subjectId } : {}),
    ...(entry.line !== undefined ? { line: entry.line } : line !== undefined ? { line } : {}),
  })));
  if (profile === 'production' && proofRequired(subject) && !zkIsProductionProved(attestation.zkSnark)) {
    issues.push(issue('error', 'attestation.zk_required_not_proved', 'subject proofPolicy requires a proved external SNARK attestation', { subjectId, line }));
  }
  return issues;
}

function validateSignatureAndZk(
  signature: SignatureDescriptor,
  zkSnark: ZkSnarkDescriptor,
  subject: BcrxSubjectFields,
  subjectId: string,
  line: number | undefined,
  prefix: string,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (signature.status !== 'signed') {
    issues.push(profileIssue(profile, `${prefix}.signature_not_signed`, 'object is not cryptographically signed', { subjectId, line }));
  } else {
    if (signature.algorithm !== 'ed25519') {
      issues.push(profileIssue(profile, `${prefix}.signature_algorithm_not_locally_verified`, 'signature algorithm is not verified by protocol doctor', { subjectId, line }));
    }
    if (signature.signature === undefined || signature.signature.trim() === '') {
      issues.push(issue('error', `${prefix}.signature_value_missing`, 'signed object is missing signature bytes', { subjectId, line }));
    }
    if (signature.publicKeyRef === undefined || signature.publicKeyRef.trim() === '') {
      issues.push(issue('error', `${prefix}.signature_public_key_missing`, 'signed object is missing publicKeyRef', { subjectId, line }));
    }
    if (signature.trustLevel !== 'registry_verified' && signature.trustLevel !== 'operator_bound') {
      issues.push(profileIssue(profile, `${prefix}.signature_identity_not_registry_verified`, 'signature is not bound to a verified identity registry', { subjectId, line }));
    }
    issues.push(...validateSignatureLifecycle(signature, subjectId, line, prefix, profile));
  }
  if (zkSnark.mode === 'mock_transcript' && zkSnark.status === 'proved') {
    issues.push(issue('error', `${prefix}.zk_mock_claims_proved`, 'mock-local transcript must not claim proved SNARK status', { subjectId, line }));
  } else if (zkSnark.mode === 'external_snark' && zkSnark.backend !== 'external') {
    issues.push(issue('error', `${prefix}.zk_external_backend_invalid`, 'external_snark mode requires external backend', { subjectId, line }));
  } else if (zkSnark.mode === 'not_requested' && zkSnark.status !== 'not_requested') {
    issues.push(issue('error', `${prefix}.zk_not_requested_status_invalid`, 'not_requested ZK mode must use not_requested status', { subjectId, line }));
  }
  issues.push(...validateZkLifecycle(zkSnark, subjectId, line, prefix, profile));
  if (zkSnark.status === 'failed') {
    issues.push(issue('error', `${prefix}.zk_failed`, 'ZK proof status is failed', { subjectId, line }));
  } else if (profile === 'production' && proofRequired(subject) && !zkIsProductionProved(zkSnark)) {
    issues.push(issue('error', `${prefix}.zk_required_not_proved`, 'subject proofPolicy requires a proved external SNARK proof', { subjectId, line }));
  } else if (zkSnark.status !== 'proved') {
    issues.push(issue('warning', `${prefix}.zk_not_proved`, 'ZK proof is not proved', { subjectId, line }));
  }
  return issues;
}

function validateSidecarSignature(
  payload: unknown,
  signature: SignatureDescriptor,
  subjectId: string,
  line: number | undefined,
  prefix: string,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  return verifySignatureDescriptor(payload, signature, subjectId).map((entry) => ({
    severity: profile === 'production' && entry.severity === 'warning'
      ? 'error' as const
      : entry.severity,
    code: `${prefix}.${entry.code}`,
    message: entry.message,
    ...(entry.subjectId !== undefined ? { subjectId: entry.subjectId } : { subjectId }),
    ...(entry.line !== undefined ? { line: entry.line } : line !== undefined ? { line } : {}),
  }));
}

function validateZkLifecycle(
  zkSnark: ZkSnarkDescriptor,
  subjectId: string,
  line: number | undefined,
  prefix: string,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (zkSnark.mode !== 'external_snark') return issues;
  if (!validZkFailurePolicy(zkSnark.failurePolicy)) {
    issues.push(profileIssue(profile, `${prefix}.zk_failure_policy_missing`, 'external SNARK must declare fail_closed, manual_hold, or alpha-only degraded failure policy', { subjectId, line }));
  }
  if (profile === 'production' && zkSnark.failurePolicy === 'degrade_to_signature_only_alpha') {
    issues.push(issue('error', `${prefix}.zk_alpha_degrade_policy_forbidden`, 'production external SNARK must not degrade to signature-only alpha mode', { subjectId, line }));
  }
  if (zkSnark.status === 'proved') {
    if (!nonEmpty(zkSnark.publicInputsHash)) {
      issues.push(issue('error', `${prefix}.zk_public_inputs_hash_missing`, 'proved external SNARK must include publicInputsHash', { subjectId, line }));
    }
    if (!nonEmpty(zkSnark.proofHash)) {
      issues.push(issue('error', `${prefix}.zk_proof_hash_missing`, 'proved external SNARK must include proofHash', { subjectId, line }));
    }
    if (!nonEmpty(zkSnark.verifierRef)) {
      issues.push(issue('error', `${prefix}.zk_verifier_ref_missing`, 'proved external SNARK must include verifierRef', { subjectId, line }));
    }
    if (!validIsoTimestamp(zkSnark.provedAt)) {
      issues.push(profileIssue(profile, `${prefix}.zk_proved_at_invalid`, 'proved external SNARK must include a parseable provedAt timestamp', { subjectId, line }));
    }
    if (!validIsoTimestamp(zkSnark.expiresAt)) {
      issues.push(profileIssue(profile, `${prefix}.zk_expires_at_invalid`, 'proved external SNARK must include a parseable expiresAt timestamp', { subjectId, line }));
    } else if (Date.parse(zkSnark.expiresAt) <= Date.now()) {
      issues.push(issue('error', `${prefix}.zk_expired`, 'proved external SNARK is expired', { subjectId, line }));
    }
    if (typeof zkSnark.latencyMs !== 'number' || !Number.isFinite(zkSnark.latencyMs) || zkSnark.latencyMs < 0) {
      issues.push(profileIssue(profile, `${prefix}.zk_latency_invalid`, 'proved external SNARK must include non-negative latencyMs', { subjectId, line }));
    }
    if (typeof zkSnark.maxLatencyMs !== 'number' || !Number.isFinite(zkSnark.maxLatencyMs) || zkSnark.maxLatencyMs < 0) {
      issues.push(profileIssue(profile, `${prefix}.zk_latency_budget_invalid`, 'proved external SNARK must include non-negative maxLatencyMs', { subjectId, line }));
    }
    if (zkLatencyOverBudget(zkSnark)) {
      issues.push(issue('error', `${prefix}.zk_latency_budget_exceeded`, 'proved external SNARK latency exceeds maxLatencyMs', { subjectId, line }));
    }
    if (zkSnark.failureState !== undefined && zkSnark.failureState !== 'none') {
      issues.push(issue('error', `${prefix}.zk_failure_state_invalid`, 'proved external SNARK must not carry an active failure state', { subjectId, line }));
    }
  }
  if (zkRequiresFailureState(zkSnark)) {
    if (!validZkFailureStateForPolicy(zkSnark.failureState, zkSnark.failurePolicy)) {
      issues.push(issue('error', `${prefix}.zk_failure_state_missing`, 'failed, unavailable, or over-budget external SNARK must declare the deterministic failure state for its policy', { subjectId, line }));
    }
    if (!nonEmpty(zkSnark.reason)) {
      issues.push(issue('error', `${prefix}.zk_failure_reason_missing`, 'failed, unavailable, or over-budget external SNARK must include a reason', { subjectId, line }));
    }
  }
  return issues;
}

function zkLatencyOverBudget(zkSnark: ZkSnarkDescriptor): boolean {
  return typeof zkSnark.latencyMs === 'number'
    && typeof zkSnark.maxLatencyMs === 'number'
    && Number.isFinite(zkSnark.latencyMs)
    && Number.isFinite(zkSnark.maxLatencyMs)
    && zkSnark.latencyMs > zkSnark.maxLatencyMs;
}

function zkRequiresFailureState(zkSnark: ZkSnarkDescriptor): boolean {
  return zkSnark.status === 'failed'
    || zkSnark.status === 'unavailable'
    || zkLatencyOverBudget(zkSnark);
}

function validZkFailurePolicy(value: unknown): value is NonNullable<ZkSnarkDescriptor['failurePolicy']> {
  return value === 'fail_closed'
    || value === 'manual_hold'
    || value === 'degrade_to_signature_only_alpha';
}

function validZkFailureStateForPolicy(
  state: unknown,
  policy: unknown,
): boolean {
  if (policy === 'fail_closed') return state === 'rejected_fail_closed';
  if (policy === 'manual_hold') return state === 'manual_hold';
  if (policy === 'degrade_to_signature_only_alpha') return state === 'degraded_signature_only_alpha';
  return false;
}

function validateProductionSignature(
  signature: SignatureDescriptor,
  subjectId: string,
  line: number | undefined,
  prefix: string,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (signature.algorithm !== 'ed25519') {
    issues.push(issue('error', `${prefix}.signature_algorithm_not_locally_verified`, 'production doctor requires a locally verifiable Ed25519 signature', { subjectId, line }));
  }
  if (signature.signature === undefined || signature.signature.trim() === '') {
    issues.push(issue('error', `${prefix}.signature_value_missing`, 'signed object is missing signature bytes', { subjectId, line }));
  }
  if (signature.publicKeyRef === undefined || signature.publicKeyRef.trim() === '') {
    issues.push(issue('error', `${prefix}.signature_public_key_missing`, 'signed object is missing publicKeyRef', { subjectId, line }));
  }
  if (signature.trustLevel !== 'registry_verified' && signature.trustLevel !== 'operator_bound') {
    issues.push(issue('error', `${prefix}.signature_identity_not_registry_verified`, 'production doctor requires a registry-verified or operator-bound signing identity', { subjectId, line }));
  }
  issues.push(...validateSignatureLifecycle(signature, subjectId, line, prefix, 'production'));
  return issues;
}

function validateSignatureLifecycle(
  signature: SignatureDescriptor,
  subjectId: string,
  line: number | undefined,
  prefix: string,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const lifecycleRequired = signature.trustLevel === 'operator_bound'
    || signature.trustLevel === 'registry_verified';
  if (!lifecycleRequired) return issues;
  if (!nonEmpty(signature.keyId)) {
    issues.push(profileIssue(profile, `${prefix}.signature_key_id_missing`, 'operator-bound signatures must include keyId', { subjectId, line }));
  }
  if (!nonEmpty(signature.issuedAt) || Number.isNaN(Date.parse(signature.issuedAt))) {
    issues.push(profileIssue(profile, `${prefix}.signature_issued_at_invalid`, 'operator-bound signatures must include a valid issuedAt timestamp', { subjectId, line }));
  }
  if (!nonEmpty(signature.expiresAt) || Number.isNaN(Date.parse(signature.expiresAt))) {
    issues.push(profileIssue(profile, `${prefix}.signature_expires_at_invalid`, 'operator-bound signatures must include a valid expiresAt timestamp', { subjectId, line }));
  } else if (Date.parse(signature.expiresAt) <= Date.now()) {
    issues.push(issue('error', `${prefix}.signature_expired`, 'signature key is expired', { subjectId, line }));
  }
  if (!nonEmpty(signature.revocationListRef)) {
    issues.push(profileIssue(profile, `${prefix}.signature_revocation_ref_missing`, 'operator-bound signatures must reference a revocation list or key registry policy', { subjectId, line }));
  } else {
    issues.push(...validateSignatureRevocationStatus(signature, subjectId, line, prefix, profile));
  }
  return issues;
}

function validateSignatureRevocationStatus(
  signature: SignatureDescriptor,
  subjectId: string,
  line: number | undefined,
  prefix: string,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  if (!nonEmpty(signature.keyId) || !nonEmpty(signature.revocationListRef)) return [];
  if (!signature.revocationListRef.startsWith('file://')) return [];
  try {
    const parsed = JSON.parse(readFileSync(fileURLToPath(signature.revocationListRef), 'utf8')) as unknown;
    const revokedKeyIds = revokedKeyIdsFromRevocationList(parsed);
    if (revokedKeyIds.has(signature.keyId)) {
      return [issue('error', `${prefix}.signature_key_revoked`, 'signature key is listed in the referenced revocation list', { subjectId, line })];
    }
    return [];
  } catch (error) {
    return [profileIssue(profile, `${prefix}.signature_revocation_ref_invalid`, `signature revocationListRef could not be verified: ${error instanceof Error ? error.message : String(error)}`, { subjectId, line })];
  }
}

function revokedKeyIdsFromRevocationList(value: unknown): ReadonlySet<string> {
  if (Array.isArray(value)) {
    return new Set(value.filter((entry): entry is string => nonEmpty(entry)));
  }
  if (value !== null && typeof value === 'object') {
    const record = value as {
      readonly revokedKeyIds?: unknown;
      readonly revoked_key_ids?: unknown;
      readonly revoked?: unknown;
    };
    for (const field of [record.revokedKeyIds, record.revoked_key_ids, record.revoked]) {
      if (Array.isArray(field)) {
        return new Set(field.filter((entry): entry is string => nonEmpty(entry)));
      }
    }
  }
  return new Set();
}

function profileIssue(
  profile: ProtocolDoctorProfile,
  code: string,
  message: string,
  extras: { readonly subjectId?: string | undefined; readonly line?: number | undefined } = {},
): VerificationIssue {
  return issue(profile === 'production' ? 'error' : 'warning', code, message, extras);
}

function applyProfileToIssue(
  entry: VerificationIssue,
  profile: ProtocolDoctorProfile,
): VerificationIssue {
  if (profile !== 'production' || entry.severity !== 'warning') return entry;
  if (
    entry.code === 'receipt.evidence_missing'
    || entry.code === 'receipt.signature_not_signed'
    || entry.code === 'protocol.signature_not_signed'
  ) {
    return { ...entry, severity: 'error' };
  }
  return entry;
}

function isProductionBlockingProofOrSignatureIssue(
  code: string,
  subject: BcrxSubjectFields,
): boolean {
  if (code.startsWith('signature.')) return true;
  return proofRequired(subject) && code.startsWith('zk.');
}

function proofRequired(subject: BcrxSubjectFields): boolean {
  return subject.proofPolicy?.required === true && subject.proofPolicy.minProofs > 0;
}

function zkIsProductionProved(zkSnark: ZkSnarkDescriptor): boolean {
  return zkSnark.mode === 'external_snark'
    && zkSnark.backend === 'external'
    && zkSnark.status === 'proved'
    && nonEmpty(zkSnark.publicInputsHash)
    && nonEmpty(zkSnark.proofHash)
    && nonEmpty(zkSnark.verifierRef)
    && validIsoTimestamp(zkSnark.provedAt)
    && validIsoTimestamp(zkSnark.expiresAt)
    && Date.parse(zkSnark.expiresAt) > Date.now()
    && typeof zkSnark.latencyMs === 'number'
    && Number.isFinite(zkSnark.latencyMs)
    && zkSnark.latencyMs >= 0
    && typeof zkSnark.maxLatencyMs === 'number'
    && Number.isFinite(zkSnark.maxLatencyMs)
    && zkSnark.maxLatencyMs >= 0
    && zkSnark.latencyMs <= zkSnark.maxLatencyMs
    && (zkSnark.failurePolicy === 'fail_closed' || zkSnark.failurePolicy === 'manual_hold')
    && (zkSnark.failureState === undefined || zkSnark.failureState === 'none');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !Number.isNaN(Date.parse(value));
}

function validateMessage(
  message: MessageEnvelopeV2,
  line: number,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [...validateScopeRef(message.scope)];
  if (message.protocolVersion !== '2.0') {
    issues.push(issue('error', 'protocol.version_invalid', 'message protocolVersion must be 2.0', {
      subjectId: message.messageId,
      line,
    }));
  }
  if (message.messageId.trim() === '') {
    issues.push(issue('error', 'protocol.message_id_missing', 'messageId must be non-empty', {
      line,
    }));
  }
  if (message.recipients.length === 0) {
    issues.push(issue('error', 'protocol.recipient_missing', 'message has no recipients', {
      subjectId: message.messageId,
      line,
    }));
  }
  if (message.idempotencyKey.trim() === '') {
    issues.push(issue('error', 'protocol.idempotency_key_missing', 'idempotencyKey must be non-empty', {
      subjectId: message.messageId,
      line,
    }));
  }
  if (!validIsoTimestamp(message.createdAt)) {
    issues.push(issue('error', 'protocol.created_at_invalid', 'message createdAt must be a parseable timestamp', {
      subjectId: message.messageId,
      line,
    }));
  }
  if (message.deadline !== undefined && !validIsoTimestamp(message.deadline)) {
    issues.push(issue('error', 'protocol.deadline_invalid', 'message deadline must be a parseable timestamp', {
      subjectId: message.messageId,
      line,
    }));
  }
  const expectedMessageId = stableId('env', coreMessageIdentityBase(message));
  if (message.messageId !== expectedMessageId) {
    issues.push(issue('error', 'protocol.message_id_mismatch', 'messageId does not match canonical bus envelope payload', {
      subjectId: message.messageId,
      line,
    }));
  }
  if (message.privacyZone !== message.scope.privacyZone) {
    issues.push(issue('error', 'protocol.privacy_scope_mismatch', 'message privacyZone must match scope privacyZone', {
      subjectId: message.messageId,
      line,
    }));
  }
  if (message.visibility !== message.scope.visibility) {
    issues.push(issue('error', 'protocol.visibility_scope_mismatch', 'message visibility must match scope visibility', {
      subjectId: message.messageId,
      line,
    }));
  }
  if (message.signature.status !== 'signed') {
    issues.push(profileIssue(profile, 'protocol.signature_not_signed', 'message is not cryptographically signed', {
      subjectId: message.messageId,
      line,
    }));
  } else {
    issues.push(...validateLocalIntegritySignature({
      signature: message.signature,
      expectedPayload: coreMessageIdentityBase(message),
      prefix: 'protocol',
      subjectId: message.messageId,
      line,
      profile,
    }));
  }
  return issues;
}

function validateCoreReceipt(
  receipt: ReceiptV2,
  line: number,
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const evidenceRefs = receipt.evidenceRefs as unknown;
  if (!validIsoTimestamp(receipt.issuedAt)) {
    issues.push(issue('error', 'receipt.issued_at_invalid', 'receipt issuedAt must be a parseable timestamp', {
      subjectId: receipt.receiptId,
      line,
    }));
  }
  if (!Array.isArray(evidenceRefs)) {
    issues.push(issue('error', 'receipt.evidence_refs_invalid', 'receipt evidenceRefs must be an array', {
      subjectId: receipt.receiptId,
      line,
    }));
  } else {
    evidenceRefs.forEach((ref, index) => {
      issues.push(...validateEvidenceRef(ref, {
        prefix: 'receipt',
        ownerId: receipt.receiptId,
        line,
        index,
        profile,
      }));
    });
  }
  if (receipt.signature.status === 'signed') {
    issues.push(...validateLocalIntegritySignature({
      signature: receipt.signature,
      expectedPayload: coreReceiptSignaturePayload(receipt),
      prefix: 'receipt',
      subjectId: receipt.receiptId,
      line,
      profile,
    }));
  }
  return issues;
}

function validateCoreReplay(
  messages: readonly MessageEnvelopeV2[],
  receipts: readonly ReceiptV2[],
  profile: ProtocolDoctorProfile,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const messageIds = new Map<string, number>();
  const idempotencyKeys = new Map<string, { readonly messageId: string; readonly line: number }>();
  messages.forEach((message, index) => {
    const line = index + 1;
    const firstLine = messageIds.get(message.messageId);
    if (firstLine !== undefined) {
      issues.push(issue('error', 'protocol.message_duplicate_id', 'duplicate messageId in bus envelope set', {
        subjectId: message.messageId,
        line,
      }));
    }
    messageIds.set(message.messageId, line);
    const prior = idempotencyKeys.get(message.idempotencyKey);
    if (prior !== undefined && prior.messageId !== message.messageId) {
      issues.push(profileIssue(profile, 'protocol.idempotency_replay', 'same idempotencyKey is bound to more than one messageId', {
        subjectId: message.messageId,
        line,
      }));
      return;
    }
    idempotencyKeys.set(message.idempotencyKey, { messageId: message.messageId, line });
  });

  const semanticReceipts = new Map<string, { readonly receiptId: string; readonly line: number }>();
  receipts.forEach((receipt, index) => {
    const line = index + 1;
    const key = [
      receipt.subjectId,
      receipt.kind,
      receipt.issuer.agentId,
      receipt.recipient?.agentId ?? '',
    ].join('\0');
    const prior = semanticReceipts.get(key);
    if (prior !== undefined && prior.receiptId !== receipt.receiptId) {
      issues.push(profileIssue(profile, 'receipt.semantic_replay', 'same receipt kind/subject/issuer/recipient appears with multiple receiptIds', {
        subjectId: receipt.receiptId,
        line,
      }));
      return;
    }
    semanticReceipts.set(key, { receiptId: receipt.receiptId, line });
  });
  return issues;
}

function validateEvidenceRef(
  ref: unknown,
  args: {
    readonly prefix: string;
    readonly ownerId: string;
    readonly line: number | undefined;
    readonly index: number;
    readonly profile: ProtocolDoctorProfile;
  },
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
    issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_schema_invalid`, 'evidenceRef must be an object', {
      subjectId: args.ownerId,
      line: args.line,
    }));
    return issues;
  }
  const evidence = ref as Partial<EvidenceRef>;
  if (!nonEmpty(evidence.evidenceId)) {
    issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_id_missing`, 'evidenceRef.evidenceId must be non-empty', {
      subjectId: args.ownerId,
      line: args.line,
    }));
  }
  if (typeof evidence.kind !== 'string' || !EVIDENCE_KINDS.has(evidence.kind)) {
    issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_kind_invalid`, 'evidenceRef.kind is not a supported evidence kind', {
      subjectId: args.ownerId,
      line: args.line,
    }));
  }
  if (!nonEmpty(evidence.uri)) {
    issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_uri_missing`, 'evidenceRef.uri must be non-empty', {
      subjectId: args.ownerId,
      line: args.line,
    }));
  }
  if (evidence.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(evidence.sha256)) {
    issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_sha256_invalid`, 'evidenceRef.sha256 must be lowercase sha256 hex', {
      subjectId: args.ownerId,
      line: args.line,
    }));
  }
  if (
    evidence.producedBy === undefined
    || typeof evidence.producedBy !== 'object'
    || !nonEmpty((evidence.producedBy as Partial<EvidenceRef['producedBy']>).agentId)
  ) {
    issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_producer_missing`, 'evidenceRef.producedBy.agentId must be non-empty', {
      subjectId: args.ownerId,
      line: args.line,
    }));
  }
  if (!nonEmpty(evidence.observedAt) || Number.isNaN(Date.parse(evidence.observedAt))) {
    issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_observed_at_invalid`, 'evidenceRef.observedAt must be a parseable timestamp', {
      subjectId: args.ownerId,
      line: args.line,
    }));
  }
  if (
    evidence.kind === 'receipt'
    && typeof evidence.uri === 'string'
    && evidence.uri.startsWith('bus://')
  ) {
    if (evidence.sha256 === undefined) {
      issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_sha256_missing`, 'bus receipt evidenceRef must include a content hash', {
        subjectId: args.ownerId,
        line: args.line,
      }));
    }
    const expectedId = stableId('evidence', {
      kind: 'receipt',
      uri: evidence.uri,
      sha256: evidence.sha256 ?? null,
      observedAt: evidence.observedAt ?? null,
    });
    if (evidence.evidenceId !== expectedId) {
      issues.push(profileIssue(args.profile, `${args.prefix}.evidence_ref_id_mismatch`, 'bus receipt evidenceId does not match canonical evidenceRef payload', {
        subjectId: args.ownerId,
        line: args.line,
      }));
    }
  }
  if (args.index > 0 && args.profile === 'production') {
    issues.push(issue('info', `${args.prefix}.evidence_ref_multiple`, 'receipt carries multiple evidenceRefs; production doctor checked each ref independently', {
      subjectId: args.ownerId,
      line: args.line,
    }));
  }
  return issues;
}

function validateLocalIntegritySignature(args: {
  readonly signature: SignatureStatus;
  readonly expectedPayload: unknown;
  readonly prefix: string;
  readonly subjectId: string;
  readonly line: number | undefined;
  readonly profile: ProtocolDoctorProfile;
}): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (args.signature.algorithm !== 'sha256-local-integrity') {
    issues.push(profileIssue(args.profile, `${args.prefix}.signature_algorithm_not_locally_verified`, 'local JSONL bus signature algorithm is not verified by this doctor', {
      subjectId: args.subjectId,
      line: args.line,
    }));
    return issues;
  }
  if (!nonEmpty(args.signature.publicKeyRef)) {
    issues.push(issue('error', `${args.prefix}.signature_public_key_missing`, 'local integrity signature is missing publicKeyRef', {
      subjectId: args.subjectId,
      line: args.line,
    }));
  }
  const expectedSignature = `sha256:${sha256Hex(stableStringify(args.expectedPayload))}`;
  if (args.signature.signature !== expectedSignature) {
    issues.push(issue('error', `${args.prefix}.signature_hash_mismatch`, 'local integrity signature hash does not match canonical payload', {
      subjectId: args.subjectId,
      line: args.line,
    }));
  }
  if (args.profile === 'production') {
    issues.push(issue('warning', `${args.prefix}.signature_local_integrity_only`, 'local integrity signature is tamper-evident but not a registry identity proof', {
      subjectId: args.subjectId,
      line: args.line,
    }));
  }
  return issues;
}

function coreMessageIdentityBase(message: MessageEnvelopeV2): Record<string, unknown> {
  return {
    protocolVersion: '2.0',
    threadId: message.threadId,
    correlationId: message.correlationId ?? null,
    causationId: message.causationId ?? null,
    runId: message.scope.runId,
    scope: message.scope,
    tenantId: message.scope.tenantId ?? null,
    taskRef: message.taskRef ?? null,
    createdAt: message.createdAt,
    privacyZone: message.scope.privacyZone,
    visibility: message.scope.visibility,
    sender: message.sender,
    recipients: message.recipients,
    intent: message.intent,
    body: message.body,
    requiredReceipts: message.requiredReceipts,
    deadline: message.deadline ?? null,
    idempotencyKey: message.idempotencyKey,
  };
}

function coreReceiptSignaturePayload(receipt: ReceiptV2): Record<string, unknown> {
  return {
    kind: receipt.kind,
    subjectId: receipt.subjectId,
    issuer: receipt.issuer,
    recipient: receipt.recipient ?? null,
    previousReceiptId: receipt.previousReceiptId ?? null,
    issuedAt: receipt.issuedAt,
    evidenceRefs: receipt.evidenceRefs,
  };
}

function groupReceiptsBySubject(receipts: readonly ReceiptV2[]): Map<string, readonly ReceiptV2[]> {
  const grouped = new Map<string, ReceiptV2[]>();
  for (const receipt of receipts) {
    const entries = grouped.get(receipt.subjectId) ?? [];
    entries.push(receipt);
    grouped.set(receipt.subjectId, entries);
  }
  return grouped;
}

function isTerminalReceipt(kind: ReceiptKind): boolean {
  return ['completed', 'failed', 'rejected', 'challenged', 'verified', 'proof_unavailable'].includes(kind);
}
