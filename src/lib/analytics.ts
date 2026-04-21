// Analytics + retention.
//
// On successful run completion (git phase → state=COMPLETE) the runner
// calls sealRun() with the run's context. sealRun:
//   1. Appends every line from runs/<id>/events.jsonl to
//      analytics/events-<YYYY-MM>.jsonl. Append mode only — never
//      read-then-write, so concurrent runs can seal safely.
//   2. Trims old run folders (> keepRunFolderForDays) by deleting their
//      snapshots/ and prompts/ subdirs. state.json, run.json,
//      events.jsonl and outputs/ are kept so `harness debug` still
//      works against historical runs.
//   3. Never deletes a run folder entirely — trimming only.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import type { HarnessConfig, HarnessPaths, RunContext } from '../types.js';
import { analyticsFileFor } from './paths.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SealResult {
  readonly analyticsFile: string;
  readonly linesAppended: number;
  readonly retention: {
    readonly tasksScanned: number;
    readonly runsScanned: number;
    readonly runsTrimmed: number;
    readonly bytesFreed: number;
  };
}

export function sealRun(ctx: RunContext, now: Date = new Date()): SealResult {
  const analyticsFile = analyticsFileFor(ctx.paths, now);
  mkdirSync(ctx.paths.analyticsDir, { recursive: true });

  const linesAppended = appendEventsToAnalytics(ctx.runPaths.eventsFile, analyticsFile);
  const retention = applyRetention(ctx.paths, ctx.config, now);

  ctx.logger.event('info', {
    kind: 'run_sealed',
    analyticsFile,
    linesAppended,
    retention,
  });
  return { analyticsFile, linesAppended, retention };
}

// ---------------------------------------------------------------------------
// Seal — append events.jsonl to monthly file
// ---------------------------------------------------------------------------

function appendEventsToAnalytics(
  runEventsFile: string,
  analyticsFile: string,
): number {
  if (!existsSync(runEventsFile)) return 0;
  const raw = readFileSync(runEventsFile, 'utf8');
  if (raw.length === 0) return 0;
  // Ensure trailing newline so concatenated monthly file stays line-delimited
  // even if the run's events.jsonl was trimmed.
  const toWrite = raw.endsWith('\n') ? raw : `${raw}\n`;
  appendFileSync(analyticsFile, toWrite, 'utf8');
  return toWrite.split('\n').filter((l) => l.length > 0).length;
}

// ---------------------------------------------------------------------------
// Retention — trim heavy artifacts from old run folders
// ---------------------------------------------------------------------------

const TRIMMABLE_SUBDIRS: readonly string[] = ['snapshots', 'prompts'];

function applyRetention(
  paths: HarnessPaths,
  config: HarnessConfig,
  now: Date,
): SealResult['retention'] {
  const keepDays = config.retention.keepRunFolderForDays;
  const cutoffMs = now.getTime() - keepDays * 24 * 60 * 60 * 1000;

  let tasksScanned = 0;
  let runsScanned = 0;
  let runsTrimmed = 0;
  let bytesFreed = 0;

  if (!existsSync(paths.tasksDir)) {
    return { tasksScanned, runsScanned, runsTrimmed, bytesFreed };
  }

  // Runs live at <tasksDir>/<project>/<task>/runs/<runId>/. Walk that
  // tree rather than an old top-level runs/ root (the old layout is
  // gone — see the paths.ts + migration notes).
  for (const project of safeReaddir(paths.tasksDir)) {
    const projectDir = resolve(paths.tasksDir, project);
    if (!isDir(projectDir)) continue;
    for (const task of safeReaddir(projectDir)) {
      const taskDir = resolve(projectDir, task);
      if (!isDir(taskDir)) continue;
      const taskRunsDir = resolve(taskDir, 'runs');
      if (!isDir(taskRunsDir)) continue;
      tasksScanned += 1;
      for (const entry of safeReaddir(taskRunsDir)) {
        if (entry === 'current') continue; // symlink
        if (entry === 'harness.lock') continue; // may belong to a live run
        const runDir = resolve(taskRunsDir, entry);
        if (!isDir(runDir)) continue;
        runsScanned += 1;
        const trimmed = maybeTrimRun(runDir, cutoffMs);
        if (trimmed.trimmed) {
          runsTrimmed += 1;
          bytesFreed += trimmed.bytesFreed;
        }
      }
    }
  }

  return { tasksScanned, runsScanned, runsTrimmed, bytesFreed };
}

function maybeTrimRun(
  runDir: string,
  cutoffMs: number,
): { trimmed: boolean; bytesFreed: number } {
  // Age of the run = latest mtime of its state.json if present, else the dir.
  const stateFile = resolve(runDir, 'state.json');
  const marker = existsSync(stateFile) ? stateFile : runDir;
  let age: number;
  try {
    age = statSync(marker).mtimeMs;
  } catch {
    return { trimmed: false, bytesFreed: 0 };
  }
  if (age >= cutoffMs) return { trimmed: false, bytesFreed: 0 };

  let bytesFreed = 0;
  for (const sub of TRIMMABLE_SUBDIRS) {
    const p = resolve(runDir, sub);
    if (!existsSync(p)) continue;
    const size = dirSize(p);
    try {
      rmSync(p, { recursive: true, force: true });
      bytesFreed += size;
    } catch {
      // best-effort; partial delete is fine
    }
  }
  return { trimmed: bytesFreed > 0, bytesFreed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(current, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else total += st.size;
      } catch {
        // skip
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Query helpers — used by `harness status` + `harness debug`.
// ---------------------------------------------------------------------------

export interface TaskTokenSummary {
  readonly project: string;
  readonly task: string;
  readonly promptTokensActual: number;
  readonly completionTokens: number;
  readonly agentCalls: number;
}

/**
 * Tally token totals per task across every analytics file present under
 * `paths.analyticsDir`. Returns a map keyed by `<project>/<task>`. Runs
 * without any analytics entries are simply absent from the map — callers
 * treat a missing key as "no data".
 */
export function tallyTaskTokens(
  paths: HarnessPaths,
): Map<string, TaskTokenSummary> {
  const out = new Map<string, TaskTokenSummary>();
  if (!existsSync(paths.analyticsDir)) return out;
  for (const file of safeReaddir(paths.analyticsDir)) {
    if (!file.startsWith('events-') || !file.endsWith('.jsonl')) continue;
    const full = resolve(paths.analyticsDir, file);
    let content: string;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const raw of content.split('\n')) {
      if (raw.length === 0) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type !== 'agent_call') continue;
      const project = typeof event.project === 'string' ? event.project : null;
      const task = typeof event.task === 'string' ? event.task : null;
      if (!project || !task) continue;
      const key = `${project}/${task}`;
      const prev =
        out.get(key) ??
        ({
          project,
          task,
          promptTokensActual: 0,
          completionTokens: 0,
          agentCalls: 0,
        } as TaskTokenSummary);
      const promptTokens =
        typeof event.promptTokensActual === 'number'
          ? event.promptTokensActual
          : typeof event.promptTokensEstimated === 'number'
            ? event.promptTokensEstimated
            : 0;
      const completionTokens =
        typeof event.completionTokens === 'number' ? event.completionTokens : 0;
      out.set(key, {
        project: prev.project,
        task: prev.task,
        promptTokensActual: prev.promptTokensActual + promptTokens,
        completionTokens: prev.completionTokens + completionTokens,
        agentCalls: prev.agentCalls + 1,
      });
    }
  }
  return out;
}
