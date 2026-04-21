// All path construction for the harness. Every caller receives absolute,
// realpath-resolved strings. No other module may construct paths.
// Locked after initial write.

import { randomInt } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  HarnessPaths,
  RunPaths,
  TaskPaths,
  TaskRef,
} from '../types.js';

const HARNESS_DIR_NAME = 'harness';
const CLAUDE_DIR_NAME = '.claude';
const PACKAGE_NAME = '@sweetlemonai/harness-ai';
const RUN_ID_PATTERN = /^\d{14}_[a-z0-9]{6}$/;
const BRANCH_PREFIX = 'harness';

// ---------------------------------------------------------------------------
// Package root discovery
//
// This file ends up at <packageRoot>/dist/cli.js (built) OR
// <packageRoot>/src/lib/paths.ts (source). Walk up until we find a
// package.json whose name is "@sweetlemonai/harness-ai". realpathSync
// resolves pnpm-link symlinks so downstream path math is stable.
// ---------------------------------------------------------------------------

function resolvePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkgFile = resolve(dir, 'package.json');
    if (existsSync(pkgFile)) {
      try {
        const json = JSON.parse(readFileSync(pkgFile, 'utf8')) as { name?: string };
        if (json?.name === PACKAGE_NAME) return realpathSync(dir);
      } catch {
        // ignore malformed package.json and keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate ${PACKAGE_NAME} package root from module at ${fileURLToPath(import.meta.url)}`,
  );
}

// ---------------------------------------------------------------------------
// Repo root = process.cwd(). Every harness CLI command is run from the
// repo root — the same convention used by npm, pnpm, next, etc.
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  return realpathSync(process.cwd());
}

export function resolveHarnessPaths(): HarnessPaths {
  const repoRoot = resolveRepoRoot();
  const packageRoot = resolvePackageRoot();
  const harnessRoot = resolve(repoRoot, HARNESS_DIR_NAME);
  const claudeRoot = resolve(repoRoot, CLAUDE_DIR_NAME);
  const packageDefaultsDir = resolve(packageRoot, 'defaults');
  const packageClaudeDir = resolve(packageDefaultsDir, CLAUDE_DIR_NAME);

  return {
    repoRoot,
    harnessRoot,
    packageRoot,
    packageDefaultsDir,

    configFile: resolve(harnessRoot, 'config.json'),
    configLocalFile: resolve(harnessRoot, 'config.local.json'),
    packageConfigFile: resolve(packageDefaultsDir, 'config.json'),
    configSchemaFile: resolve(packageDefaultsDir, 'config.schema.json'),

    claudeRoot,
    claudeMdFile: resolve(claudeRoot, 'CLAUDE.md'),

    packageAgentsDir: resolve(packageClaudeDir, 'agents'),
    packageContextDir: resolve(packageClaudeDir, 'context'),
    packageStandardsDir: resolve(packageClaudeDir, 'standards'),
    packageSkillsDir: resolve(packageClaudeDir, 'skills'),

    briefsDir: resolve(harnessRoot, 'briefs'),
    tasksDir: resolve(harnessRoot, 'tasks'),
    analyticsDir: resolve(harnessRoot, 'analytics'),

    srcDir: resolve(repoRoot, 'src'),
    playwrightConfig: resolve(harnessRoot, 'playwright.config.ts'),
  };
}

// ---------------------------------------------------------------------------
// .claude/ asset resolution
//
// Agents/skills: repo wins, package defaults fall back.
// Standards/contexts: merged list — repo wins on filename conflict.
// ---------------------------------------------------------------------------

/**
 * Resolve a `.claude/` asset path. Repo takes priority; package default is
 * the fallback. Throws if neither exists.
 *
 * @param paths  Resolved harness paths
 * @param relativePath  Path relative to `.claude/`, e.g. "agents/spec.agent.md"
 */
export function resolveClaudeAsset(
  paths: HarnessPaths,
  relativePath: string,
): string {
  const repoPath = resolve(paths.claudeRoot, relativePath);
  if (existsSync(repoPath)) return repoPath;
  const pkgPath = resolve(paths.packageDefaultsDir, CLAUDE_DIR_NAME, relativePath);
  if (existsSync(pkgPath)) return pkgPath;
  throw new Error(
    `Claude asset '${relativePath}' not found at repo (${repoPath}) or package defaults (${pkgPath})`,
  );
}

/**
 * List merged assets from a `.claude/` subdirectory. Returns { name, path }
 * entries where repo files take priority over package files sharing the
 * same basename. Used for bulk reads (e.g. all standards).
 */
export function listClaudeAssets(
  paths: HarnessPaths,
  category: 'agents' | 'context' | 'standards' | 'skills',
): ReadonlyArray<{ readonly name: string; readonly path: string }> {
  const packageDir = resolve(paths.packageDefaultsDir, CLAUDE_DIR_NAME, category);
  const repoDir = resolve(paths.claudeRoot, category);
  const byName = new Map<string, string>();

  for (const dir of [packageDir, repoDir]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const full = resolve(dir, name);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      byName.set(name, full); // later iterations overwrite earlier → repo wins
    }
  }

  return [...byName.entries()].map(([name, path]) => ({ name, path }));
}

// ---------------------------------------------------------------------------
// Task paths — all generated artefacts for a given <project>/<task>.
//
// Everything a task produces lives beside its ticket file, in a folder
// named after the ticket (sans `.md`):
//
//   harness/tasks/<project>/<task>.md     ← task ticket (unchanged)
//   harness/tasks/<project>/<task>/       ← this "task folder"
//       workspace/                        ← spec, manifest, context, design
//       e2e/                              ← playwright specs
//       runs/                             ← gitignored; one dir per run
//           current → <runId>
//           <runId>/
//
// The old top-level `harness/workspace`, `harness/e2e`, and `harness/runs`
// roots are gone — see the migration for pre-existing runs.
// ---------------------------------------------------------------------------

export function taskFolderFor(
  paths: HarnessPaths,
  ref: TaskRef,
): string {
  assertTaskRefSegments(ref);
  return resolve(paths.tasksDir, ref.project, ref.task);
}

export function resolveTaskPaths(
  paths: HarnessPaths,
  ref: TaskRef,
): TaskPaths {
  assertTaskRefSegments(ref);
  const taskFolder = taskFolderFor(paths, ref);
  const taskRunsRoot = resolve(taskFolder, 'runs');
  return {
    ref,
    taskFile: resolve(paths.tasksDir, ref.project, `${ref.task}.md`),
    workspaceDir: resolve(taskFolder, 'workspace'),
    e2eDir: resolve(taskFolder, 'e2e'),
    runsDir: taskRunsRoot,
    dependencyGraphFile: resolve(
      paths.tasksDir,
      ref.project,
      'dependency-graph.yml',
    ),
    currentRunSymlink: resolve(taskRunsRoot, 'current'),
    lockFile: resolve(taskRunsRoot, 'harness.lock'),
  };
}

// ---------------------------------------------------------------------------
// Run paths — run-specific artifacts inside a task's runs directory
// ---------------------------------------------------------------------------

export function resolveRunPaths(
  taskPaths: TaskPaths,
  runId: string,
): RunPaths {
  assertRunIdFormat(runId);
  const runDir = resolve(taskPaths.runsDir, runId);
  return {
    runId,
    runDir,
    stateFile: resolve(runDir, 'state.json'),
    runMetaFile: resolve(runDir, 'run.json'),
    eventsFile: resolve(runDir, 'events.jsonl'),
    logFile: resolve(runDir, 'harness.log'),
    escalationFile: resolve(runDir, 'ESCALATION.md'),
    interruptedFile: resolve(runDir, 'INTERRUPTED.md'),
    snapshotsDir: resolve(runDir, 'snapshots'),
    promptsDir: resolve(runDir, 'prompts'),
    outputsDir: resolve(runDir, 'outputs'),
    reportsDir: resolve(runDir, 'reports'),
  };
}

// ---------------------------------------------------------------------------
// Run ID
//
// Format: <YYYYMMDDHHmmss>_<6-char-random> — timestamp avoids cross-day
// collisions; random suffix avoids same-second collisions.
// ---------------------------------------------------------------------------

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function resolveRunId(now: Date = new Date()): string {
  const ts =
    now.getUTCFullYear().toString().padStart(4, '0') +
    (now.getUTCMonth() + 1).toString().padStart(2, '0') +
    now.getUTCDate().toString().padStart(2, '0') +
    now.getUTCHours().toString().padStart(2, '0') +
    now.getUTCMinutes().toString().padStart(2, '0') +
    now.getUTCSeconds().toString().padStart(2, '0');

  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    const idx = randomInt(0, RANDOM_ALPHABET.length);
    suffix += RANDOM_ALPHABET[idx];
  }
  return `${ts}_${suffix}`;
}

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

function assertRunIdFormat(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `Invalid run ID '${runId}'. Expected <14-digit timestamp>_<6 lowercase alnum chars>.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Task slug parsing + validation
//
// CLI references are always `<project>/<task>`. Internally split into
// { project, task } — never a single slash-containing string.
// ---------------------------------------------------------------------------

const TASK_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseTaskSlug(slug: string): TaskRef {
  const parts = slug.split('/');
  if (parts.length !== 2) {
    throw new Error(
      `Invalid task reference '${slug}'. Expected '<project>/<task>'.`,
    );
  }
  const [project, task] = parts;
  if (!project || !task) {
    throw new Error(
      `Invalid task reference '${slug}'. Project and task segments must both be non-empty.`,
    );
  }
  const ref: TaskRef = { project, task };
  assertTaskRefSegments(ref);
  return ref;
}

function assertTaskRefSegments(ref: TaskRef): void {
  if (!TASK_SEGMENT_PATTERN.test(ref.project)) {
    throw new Error(
      `Invalid project segment '${ref.project}'. Allowed: alphanumeric, '.', '_', '-'; must start with alphanumeric.`,
    );
  }
  if (!TASK_SEGMENT_PATTERN.test(ref.task)) {
    throw new Error(
      `Invalid task segment '${ref.task}'. Allowed: alphanumeric, '.', '_', '-'; must start with alphanumeric.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Branch name
//
// Blueprint: lowercase, only [a-z0-9-/], no consecutive hyphens, no
// leading/trailing hyphens. Underscores in the run ID are converted to
// hyphens in the branch.
// ---------------------------------------------------------------------------

export function sanitizeBranch(ref: TaskRef, runId: string): string {
  assertTaskRefSegments(ref);
  assertRunIdFormat(runId);
  const raw = `${BRANCH_PREFIX}/${ref.project}/${ref.task}-${runId}`;
  const lowered = raw.toLowerCase();
  const normalized = lowered
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\//g, '/')
    .replace(/\/-+/g, '/')
    .replace(/^-+|-+$/g, '');
  if (!normalized || normalized === BRANCH_PREFIX) {
    throw new Error(
      `Branch name sanitization produced an empty or prefix-only result for ${raw}`,
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Ancillary paths
// ---------------------------------------------------------------------------

export function analyticsFileFor(paths: HarnessPaths, now: Date = new Date()): string {
  const year = now.getUTCFullYear().toString().padStart(4, '0');
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return resolve(paths.analyticsDir, `events-${year}-${month}.jsonl`);
}

export function promptFileFor(
  runPaths: RunPaths,
  phase: string,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Attempt must be a positive integer (got ${attempt})`);
  }
  return resolve(runPaths.promptsDir, `${phase}-attempt-${attempt}.txt`);
}

export function snapshotFileFor(runPaths: RunPaths, phase: string): string {
  return resolve(runPaths.snapshotsDir, `before-${phase}.tar`);
}

export function phaseOutputFileFor(runPaths: RunPaths, phase: string): string {
  return resolve(runPaths.outputsDir, `${phase}.json`);
}

// ---------------------------------------------------------------------------
// Human-facing path rendering
//
// The rule across the harness: absolute paths for code, relative paths
// for humans. `toRelative` is the single conversion point — every
// human-facing surface (terminal, ESCALATION.md, PR_DESCRIPTION.md)
// passes absolute filesystem paths through it before display.
//
// `formatBytes` is the sibling for size displays. Unit-switched at the
// 1024-byte / 1 MiB thresholds.
// ---------------------------------------------------------------------------

import { relative as pathRelative } from 'node:path';

/**
 * Project-root-relative form of an absolute path. Paths that are already
 * relative pass through unchanged. Paths that don't sit under `projectRoot`
 * are returned as given — we never produce a path containing `..` segments
 * that would confuse a reader.
 */
export function toRelative(absolutePath: string, projectRoot: string): string {
  if (!absolutePath) return absolutePath;
  // `relative()` returns '..' chains for paths outside projectRoot;
  // fall back to the original in that case.
  const rel = pathRelative(projectRoot, absolutePath);
  if (rel === '' || rel.startsWith('..')) return absolutePath;
  return rel;
}

/**
 * Human-readable file size. 1,024-based thresholds.
 *   < 1024       →  "<N>B"
 *   < 1,048,576  →  "<N>KB"   (rounded)
 *   otherwise    →  "<N.N>MB" (one decimal)
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// CLI entry point — `npx tsx src/lib/paths.ts [<project>/<task>]`
//
// Resolves every path and prints a human-readable summary. Used by the
// task-list Day 1 validation: "prints all resolved paths".
// ---------------------------------------------------------------------------

function printPaths(): void {
  const paths = resolveHarnessPaths();
  const slug = process.argv[2] ?? 'demo-project/demo-task';
  const ref = parseTaskSlug(slug);
  const runId = resolveRunId();
  const taskPaths = resolveTaskPaths(paths, ref);
  const runPaths = resolveRunPaths(taskPaths, runId);
  const branch = sanitizeBranch(ref, runId);

  const blocks: Array<[string, Record<string, string | number>]> = [
    ['HarnessPaths', paths as unknown as Record<string, string>],
    ['TaskPaths', flattenTaskPaths(taskPaths)],
    ['RunPaths', runPaths as unknown as Record<string, string>],
    [
      'Derived',
      {
        runId,
        branch,
        analyticsFile: analyticsFileFor(paths),
        promptFile: promptFileFor(runPaths, 'build', 1),
        snapshotFile: snapshotFileFor(runPaths, 'build'),
        phaseOutputFile: phaseOutputFileFor(runPaths, 'build'),
      },
    ],
  ];

  for (const [title, block] of blocks) {
    process.stdout.write(`\n[${title}]\n`);
    const keys = Object.keys(block).sort();
    for (const key of keys) {
      process.stdout.write(`  ${key.padEnd(22)} ${block[key]}\n`);
    }
  }
}

function flattenTaskPaths(tp: TaskPaths): Record<string, string> {
  return {
    ref: `${tp.ref.project}/${tp.ref.task}`,
    taskFile: tp.taskFile,
    workspaceDir: tp.workspaceDir,
    e2eDir: tp.e2eDir,
    runsDir: tp.runsDir,
    dependencyGraphFile: tp.dependencyGraphFile,
    currentRunSymlink: tp.currentRunSymlink,
    lockFile: tp.lockFile,
  };
}

if (import.meta.url.endsWith('/src/lib/paths.ts')) {
  printPaths();
}
