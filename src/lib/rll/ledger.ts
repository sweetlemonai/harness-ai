import {
  RLL_EVENT_SCHEMA_VERSION,
  type AgentIdentity,
  type EvidenceRef,
  type PrivacyZone,
  type RLLEvent,
  type RunContext,
  type ScopeRef,
  type VerificationIssue,
  type VerificationReport,
  type Visibility,
} from '../../types.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { stableHash, stableId } from '../protocol/hash.js';
import { appendJsonl, readJsonl } from '../protocol/jsonl.js';
import { appendLedgerEntry, ledgerStats } from '../protocol/ledger.js';
import { validateScopeRef } from '../protocol/scope.js';
import { createVerificationReport, issue } from '../protocol/verify.js';
import type { BcrxSubjectFields } from '../protocol/types.js';
import type {
  RllControlAction,
  RllControlSignal,
  RllEvent as SidecarRllEvent,
  RllEventKind,
  RsiCandidate,
} from './types.js';

export type RLLSubjectType = RLLEvent['subjectType'];

export type RLLAppendEvent = Omit<
  RLLEvent,
  'eventId' | 'schemaVersion' | 'timestamp' | 'prevHash' | 'hash'
> & {
  readonly eventId?: string;
  readonly timestamp?: string;
};

export interface SidecarRllEventInput {
  readonly kind: RllEventKind;
  readonly subject: BcrxSubjectFields;
  readonly source: string;
  readonly summary: string;
  readonly inputRefs?: readonly string[];
  readonly outputRefs?: readonly string[];
  readonly metrics?: Record<string, number>;
  readonly confidence?: number | undefined;
  readonly createdAt?: string;
}

export function createRllEvent(args: RLLAppendEvent, prevHash?: string): RLLEvent;
export function createRllEvent(args: SidecarRllEventInput): SidecarRllEvent;
export function createRllEvent(
  args: RLLAppendEvent | SidecarRllEventInput,
  prevHash?: string,
): RLLEvent | SidecarRllEvent {
  if ('kind' in args) {
    return createSidecarRllEvent(args);
  }
  const timestamp = args.timestamp ?? new Date().toISOString();
  const eventWithoutHash = {
    eventId: args.eventId ?? stableId('rll_event', {
      runId: args.runId,
      nodeId: args.nodeId,
      timestamp,
      eventType: args.eventType,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      prevHash: prevHash ?? null,
    }),
    schemaVersion: RLL_EVENT_SCHEMA_VERSION,
    runId: args.runId,
    ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
    nodeId: args.nodeId,
    ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
    timestamp,
    eventType: args.eventType,
    actor: args.actor,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    payloadSummary: args.payloadSummary,
    ...(args.payloadRef !== undefined ? { payloadRef: args.payloadRef } : {}),
    privacyZone: args.privacyZone,
    scope: args.scope,
    receiptRefs: args.receiptRefs,
    claimRefs: args.claimRefs,
    evidenceRefs: args.evidenceRefs,
    ...(prevHash !== undefined ? { prevHash } : {}),
    visibility: args.visibility,
  };
  return {
    ...eventWithoutHash,
    hash: computeRllEventHash(eventWithoutHash),
  };
}

export function appendRllEvent(path: string, args: RLLAppendEvent): RLLEvent;
export function appendRllEvent(ctx: RunContext, event: SidecarRllEvent): SidecarRllEvent;
export function appendRllEvent(
  target: string | RunContext,
  args: RLLAppendEvent | SidecarRllEvent,
): RLLEvent | SidecarRllEvent {
  if (typeof target !== 'string') {
    const result = appendLedgerEntry(
      target.runPaths.rllFile,
      args as unknown as Record<string, unknown>,
    );
    const entry = result.entry as unknown as SidecarRllEvent;
    target.logger.event('rll_ref', {
      eventId: entry.eventId,
      kind: entry.kind,
      subjectId: entry.subject.subjectId,
      lineHash: result.lineHash,
    });
    return entry;
  }
  const previous = readRllLedger(target).at(-1);
  const event = createRllEvent(args as RLLAppendEvent, previous?.hash);
  appendJsonl(target, event);
  return event;
}

export function readRllLedger(path: string): readonly RLLEvent[] {
  return readJsonl<RLLEvent>(path).map((record) => record.value);
}

export function verifyRllLedger(path: string): VerificationReport {
  const records = readJsonl<RLLEvent>(path);
  const issues: VerificationIssue[] = [];
  let expectedPrev: string | undefined;

  for (const record of records) {
    const event = record.value;
    issues.push(...validateRllEvent(event, record.line));
    if (event.prevHash !== expectedPrev) {
      issues.push(issue('error', 'rll.prev_hash_mismatch', 'RLL prevHash does not match previous event', {
        subjectId: event.eventId,
        line: record.line,
      }));
    }
    const expectedHash = computeRllEventHash(rllEventPayload(event));
    if (event.hash !== expectedHash) {
      issues.push(issue('error', 'rll.hash_mismatch', 'RLL event hash does not match canonical payload', {
        subjectId: event.eventId,
        line: record.line,
      }));
    }
    expectedPrev = event.hash;
  }

  return createVerificationReport({
    subject: path,
    issues,
    ...(records.at(-1)?.value.hash !== undefined ? { headHash: records.at(-1)!.value.hash } : {}),
  });
}

export const doctorRllLedger = verifyRllLedger;

export function computeRllEventHash(event: Omit<RLLEvent, 'hash'>): string {
  return stableHash(event);
}

export function createRllEventDraft(args: {
  readonly runId: string;
  readonly nodeId: string;
  readonly eventType: string;
  readonly actor: AgentIdentity;
  readonly subjectType: RLLSubjectType;
  readonly subjectId: string;
  readonly payloadSummary: string;
  readonly privacyZone: PrivacyZone;
  readonly scope: ScopeRef;
  readonly visibility: Visibility;
  readonly tenantId?: string;
  readonly threadId?: string;
  readonly payloadRef?: EvidenceRef;
  readonly receiptRefs?: readonly string[];
  readonly claimRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly timestamp?: string;
  readonly eventId?: string;
}): RLLAppendEvent {
  return {
    ...(args.eventId !== undefined ? { eventId: args.eventId } : {}),
    runId: args.runId,
    ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
    nodeId: args.nodeId,
    ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
    ...(args.timestamp !== undefined ? { timestamp: args.timestamp } : {}),
    eventType: args.eventType,
    actor: args.actor,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    payloadSummary: args.payloadSummary,
    ...(args.payloadRef !== undefined ? { payloadRef: args.payloadRef } : {}),
    privacyZone: args.privacyZone,
    scope: args.scope,
    receiptRefs: args.receiptRefs ?? [],
    claimRefs: args.claimRefs ?? [],
    evidenceRefs: args.evidenceRefs ?? [],
    visibility: args.visibility,
  };
}

function validateRllEvent(event: RLLEvent, line: number): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (event.schemaVersion !== RLL_EVENT_SCHEMA_VERSION) {
    issues.push(issue('error', 'rll.schema_invalid', 'RLL event schemaVersion is invalid', {
      subjectId: event.eventId,
      line,
    }));
  }
  if (event.eventId.trim() === '') {
    issues.push(issue('error', 'rll.event_id_missing', 'RLL eventId must be non-empty', { line }));
  }
  if (event.runId !== event.scope.runId) {
    issues.push(issue('error', 'rll.scope_run_mismatch', 'RLL event runId must match scope.runId', {
      subjectId: event.eventId,
      line,
    }));
  }
  if (event.privacyZone !== event.scope.privacyZone) {
    issues.push(issue('error', 'rll.scope_privacy_mismatch', 'RLL event privacyZone must match scope privacyZone', {
      subjectId: event.eventId,
      line,
    }));
  }
  if (event.visibility !== event.scope.visibility) {
    issues.push(issue('error', 'rll.scope_visibility_mismatch', 'RLL event visibility must match scope visibility', {
      subjectId: event.eventId,
      line,
    }));
  }
  issues.push(...validateScopeRef(event.scope).map((entry) => ({ ...entry, line: entry.line ?? line })));
  return issues;
}

function rllEventPayload(event: RLLEvent): Omit<RLLEvent, 'hash'> {
  const { hash: _hash, ...payload } = event;
  return payload;
}

export function createRllControlSignal(args: {
  readonly action: RllControlAction;
  readonly subject: BcrxSubjectFields;
  readonly reason: string;
  readonly strength: number;
  readonly sourceEventIds?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly createdAt?: string;
}): RllControlSignal {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const sourceEventIds = args.sourceEventIds ?? [];
  const evidenceRefs = args.evidenceRefs ?? [];
  return {
    signalId: stableId('rll_signal', {
      action: args.action,
      subjectId: args.subject.subjectId,
      reason: args.reason,
      sourceEventIds,
      evidenceRefs,
      createdAt,
    }),
    schemaVersion: 'superharness.rll.control_signal.v2',
    action: args.action,
    subject: args.subject,
    reason: args.reason,
    createdAt,
    strength: clamp01(args.strength),
    sourceEventIds,
    evidenceRefs,
  };
}

export function deriveControlSignals(events: readonly SidecarRllEvent[]): RllControlSignal[] {
  const signals: RllControlSignal[] = [];
  for (const event of events) {
    if (event.kind === 'failure' && event.summary.toLowerCase().includes('adapter')) {
      signals.push(createRllControlSignal({
        action: 'repair_adapter',
        subject: event.subject,
        reason: event.summary,
        strength: 0.9,
        sourceEventIds: [event.eventId],
        evidenceRefs: event.outputRefs,
        createdAt: event.createdAt,
      }));
      continue;
    }
    if (event.kind === 'dissent') {
      signals.push(createRllControlSignal({
        action: 'gather_more_evidence',
        subject: event.subject,
        reason: event.summary,
        strength: 0.7,
        sourceEventIds: [event.eventId],
        evidenceRefs: event.outputRefs,
        createdAt: event.createdAt,
      }));
      continue;
    }
    if (event.kind === 'conflict') {
      signals.push(createRllControlSignal({
        action: 'request_dissent',
        subject: event.subject,
        reason: event.summary,
        strength: 0.8,
        sourceEventIds: [event.eventId],
        evidenceRefs: event.outputRefs,
        createdAt: event.createdAt,
      }));
    }
  }
  return signals;
}

export function readRllEvents(path: string): SidecarRllEvent[] {
  return readJsonl<SidecarRllEvent>(path).map((record) => record.value);
}

export function rllLedgerStats(path: string): {
  readonly entries: number;
  readonly tipHash: string | null;
} {
  return ledgerStats(path);
}

export function createRsiCandidate(args: {
  readonly subject: BcrxSubjectFields;
  readonly hypothesis: string;
  readonly expectedBenefit: string;
  readonly risk: string;
  readonly requiredEvidenceRefs?: readonly string[];
}): RsiCandidate {
  const requiredEvidenceRefs = args.requiredEvidenceRefs ?? [];
  return {
    candidateId: stableId('rsi', {
      subjectId: args.subject.subjectId,
      hypothesis: args.hypothesis,
      requiredEvidenceRefs,
    }),
    subject: args.subject,
    hypothesis: args.hypothesis,
    expectedBenefit: args.expectedBenefit,
    risk: args.risk,
    requiredEvidenceRefs,
  };
}

export function upsertRsiCandidate(path: string, candidate: RsiCandidate): RsiCandidate {
  const existing = readRsiIndex(path).filter(
    (entry) => entry.candidateId !== candidate.candidateId,
  );
  const next = [...existing, candidate].sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
  appendJsonl(`${path}.events.jsonl`, {
    type: 'rsi_candidate_upsert',
    candidateId: candidate.candidateId,
    at: new Date().toISOString(),
  });
  // Keep the primary index as plain JSON for dashboard reads.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return candidate;
}

export function readRsiIndex(path: string): RsiCandidate[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed as RsiCandidate[] : [];
}

function createSidecarRllEvent(args: SidecarRllEventInput): SidecarRllEvent {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const inputRefs = args.inputRefs ?? [];
  const outputRefs = args.outputRefs ?? [];
  const metrics = args.metrics ?? {};
  const base = {
    kind: args.kind,
    subjectId: args.subject.subjectId,
    source: args.source,
    summary: args.summary,
    inputRefs,
    outputRefs,
    metrics,
    createdAt,
  };
  return {
    eventId: stableId('rll', base),
    schemaVersion: 'superharness.rll.event.v2',
    kind: args.kind,
    subject: args.subject,
    createdAt,
    source: args.source,
    summary: args.summary,
    inputRefs,
    outputRefs,
    metrics,
    ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
