import { existsSync, readFileSync } from 'node:fs';
import type { EvidenceReceipt } from '../evidence/types.js';
import {
  doctorProtocolSidecars,
  type ProtocolDoctorAuditMode,
  type ProtocolDoctorProfile,
  type ProtocolSidecarDoctorReport,
} from '../protocol/doctor.js';
import { readLedgerEntries } from '../protocol/ledger.js';
import { sidecarPathsForRunDir } from '../protocol/sidecar.js';
import { createVerificationReport, issue } from '../protocol/verify.js';
import { stableId } from '../protocol/hash.js';
import {
  deriveControlSignals,
  readRsiIndex,
} from './ledger.js';
import type {
  RllControlSignal,
  RllEvent,
  RsiCandidate,
} from './types.js';
import type {
  VerificationIssue,
  VerificationReport,
} from '../../types.js';

export interface RllDoctorInput {
  readonly runDir: string;
  readonly auditMode?: ProtocolDoctorAuditMode;
  readonly now?: Date;
  readonly profile?: ProtocolDoctorProfile;
  readonly oscillationPolicy?: RllOscillationPolicy;
}

export interface RllOscillationPolicy {
  readonly minAlternations: number;
  readonly windowMs: number;
  readonly minStrength: number;
}

export const DEFAULT_RLL_OSCILLATION_POLICY: RllOscillationPolicy = {
  minAlternations: 2,
  windowMs: 300_000,
  minStrength: 0.7,
};

export interface RllDoctorReport {
  readonly ok: boolean;
  readonly runDir: string;
  readonly checkedAt: string;
  readonly auditMode: ProtocolDoctorAuditMode;
  readonly profile: ProtocolDoctorProfile;
  readonly sidecars: ProtocolSidecarDoctorReport;
  readonly counts: {
    readonly rllEvents: number | null;
    readonly controlSignals: number | null;
    readonly rsiCandidates: number;
    readonly recommendedSignals: number;
    readonly missingProjectedSignals: number;
    readonly feedbackOscillations: number;
  };
  readonly recommendedSignals: readonly RllControlSignal[];
  readonly missingProjectedSignals: readonly RllControlSignal[];
  readonly report: VerificationReport;
}

export function doctorRllSidecars(input: RllDoctorInput): RllDoctorReport {
  const auditMode = input.auditMode ?? 'tip';
  const profile = input.profile ?? 'alpha';
  const checkedAt = (input.now ?? new Date()).toISOString();
  const files = sidecarPathsForRunDir(input.runDir);
  const sidecars = doctorProtocolSidecars({
    runDir: input.runDir,
    auditMode,
    profile,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const issues: VerificationIssue[] = [
    ...sidecars.ledgers.rll.issues,
    ...sidecars.ledgers.agentops.issues,
    ...sidecars.rsiIndex.issues,
  ];
  let rllEvents: RllEvent[] | null = null;
  let controlSignals: RllControlSignal[] | null = null;
  let recommendedSignals: RllControlSignal[] = [];
  let missingProjectedSignals: RllControlSignal[] = [];
  let feedbackOscillations: readonly VerificationIssue[] = [];

  if (auditMode === 'full') {
    rllEvents = readLedgerEntries<RllEvent>(files.rllFile)
      .filter((entry) => entry.schemaVersion === 'superharness.rll.event.v2');
    controlSignals = readLedgerEntries<RllControlSignal>(files.agentopsEventsFile)
      .filter((entry) => entry.schemaVersion === 'superharness.rll.control_signal.v2');
    recommendedSignals = deriveControlSignals(rllEvents);
    const projectedIds = new Set(controlSignals.map((signal) => signal.signalId));
    missingProjectedSignals = recommendedSignals.filter((signal) => !projectedIds.has(signal.signalId));
    for (const signal of missingProjectedSignals) {
      issues.push(issue('warning', 'rll_projection.signal_not_projected', 'derived RLL control signal has not been projected to AgentOps', {
        subjectId: signal.signalId,
      }));
    }
    feedbackOscillations = validateFeedbackOscillation(
      controlSignals,
      profile,
      input.oscillationPolicy ?? DEFAULT_RLL_OSCILLATION_POLICY,
    );
    issues.push(...feedbackOscillations);
    issues.push(...validateRsiCandidateEvidence(
      files.evidenceFile,
      files.rsiIndexFile,
      readRsiIndex(files.rsiIndexFile),
    ));
  } else {
    issues.push(issue('info', 'rll_doctor.tip_scope', 'tip audit validates RLL/AgentOps tails; use --audit full for deterministic signal projection and RSI evidence checks'));
  }

  const report = createVerificationReport({
    subject: files.runDir,
    issues,
    checkedAt,
    headHash: [
      sidecars.ledgers.rll.tipHash,
      sidecars.ledgers.agentops.tipHash,
    ].filter((value) => value !== null).join(':') || undefined,
  });
  const rsiCandidates = readRsiIndex(files.rsiIndexFile);
  return {
    ok: report.ok,
    runDir: files.runDir,
    checkedAt,
    auditMode,
    profile,
    sidecars,
    counts: {
      rllEvents: rllEvents === null ? null : rllEvents.length,
      controlSignals: controlSignals === null ? null : controlSignals.length,
      rsiCandidates: rsiCandidates.length,
      recommendedSignals: recommendedSignals.length,
      missingProjectedSignals: missingProjectedSignals.length,
      feedbackOscillations: feedbackOscillations.length,
    },
    recommendedSignals,
    missingProjectedSignals,
    report,
  };
}

function validateFeedbackOscillation(
  signals: readonly RllControlSignal[],
  profile: ProtocolDoctorProfile,
  policy: RllOscillationPolicy,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  for (const [left, right] of OPPOSING_CONTROL_ACTIONS) {
    const grouped = new Map<string, RllControlSignal[]>();
    for (const signal of signals) {
      if (signal.action !== left && signal.action !== right) continue;
      if (signal.strength < policy.minStrength) continue;
      const group = grouped.get(signal.subject.subjectId) ?? [];
      group.push(signal);
      grouped.set(signal.subject.subjectId, group);
    }
    for (const [subjectId, group] of grouped) {
      const ordered = group
        .filter((signal) => !Number.isNaN(Date.parse(signal.createdAt)))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (hasAlternationWindow(ordered, policy)) {
        issues.push(issue(
          profile === 'production' ? 'error' : 'warning',
          'rll_feedback.oscillation_detected',
          `RLL control signals alternate opposing actions for the same subject within ${policy.windowMs}ms: ${left} and ${right}`,
          { subjectId },
        ));
      }
    }
  }
  return issues;
}

function hasAlternationWindow(
  signals: readonly RllControlSignal[],
  policy: RllOscillationPolicy,
): boolean {
  for (let start = 0; start < signals.length; start += 1) {
    let alternations = 0;
    let previous = signals[start]!;
    const windowStart = Date.parse(previous.createdAt);
    for (let index = start + 1; index < signals.length; index += 1) {
      const current = signals[index]!;
      if (Date.parse(current.createdAt) - windowStart > policy.windowMs) break;
      if (current.action !== previous.action) {
        alternations += 1;
        previous = current;
      }
      if (alternations >= policy.minAlternations) return true;
    }
  }
  return false;
}

const OPPOSING_CONTROL_ACTIONS: ReadonlyArray<readonly [RllControlSignal['action'], RllControlSignal['action']]> = [
  ['route_to_local', 'route_to_frontier'],
  ['narrow_scope', 'expand_scope'],
];

function validateRsiCandidateEvidence(
  evidenceFile: string,
  rsiIndexFile: string,
  candidates: readonly RsiCandidate[],
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const evidenceIds = new Set(
    readLedgerEntries<EvidenceReceipt>(evidenceFile).map((entry) => entry.evidenceId),
  );
  const rawCandidates = readRawRsiCandidates(rsiIndexFile);
  for (const candidate of candidates) {
    const expectedId = stableId('rsi', {
      subjectId: candidate.subject.subjectId,
      hypothesis: candidate.hypothesis,
      requiredEvidenceRefs: candidate.requiredEvidenceRefs,
    });
    if (candidate.candidateId !== expectedId) {
      issues.push(issue('error', 'rsi_candidate.id_mismatch', 'RSI candidateId does not match canonical payload', {
        subjectId: candidate.candidateId,
      }));
    }
    for (const ref of candidate.requiredEvidenceRefs) {
      if (!evidenceIds.has(ref)) {
        issues.push(issue('error', 'rsi_candidate.required_evidence_missing', `RSI candidate required evidence ref is missing: ${ref}`, {
          subjectId: candidate.candidateId,
        }));
      }
    }
  }
  for (const raw of rawCandidates) {
    if (raw.status === 'applied') {
      issues.push(issue('error', 'rsi_candidate.applied_disabled_alpha', 'RSI applied status is disabled in alpha', {
        subjectId: typeof raw.candidateId === 'string' ? raw.candidateId : undefined,
      }));
    }
  }
  return issues;
}

function readRawRsiCandidates(file: string): ReadonlyArray<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8').trim();
  if (raw.length === 0) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is Record<string, unknown> =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
}
