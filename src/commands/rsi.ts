import { appendLedgerEntry, readLedgerEntries } from '../lib/protocol/ledger.js';
import { sidecarPathsForRunDir } from '../lib/protocol/sidecar.js';
import {
  deriveControlSignals,
  readRllEvents,
  readRsiIndex,
} from '../lib/rll/ledger.js';
import type { RllControlSignal } from '../lib/rll/types.js';
import { recommendRsiCandidates } from '../lib/rsi/recommend.js';

export interface RsiRecommendCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface RsiRebuildCommandArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export async function rsiRecommendCommand(
  args: RsiRecommendCommandArgs,
): Promise<number> {
  const result = recommendRsiCandidates({
    runDir: args.runDir,
  });
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`RSI recommend: ${result.candidates.length} candidate(s)\n`);
    process.stdout.write(`signals consumed: ${result.signalsConsumed}\n`);
    process.stdout.write(`signals skipped: ${result.skippedSignals.length}\n`);
    process.stdout.write(`duplicates collapsed: ${result.duplicatesCollapsed}\n`);
    for (const candidate of result.candidates) {
      process.stdout.write(`- ${candidate.candidateId}: ${candidate.hypothesis}\n`);
    }
  }
  return result.candidates.length === 0 ? 1 : 0;
}

export async function rsiRebuildCommand(
  args: RsiRebuildCommandArgs,
): Promise<number> {
  const files = sidecarPathsForRunDir(args.runDir);
  const existingSignals = readLedgerEntries<RllControlSignal>(files.agentopsEventsFile);
  const existingIds = new Set(existingSignals.map((entry) => entry.signalId));
  const derivedSignals = deriveControlSignals(readRllEvents(files.rllFile));
  const appendedSignals: RllControlSignal[] = [];
  for (const signal of derivedSignals) {
    if (existingIds.has(signal.signalId)) continue;
    const appended = appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>)
      .entry as unknown as RllControlSignal;
    appendedSignals.push(appended);
    existingIds.add(appended.signalId);
  }
  const recommendation = recommendRsiCandidates({
    runDir: files.runDir,
    source: 'harness.rsi.rebuild',
  });
  const index = readRsiIndex(files.rsiIndexFile);
  const payload = {
    runDir: files.runDir,
    derivedSignals: derivedSignals.length,
    appendedSignals: appendedSignals.length,
    existingSignals: existingSignals.length,
    candidates: index,
    recommendation,
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`RSI rebuild: ${index.length} candidate(s)\n`);
    process.stdout.write(`derived signals: ${derivedSignals.length}\n`);
    process.stdout.write(`appended signals: ${appendedSignals.length}\n`);
    process.stdout.write(`signals consumed: ${recommendation.signalsConsumed}\n`);
  }
  return index.length === 0 ? 1 : 0;
}
