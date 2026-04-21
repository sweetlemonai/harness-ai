// `harness debug <project>/<task> [--run <id>] [--phase <id>]` — the
// primary debugging surface. Three levels of detail:
//
//   Level 1 (no flags):
//     list every run for the task, newest first, with status, duration,
//     total tokens, and the final phase reached.
//
//   Level 2 (--run <id>):
//     one-run detail — per-phase table with name, status, duration,
//     attempts, token count.
//
//   Level 3 (--run <id> --phase <id>):
//     per-phase drill-down. For the given phase: gate results (if any),
//     correction attempts with token counts, then the exact saved
//     prompt text for every attempt. Prompt output is clearly
//     separated from metadata with divider lines.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  parseTaskSlug,
  resolveHarnessPaths,
  resolveTaskPaths,
} from '../lib/paths.js';
import { readStateIfExists } from '../lib/state.js';
import type {
  HarnessPaths,
  LogEvent,
  PhaseId,
  RunState,
  TaskPaths,
} from '../types.js';
import { PHASE_IDS } from '../types.js';

export interface DebugCommandArgs {
  readonly task?: string;
  readonly run?: string;
  readonly phase?: PhaseId;
}

export async function debugCommand(args: DebugCommandArgs): Promise<number> {
  if (!args.task) {
    process.stderr.write('debug: task reference required (e.g. debug medplum-app/5-layout)\n');
    return 64;
  }
  const ref = parseTaskSlug(args.task);
  const paths = resolveHarnessPaths();
  const taskPaths = resolveTaskPaths(paths, ref);

  if (!existsSync(taskPaths.runsDir)) {
    process.stdout.write(`no runs for ${args.task}\n`);
    return 0;
  }

  if (args.run === undefined) {
    return renderLevel1(paths, taskPaths, ref.project, ref.task);
  }
  if (args.phase === undefined) {
    return renderLevel2(paths, taskPaths, ref.project, ref.task, args.run);
  }
  return renderLevel3(paths, taskPaths, ref.project, ref.task, args.run, args.phase);
}

// ---------------------------------------------------------------------------
// Level 1 — run list
// ---------------------------------------------------------------------------

function renderLevel1(
  _paths: HarnessPaths,
  taskPaths: TaskPaths,
  project: string,
  task: string,
): number {
  const runs = listRuns(taskPaths).sort().reverse(); // newest first by runId
  if (runs.length === 0) {
    process.stdout.write(`no runs for ${project}/${task}\n`);
    return 0;
  }
  process.stdout.write(`${project}/${task} — ${runs.length} run(s)\n\n`);
  const rows: string[][] = [['runId', 'status', 'duration', 'tokens', 'final phase']];
  for (const runId of runs) {
    const runDir = resolve(taskPaths.runsDir, runId);
    const state = readStateIfExists(resolve(runDir, 'state.json'));
    const duration = computeRunDuration(state);
    const tokens = sumRunTokens(runDir);
    const phase = state?.currentPhase ?? '—';
    rows.push([
      runId,
      state?.status ?? '(no state)',
      formatDuration(duration),
      formatTokens(tokens),
      phase,
    ]);
  }
  printTable(rows);
  return 0;
}

// ---------------------------------------------------------------------------
// Level 2 — phase table for a single run
// ---------------------------------------------------------------------------

function renderLevel2(
  _paths: HarnessPaths,
  taskPaths: TaskPaths,
  project: string,
  task: string,
  runId: string,
): number {
  const runDir = resolve(taskPaths.runsDir, runId);
  if (!existsSync(runDir)) {
    process.stderr.write(`run not found: ${runId}\n`);
    return 1;
  }
  const state = readStateIfExists(resolve(runDir, 'state.json'));
  process.stdout.write(`${project}/${task} — run ${runId}\n`);
  if (state) {
    process.stdout.write(
      `  status: ${state.status}  started: ${state.startedAt}  updated: ${state.updatedAt}\n`,
    );
  }
  process.stdout.write('\n');

  const events = loadEvents(resolve(runDir, 'events.jsonl'));
  const phaseTimings = computePhaseTimings(events);
  const tokenByPhase = tokenTotalsByPhase(events);

  const rows: string[][] = [['phase', 'status', 'duration', 'attempts', 'tokens']];
  for (const phase of PHASE_IDS) {
    const info = phaseTimings.get(phase);
    const outputFile = resolve(runDir, 'outputs', `${phase}.json`);
    let statusLabel = '—';
    let attempts = '—';
    if (existsSync(outputFile)) {
      try {
        const parsed = JSON.parse(readFileSync(outputFile, 'utf8')) as {
          status?: string;
          attempts?: number;
        };
        if (parsed.status) statusLabel = parsed.status;
        if (typeof parsed.attempts === 'number') attempts = String(parsed.attempts);
      } catch {
        // leave as dashes
      }
    } else if (info?.ended) {
      statusLabel = info.status ?? '—';
    }
    rows.push([
      phase,
      statusLabel,
      info?.durationMs !== undefined ? formatDuration(info.durationMs) : '—',
      attempts,
      formatTokens(tokenByPhase.get(phase) ?? 0),
    ]);
  }
  printTable(rows);
  return 0;
}

// ---------------------------------------------------------------------------
// Level 3 — phase drill-down
// ---------------------------------------------------------------------------

function renderLevel3(
  _paths: HarnessPaths,
  taskPaths: TaskPaths,
  project: string,
  task: string,
  runId: string,
  phase: PhaseId,
): number {
  const runDir = resolve(taskPaths.runsDir, runId);
  if (!existsSync(runDir)) {
    process.stderr.write(`run not found: ${runId}\n`);
    return 1;
  }
  process.stdout.write(`${project}/${task} — run ${runId} — phase ${phase}\n`);

  const outputFile = resolve(runDir, 'outputs', `${phase}.json`);
  if (existsSync(outputFile)) {
    process.stdout.write('\n--- outputs/' + phase + '.json ---\n');
    process.stdout.write(readFileSync(outputFile, 'utf8'));
  } else {
    process.stdout.write('\n(no outputs/' + phase + '.json — phase may not have run)\n');
  }

  const events = loadEvents(resolve(runDir, 'events.jsonl'))
    .filter((e) => e.phase === phase || e.type === 'gate' || e.type === 'correction_attempt')
    .filter((e) => !e.phase || e.phase === phase);
  const gateEvents = events.filter((e) => e.type === 'gate');
  const correctionEvents = events.filter((e) => e.type === 'correction_attempt');
  const agentCalls = events.filter((e) => e.type === 'agent_call');

  if (gateEvents.length > 0) {
    process.stdout.write('\n--- gate results ---\n');
    const rows: string[][] = [['gate', 'passed', 'duration', 'errors', 'run']];
    for (const g of gateEvents) {
      rows.push([
        String(g.gate ?? '—'),
        String(g.passed ?? '—'),
        typeof g.durationMs === 'number' ? formatDuration(g.durationMs) : '—',
        String(g.errorCount ?? g.failureCount ?? 0),
        String(g.run ?? '—'),
      ]);
    }
    printTable(rows);
  }

  if (correctionEvents.length > 0) {
    process.stdout.write('\n--- correction attempts ---\n');
    for (const c of correctionEvents) {
      const attempt = c.attempt ?? '?';
      const agentExit = c.agentExitCode ?? '?';
      process.stdout.write(
        `  attempt ${attempt}: agent exitCode=${agentExit}\n`,
      );
    }
  }

  if (agentCalls.length > 0) {
    process.stdout.write('\n--- agent calls ---\n');
    const rows: string[][] = [
      ['attempt', 'agent', 'tokens in (est/actual)', 'tokens out', 'duration', 'exit'],
    ];
    for (const a of agentCalls) {
      rows.push([
        String(a.attempt ?? '—'),
        String(a.agent ?? '—'),
        `${a.promptTokensEstimated ?? '—'} / ${a.promptTokensActual ?? '—'}`,
        String(a.completionTokens ?? '—'),
        typeof a.durationMs === 'number' ? formatDuration(a.durationMs) : '—',
        String(a.exitCode ?? '—'),
      ]);
    }
    printTable(rows);
  }

  const promptsDir = resolve(runDir, 'prompts');
  if (existsSync(promptsDir)) {
    const promptFiles = readdirSync(promptsDir)
      .filter((f) => f.startsWith(`${phase}-attempt-`) && f.endsWith('.txt'))
      .sort();
    for (const name of promptFiles) {
      const full = resolve(promptsDir, name);
      process.stdout.write(
        '\n' + '='.repeat(70) + '\n' + name + '\n' + '='.repeat(70) + '\n',
      );
      process.stdout.write(readFileSync(full, 'utf8'));
      if (!readFileSync(full, 'utf8').endsWith('\n')) {
        process.stdout.write('\n');
      }
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function listRuns(taskPaths: TaskPaths): string[] {
  try {
    return readdirSync(taskPaths.runsDir).filter((entry) => {
      if (entry === 'current' || entry === 'harness.lock') return false;
      return isDir(resolve(taskPaths.runsDir, entry));
    });
  } catch {
    return [];
  }
}

function loadEvents(eventsFile: string): LogEvent[] {
  if (!existsSync(eventsFile)) return [];
  const raw = readFileSync(eventsFile, 'utf8');
  const out: LogEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

interface PhaseTiming {
  start?: number;
  ended?: boolean;
  durationMs?: number;
  status?: string;
}

function computePhaseTimings(events: readonly LogEvent[]): Map<PhaseId, PhaseTiming> {
  const out = new Map<PhaseId, PhaseTiming>();
  for (const e of events) {
    const phase = e.phase as PhaseId | undefined;
    if (!phase) continue;
    const entry = out.get(phase) ?? {};
    if (e.type === 'phase_start') {
      entry.start = Date.parse(String(e.ts));
    }
    if (e.type === 'phase_end') {
      entry.ended = true;
      if (typeof e.durationMs === 'number') entry.durationMs = e.durationMs;
      if (typeof e.status === 'string') entry.status = e.status;
    }
    out.set(phase, entry);
  }
  return out;
}

function tokenTotalsByPhase(events: readonly LogEvent[]): Map<PhaseId, number> {
  const out = new Map<PhaseId, number>();
  for (const e of events) {
    if (e.type !== 'agent_call') continue;
    const phase = e.phase as PhaseId | undefined;
    if (!phase) continue;
    const inTokens = typeof e.promptTokensActual === 'number'
      ? e.promptTokensActual
      : typeof e.promptTokensEstimated === 'number'
        ? e.promptTokensEstimated
        : 0;
    const outTokens =
      typeof e.completionTokens === 'number' ? e.completionTokens : 0;
    out.set(phase, (out.get(phase) ?? 0) + inTokens + outTokens);
  }
  return out;
}

function computeRunDuration(state: RunState | null): number | null {
  if (!state) return null;
  const s = Date.parse(state.startedAt);
  const e = Date.parse(state.updatedAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return Math.max(0, e - s);
}

function sumRunTokens(runDir: string): number {
  const events = loadEvents(resolve(runDir, 'events.jsonl'));
  let sum = 0;
  for (const e of events) {
    if (e.type !== 'agent_call') continue;
    const pin = typeof e.promptTokensActual === 'number'
      ? e.promptTokensActual
      : typeof e.promptTokensEstimated === 'number'
        ? e.promptTokensEstimated
        : 0;
    const pout =
      typeof e.completionTokens === 'number' ? e.completionTokens : 0;
    sum += pin + pout;
  }
  return sum;
}

function printTable(rows: readonly (readonly string[])[]): void {
  if (rows.length === 0) return;
  const widths = rows[0]!.map((_, colIdx) =>
    Math.max(...rows.map((r) => (r[colIdx] ?? '').length)),
  );
  for (let i = 0; i < rows.length; i += 1) {
    const line = rows[i]!
      .map((cell, idx) => (cell ?? '').padEnd(widths[idx]!))
      .join('  ');
    process.stdout.write(`  ${line}\n`);
    if (i === 0) {
      const sep = widths.map((w) => '-'.repeat(w)).join('  ');
      process.stdout.write(`  ${sep}\n`);
    }
  }
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  if (s > 0) return `${s}s`;
  return `${ms}ms`;
}

function formatTokens(n: number | null | undefined): string {
  if (!n) return '—';
  return `${n.toLocaleString('en-US')}`;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
