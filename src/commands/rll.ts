import { existsSync, readFileSync } from 'node:fs';
import { appendLedgerEntry, ledgerStats } from '../lib/protocol/ledger.js';
import { loadConfig } from '../lib/config.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import {
  doctorRllSidecars,
} from '../lib/rll/doctor.js';
import type {
  ProtocolDoctorAuditMode,
  ProtocolDoctorProfile,
} from '../lib/protocol/doctor.js';
import { sidecarPathsForRunDir } from '../lib/protocol/sidecar.js';
import type { BcrxSubjectFields } from '../lib/protocol/types.js';
import {
  createRllControlSignal,
  createRllEvent,
  createRsiCandidate,
  deriveControlSignals,
  readRllEvents,
  upsertRsiCandidate,
} from '../lib/rll/ledger.js';
import type { RllEventKind } from '../lib/rll/types.js';

export interface RllStatusCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface RllEmitCommandArgs {
  readonly runDir: string;
  readonly kind: RllEventKind;
  readonly subject?: string;
  readonly summary: string;
  readonly source?: string;
  readonly inputRefs?: readonly string[];
  readonly outputRefs?: readonly string[];
  readonly confidence?: number;
  readonly json?: boolean;
}

export interface RllSignalsCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface RllDoctorCommandArgs {
  readonly runDir: string;
  readonly auditMode?: ProtocolDoctorAuditMode;
  readonly profile?: ProtocolDoctorProfile;
  readonly json?: boolean;
}

export interface RsiCandidateCommandArgs {
  readonly runDir: string;
  readonly subject?: string;
  readonly hypothesis: string;
  readonly expectedBenefit: string;
  readonly risk: string;
  readonly evidenceRefs?: readonly string[];
  readonly json?: boolean;
}

export async function rllStatusCommand(args: RllStatusCommandArgs): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const payload = {
    rll: ledgerStats(files.rllFile),
    rsiCandidates: readRsiCount(files.rsiIndexFile),
  };
  writeOutput(payload, args.json === true);
  return 0;
}

export async function rllEmitCommand(args: RllEmitCommandArgs): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const event = createRllEvent({
    kind: args.kind,
    subject: parseSubject(args.subject),
    source: args.source ?? 'harness.rll.cli',
    summary: args.summary,
    inputRefs: args.inputRefs ?? [],
    outputRefs: args.outputRefs ?? [],
    metrics: {},
    ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
  });
  const appended = appendLedgerEntry(files.rllFile, event as unknown as Record<string, unknown>);
  writeOutput({
    eventId: event.eventId,
    lineHash: appended.lineHash,
  }, args.json === true);
  return 0;
}

export async function rllSignalsCommand(args: RllSignalsCommandArgs): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const events = readRllEvents(files.rllFile);
  const signals = deriveControlSignals(events);
  for (const signal of signals) {
    appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);
  }
  writeOutput({ signals }, args.json === true);
  return signals.length === 0 ? 1 : 0;
}

export async function rllDoctorCommand(args: RllDoctorCommandArgs): Promise<number> {
  const report = doctorRllSidecars({
    runDir: args.runDir,
    auditMode: args.auditMode ?? 'tip',
    profile: args.profile ?? 'alpha',
    oscillationPolicy: loadConfig(resolveHarnessPaths()).rll.feedbackOscillation,
  });
  writeOutput(report, args.json === true);
  return report.ok ? 0 : 1;
}

export async function rsiCandidateCommand(args: RsiCandidateCommandArgs): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const candidate = createRsiCandidate({
    subject: parseSubject(args.subject),
    hypothesis: args.hypothesis,
    expectedBenefit: args.expectedBenefit,
    risk: args.risk,
    requiredEvidenceRefs: args.evidenceRefs ?? [],
  });
  upsertRsiCandidate(files.rsiIndexFile, candidate);
  const signal = createRllControlSignal({
    action: 'expand_scope',
    subject: candidate.subject,
    reason: `RSI candidate recorded: ${candidate.hypothesis}`,
    strength: 0.5,
    evidenceRefs: candidate.requiredEvidenceRefs,
  });
  appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);
  writeOutput({
    candidateId: candidate.candidateId,
    signalId: signal.signalId,
  }, args.json === true);
  return 0;
}

function parseSubject(raw: string | undefined): BcrxSubjectFields {
  if (raw === undefined) {
    return {
      subjectId: 'manual:rll-cli',
      subjectType: 'task',
      title: 'manual RLL event',
      assuranceContext: 'alpha',
      privacyZone: 'WORKSPACE',
      materiality: 'medium',
    };
  }
  return JSON.parse(raw) as BcrxSubjectFields;
}

function readRsiCount(file: string): number {
  if (!existsSync(file)) return 0;
  const raw = readFileSync(file, 'utf8').trim();
  if (raw.length === 0) return 0;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.length : 0;
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
