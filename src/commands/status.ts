// `harness status [--project <project>]` — a project/task overview table.
//
// For each task:
//   - State comes from runs/<project>/<task>/current/state.json, if present.
//   - "pending" means no run exists yet.
//   - "blocked" means a dependency is not complete (parked or pending).
//   - Duration = updatedAt − startedAt from state.json.
//   - Tokens = sum from harness/analytics/events-*.jsonl
//              (promptTokensActual + completionTokens per agent_call
//              event). Tasks with no analytics show "—", not 0.

import {
  existsSync,
  readdirSync,
  readlinkSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { tallyTaskTokens, type TaskTokenSummary } from '../lib/analytics.js';
import { loadConfig } from '../lib/config.js';
import {
  getBlockers,
  loadDependencyGraph,
  type DependencyGraph,
} from '../lib/dependencies.js';
import { C, shouldUseColor } from '../lib/logger.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { readStateIfExists } from '../lib/state.js';
import type {
  HarnessPaths,
  RunState,
  RunStatus,
} from '../types.js';

export interface StatusCommandArgs {
  readonly project?: string;
}

export async function statusCommand(args: StatusCommandArgs): Promise<number> {
  const paths = resolveHarnessPaths();
  try {
    loadConfig(paths); // surface config errors even in read-only command
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (!existsSync(paths.tasksDir)) {
    process.stdout.write('(no tasks directory yet)\n');
    return 0;
  }

  const projects = listProjects(paths.tasksDir, args.project ?? null);
  if (projects.length === 0) {
    if (args.project) {
      process.stderr.write(`project not found: ${args.project}\n`);
      return 1;
    }
    process.stdout.write('(no projects registered)\n');
    return 0;
  }

  const tokensMap = tallyTaskTokens(paths);

  let totalTokens = 0;
  let firstProject = true;
  for (const project of projects) {
    if (!firstProject) process.stdout.write('\n');
    firstProject = false;

    const tasks = listTasks(paths.tasksDir, project);
    const graph = loadGraphSafe(paths, project);
    const { completed, parked } = tasksByStatus(paths, project, tasks);
    const rows = tasks.map((task) =>
      buildRow(paths, project, task, graph, completed, parked, tokensMap),
    );

    process.stdout.write(`${project}\n`);
    renderRows(rows);

    const counts = summarize(rows);
    const parts: string[] = [`${counts.complete} complete`];
    if (counts.skippedByHuman > 0) parts.push(`${counts.skippedByHuman} skipped (human)`);
    parts.push(`${counts.escalated} escalated`);
    parts.push(`${counts.blocked} blocked`);
    parts.push(`${counts.running} running`);
    parts.push(`${counts.pending} pending`);
    process.stdout.write(`\n  ${parts.join(' · ')}\n`);
    const projectTokens = rows.reduce((n, r) => n + (r.tokens ?? 0), 0);
    totalTokens += projectTokens;
    if (projectTokens > 0) {
      process.stdout.write(`  total tokens: ${projectTokens.toLocaleString('en-US')}\n`);
    }
  }

  if (projects.length > 1 && totalTokens > 0) {
    process.stdout.write(
      `\nall projects · total tokens: ${totalTokens.toLocaleString('en-US')}\n`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

interface TaskRow {
  readonly task: string;
  readonly state: RunStatus | 'pending' | 'blocked';
  readonly durationMs: number | null;
  readonly tokens: number | null;
  readonly note: string | null;
}

function buildRow(
  paths: HarnessPaths,
  project: string,
  task: string,
  graph: DependencyGraph,
  completed: ReadonlySet<string>,
  parked: ReadonlySet<string>,
  tokensMap: ReadonlyMap<string, TaskTokenSummary>,
): TaskRow {
  const state = readCurrentState(paths, project, task);
  const blockers = getBlockers(graph, task, completed, parked);
  const stateLabel = classify(state, blockers);
  const durationMs = computeDuration(state);
  const tokenEntry = tokensMap.get(`${project}/${task}`);
  const tokens = tokenEntry
    ? tokenEntry.promptTokensActual + tokenEntry.completionTokens
    : null;
  const note = computeNote(state, blockers, stateLabel);
  return { task, state: stateLabel, durationMs, tokens, note };
}

function classify(
  state: RunState | null,
  blockers: readonly string[],
): RunStatus | 'pending' | 'blocked' {
  if (!state) {
    return blockers.length > 0 ? 'blocked' : 'pending';
  }
  if (state.status === 'complete') return 'complete';
  if (state.status === 'skipped-by-human') return 'skipped-by-human';
  if (state.status === 'escalated') return 'escalated';
  if (state.status === 'interrupted') return 'interrupted';
  if (state.status === 'failed') return 'failed';
  if (state.status === 'running') return 'running';
  return 'pending';
}

function computeDuration(state: RunState | null): number | null {
  if (!state) return null;
  if (state.status !== 'complete') return null;
  const start = Date.parse(state.startedAt);
  const end = Date.parse(state.updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function computeNote(
  state: RunState | null,
  blockers: readonly string[],
  label: RunStatus | 'pending' | 'blocked',
): string | null {
  if (label === 'blocked' && blockers.length > 0) {
    return `waiting on ${blockers.join(', ')}`;
  }
  if (label === 'escalated' && state) {
    return `last run: ${state.updatedAt.slice(0, 10)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderRows(rows: readonly TaskRow[]): void {
  const taskCol = Math.max(14, ...rows.map((r) => r.task.length));
  const stateCol = 16;
  const useColor = shouldUseColor();
  for (const row of rows) {
    const { label, color, symbol } = stateDisplay(row.state);
    const duration = formatDuration(row.durationMs);
    const tokens = formatTokens(row.tokens);
    const note = row.note ? `(${row.note})` : '';
    const task = row.task.padEnd(taskCol);
    const padded = label.padEnd(stateCol);
    // Colour the state column + symbol but leave the rest of the row
    // monochrome — the state is the signal the eye needs to find.
    const colouredLabel = useColor && color
      ? `${color}${padded}${C.reset}`
      : padded;
    const colouredSymbol = useColor && color
      ? `${color}${symbol}${C.reset}`
      : symbol;
    const line =
      '  ' +
      colouredSymbol +
      ' ' +
      task +
      '  ' +
      colouredLabel +
      '  ' +
      duration.padEnd(10) +
      '  ' +
      tokens.padStart(9) +
      (note ? '   ' + note : '');
    process.stdout.write(line + '\n');
  }
}

/**
 * Mapping from classified row state → (text label, symbol, ANSI colour).
 * The `skipped-by-human` row renders as `⊘ skipped (human)` in amber per
 * the ship UX spec.
 */
function stateDisplay(
  state: RunStatus | 'pending' | 'blocked',
): { label: string; symbol: string; color: string | null } {
  switch (state) {
    case 'complete':
      return { label: 'complete', symbol: '✓', color: C.green };
    case 'skipped-by-human':
      return { label: 'skipped (human)', symbol: '⊘', color: C.amber };
    case 'escalated':
      return { label: 'escalated', symbol: '⚠', color: C.amber };
    case 'failed':
      return { label: 'failed', symbol: '✗', color: C.red };
    case 'interrupted':
      return { label: 'interrupted', symbol: '⚠', color: C.amber };
    case 'running':
      return { label: 'running', symbol: '→', color: C.blue };
    case 'blocked':
      return { label: 'blocked', symbol: '—', color: C.dimGray };
    case 'pending':
    default:
      return { label: 'pending', symbol: '·', color: C.dimWhite };
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

function formatTokens(n: number | null): string {
  if (n === null) return '—';
  return `${n.toLocaleString('en-US')} tokens`;
}

// ---------------------------------------------------------------------------
// File + graph loading
// ---------------------------------------------------------------------------

function listProjects(tasksDir: string, filter: string | null): string[] {
  try {
    const entries = readdirSync(tasksDir);
    const out = entries.filter((e) => isDir(resolve(tasksDir, e))).sort();
    return filter === null ? out : out.filter((p) => p === filter);
  } catch {
    return [];
  }
}

function listTasks(tasksDir: string, project: string): string[] {
  try {
    const dir = resolve(tasksDir, project);
    return readdirSync(dir)
      .filter((e) => e.endsWith('.md'))
      .map((e) => e.replace(/\.md$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function tasksByStatus(
  paths: HarnessPaths,
  project: string,
  tasks: readonly string[],
): { completed: Set<string>; parked: Set<string> } {
  const completed = new Set<string>();
  const parked = new Set<string>();
  for (const task of tasks) {
    const state = readCurrentState(paths, project, task);
    if (!state) continue;
    // `skipped-by-human` counts as complete for dependency resolution —
    // the human said so. Downstream tasks should treat it as satisfied.
    if (state.status === 'complete' || state.status === 'skipped-by-human') {
      completed.add(task);
    } else if (state.status === 'escalated') {
      parked.add(task);
    }
  }
  return { completed, parked };
}

function readCurrentState(
  paths: HarnessPaths,
  project: string,
  task: string,
): RunState | null {
  const currentSymlink = resolve(paths.tasksDir, project, task, 'runs', 'current');
  const runDir = resolveRunDir(currentSymlink);
  if (!runDir) return null;
  const statePath = resolve(runDir, 'state.json');
  try {
    return readStateIfExists(statePath);
  } catch {
    return null;
  }
}

function resolveRunDir(currentSymlink: string): string | null {
  if (!existsSync(currentSymlink)) return null;
  try {
    return readlinkSync(currentSymlink);
  } catch {
    return null;
  }
}

function loadGraphSafe(paths: HarnessPaths, project: string): DependencyGraph {
  const p = resolve(paths.tasksDir, project, 'dependency-graph.yml');
  try {
    return loadDependencyGraph(p);
  } catch {
    return { dependencies: new Map(), allTasks: [] };
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function summarize(rows: readonly TaskRow[]): {
  complete: number;
  skippedByHuman: number;
  escalated: number;
  blocked: number;
  running: number;
  pending: number;
} {
  let complete = 0;
  let skippedByHuman = 0;
  let escalated = 0;
  let blocked = 0;
  let running = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.state === 'complete') complete += 1;
    else if (r.state === 'skipped-by-human') skippedByHuman += 1;
    else if (r.state === 'escalated') escalated += 1;
    else if (r.state === 'blocked') blocked += 1;
    else if (r.state === 'running') running += 1;
    else pending += 1;
  }
  return { complete, skippedByHuman, escalated, blocked, running, pending };
}

// Re-exported to keep existing internal imports happy if added later.
void readFileSync;
