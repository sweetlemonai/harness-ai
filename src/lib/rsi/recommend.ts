import { appendLedgerEntry, readLedgerEntries } from '../protocol/ledger.js';
import { sidecarPathsForRunDir } from '../protocol/sidecar.js';
import type { EvidenceReceipt } from '../evidence/types.js';
import {
  createRllEvent,
  createRsiCandidate,
  readRsiIndex,
  upsertRsiCandidate,
} from '../rll/ledger.js';
import type {
  RllControlAction,
  RllControlSignal,
  RllEvent,
  RsiCandidate,
} from '../rll/types.js';

export interface RsiRecommendationResult {
  readonly runDir: string;
  readonly candidates: readonly RsiCandidate[];
  readonly rllEventIds: readonly string[];
  readonly skippedSignals: readonly SkippedRsiSignal[];
  readonly signalsConsumed: number;
  readonly duplicatesCollapsed: number;
}

export interface SkippedRsiSignal {
  readonly signalId: string;
  readonly action: RllControlAction;
  readonly reason: string;
}

export function recommendRsiCandidates(args: {
  readonly runDir: string;
  readonly source?: string;
}): RsiRecommendationResult {
  const files = sidecarPathsForRunDir(args.runDir);
  const signals = readLedgerEntries<RllControlSignal>(files.agentopsEventsFile)
    .filter(isRllControlSignal);
  const evidenceIds = new Set(
    readLedgerEntries<EvidenceReceipt>(files.evidenceFile).map((entry) => entry.evidenceId),
  );
  const before = readRsiIndex(files.rsiIndexFile);
  const candidates: RsiCandidate[] = [];
  const rllEventIds: string[] = [];
  const skippedSignals: SkippedRsiSignal[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    const evidenceProblem = evidenceProblemForSignal(signal, evidenceIds);
    if (evidenceProblem !== null) {
      skippedSignals.push({
        signalId: signal.signalId,
        action: signal.action,
        reason: evidenceProblem,
      });
      const event = createRllEvent({
        kind: 'failure',
        subject: signal.subject,
        source: args.source ?? 'harness.rsi.recommend',
        summary: `RSI signal skipped: ${evidenceProblem}`,
        inputRefs: [signal.signalId, ...signal.evidenceRefs],
        outputRefs: [],
        metrics: {
          skippedSignal: 1,
          missingEvidence: 1,
        },
        confidence: 1,
      });
      const appended = appendLedgerEntry(files.rllFile, event as unknown as Record<string, unknown>)
        .entry as unknown as RllEvent;
      rllEventIds.push(appended.eventId);
      continue;
    }
    const candidate = candidateFromSignal(signal);
    if (seen.has(candidate.candidateId)) continue;
    seen.add(candidate.candidateId);
    const upserted = upsertRsiCandidate(files.rsiIndexFile, candidate);
    candidates.push(upserted);
    const event = createRllEvent({
      kind: 'rsi_candidate',
      subject: signal.subject,
      source: args.source ?? 'harness.rsi.recommend',
      summary: `RSI recommendation from ${signal.action}: ${candidate.hypothesis}`,
      inputRefs: [signal.signalId, ...signal.evidenceRefs],
      outputRefs: [candidate.candidateId],
      metrics: {
        signalStrength: signal.strength,
      },
      confidence: signal.strength,
    });
    const appended = appendLedgerEntry(files.rllFile, event as unknown as Record<string, unknown>)
      .entry as unknown as RllEvent;
    rllEventIds.push(appended.eventId);
  }
  const after = readRsiIndex(files.rsiIndexFile);
  return {
    runDir: files.runDir,
    candidates,
    rllEventIds,
    skippedSignals,
    signalsConsumed: signals.length,
    duplicatesCollapsed: Math.max(0, candidates.length - Math.max(0, after.length - before.length)),
  };
}

function evidenceProblemForSignal(
  signal: RllControlSignal,
  evidenceIds: ReadonlySet<string>,
): string | null {
  if (signal.evidenceRefs.length === 0) {
    return 'control signal has no evidence refs';
  }
  const missing = signal.evidenceRefs.filter((ref) => !evidenceIds.has(ref));
  if (missing.length > 0) {
    return `control signal references missing evidence refs: ${missing.join(', ')}`;
  }
  return null;
}

function candidateFromSignal(signal: RllControlSignal): RsiCandidate {
  const policy = policyForAction(signal.action);
  return createRsiCandidate({
    subject: signal.subject,
    hypothesis: policy.hypothesis(signal.reason),
    expectedBenefit: policy.expectedBenefit,
    risk: policy.risk,
    requiredEvidenceRefs: signal.evidenceRefs,
  });
}

function policyForAction(action: RllControlAction): {
  readonly hypothesis: (reason: string) => string;
  readonly expectedBenefit: string;
  readonly risk: string;
} {
  switch (action) {
    case 'repair_adapter':
      return {
        hypothesis: (reason) => `Repair or replace the failing adapter before relying on downstream results: ${reason}`,
        expectedBenefit: 'Restores trustworthy agent invocation and prevents silent capability loss.',
        risk: 'Adapter repair may mask a provider outage unless the fix is verified against fresh endpoint evidence.',
      };
    case 'request_dissent':
      return {
        hypothesis: (reason) => `Request independent adversarial review before promotion: ${reason}`,
        expectedBenefit: 'Reduces groupthink and catches material flaws before the task advances.',
        risk: 'Additional review may slow interactive work; scope the dissent prompt to the material claim.',
      };
    case 'gather_more_evidence':
      return {
        hypothesis: (reason) => `Gather missing evidence before treating the claim as actionable: ${reason}`,
        expectedBenefit: 'Prevents unsupported inferences from becoming task direction.',
        risk: 'Evidence gathering can sprawl unless tied to a disconfirming condition.',
      };
    case 'refresh_codegraph':
      return {
        hypothesis: (reason) => `Refresh code intelligence before broad code edits: ${reason}`,
        expectedBenefit: 'Improves impact analysis and test selection for long coding runs.',
        risk: 'A stale or partial graph remains orienting evidence only; direct source checks may still be required.',
      };
    case 'route_to_local':
      return {
        hypothesis: (reason) => `Route the next step to a local model lane: ${reason}`,
        expectedBenefit: 'Keeps sensitive or high-context work on owned compute while preserving latency control.',
        risk: 'Local queue, thermal headroom, or model specialization may make the lane slower than expected.',
      };
    case 'route_to_frontier':
      return {
        hypothesis: (reason) => `Route a privacy-cleared subtask to a frontier model: ${reason}`,
        expectedBenefit: 'Uses stronger general reasoning when privacy and policy allow it.',
        risk: 'Hosted routing requires privacy preflight and must not leak mission gist or hidden reasoning.',
      };
    case 'narrow_scope':
      return {
        hypothesis: (reason) => `Narrow the active task scope before continuing: ${reason}`,
        expectedBenefit: 'Improves verifiability and reduces runaway context or ambiguous ownership.',
        risk: 'Over-narrowing can miss cross-module dependencies unless codegraph and evidence refs are checked.',
      };
    case 'expand_scope':
      return {
        hypothesis: (reason) => `Expand the task graph to include newly discovered work: ${reason}`,
        expectedBenefit: 'Keeps live task evolution tied to observed failures, dissent, or evidence gaps.',
        risk: 'Expansion must remain recommend-only in alpha and needs operator review before mutation.',
      };
    case 'pause_for_human':
      return {
        hypothesis: (reason) => `Pause for an operator gate before proceeding: ${reason}`,
        expectedBenefit: 'Prevents automated action where policy, privacy, or safety requires human authority.',
        risk: 'Work may stall if the gate lacks a concrete question and evidence bundle.',
      };
  }
}

function isRllControlSignal(value: unknown): value is RllControlSignal {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as {
    readonly schemaVersion?: unknown;
    readonly signalId?: unknown;
    readonly action?: unknown;
  };
  return candidate.schemaVersion === 'superharness.rll.control_signal.v2'
    && typeof candidate.signalId === 'string'
    && typeof candidate.action === 'string';
}
