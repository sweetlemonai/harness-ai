// `harness run <task>` — parse flags, build RunContext, hand off to the
// pipeline runner. No pipeline logic lives here.
//
// Two modes:
//   - single task (`harness run tick/1-types`) — one task, full pipeline.
//   - project      (`harness run tick`)       — every task in the project,
//                                               dependency order, one at a
//                                               time. Escalations park a
//                                               task but do not stop the
//                                               wider run.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  ConfigValidationError,
  EscalationError,
  LockError,
  PHASE_IDS,
  type HarnessConfig,
  type PhaseId,
  type Phase,
  type RunContext,
  type RunFlags,
  type RunState,
  type TaskFrontmatter,
  type TaskRef,
  type TaskType,
} from '../types.js';
import { loadConfig } from '../lib/config.js';
import { createProjectPullRequest } from '../lib/projectPr.js';
import {
  resolveProjectTaskName as resolveProjectTaskNameTyped,
  type FromTarget,
} from '../lib/tasks.js';
import { createLogger } from '../lib/logger.js';
import { acquireLock, readLockIfExists, type LockHandle } from '../lib/lock.js';
import {
  parseTaskSlug,
  resolveHarnessPaths,
  resolveRunId,
  resolveRunPaths,
  resolveTaskPaths,
  sanitizeBranch,
} from '../lib/paths.js';
import {
  getReadyTasks,
  loadDependencyGraph,
  type DependencyGraph,
} from '../lib/dependencies.js';
import { createRunMeta, readStateIfExists, writeRunMeta } from '../lib/state.js';
import { C, shouldUseColor } from '../lib/logger.js';
import { tallyTaskTokens } from '../lib/analytics.js';
import { runPipeline } from '../pipeline/runner.js';
import { preflightPhase } from '../pipeline/phases/preflight.js';
import { designPhase } from '../pipeline/phases/design.js';
import { specPhase } from '../pipeline/phases/spec.js';
import { contextPhase } from '../pipeline/phases/context.js';
import { buildPhase } from '../pipeline/phases/build.js';
import { reconcilePhase } from '../pipeline/phases/reconcile.js';
import { hardGatesPhase } from '../pipeline/phases/hardGates.js';
import { qaPhase } from '../pipeline/phases/qa.js';
import { e2ePhase } from '../pipeline/phases/e2e.js';
import { softGatesPhase } from '../pipeline/phases/softGates.js';
import { prAssemblyPhase } from '../pipeline/phases/prAssembly.js';
import { gitPhase } from '../pipeline/phases/git.js';

export interface RunCommandArgs {
  /**
   * Either `<project>/<task>` (single task mode) or `<project>` alone
   * (project mode — runs every task in the project in dependency order).
   */
  readonly task?: string;
  readonly project?: string;
  /**
   * In single-task mode this is a PhaseId; in project mode it is a task
   * id (the file's basename without `.md`). Validated by `runCommand`
   * after mode dispatch.
   */
  readonly stopAfter?: string;
  /**
   * Tagged union produced by `parseFromTarget`. Validation per mode
   * happens inside `runSingleTask` / `runProjectMode` — the CLI parser
   * cannot know which project the user is in.
   */
  readonly from?: FromTarget;
  readonly dryRun: boolean;
  readonly resume: boolean;
  /**
   * Project mode only. Bypasses the "this will discard prior progress
   * for N tasks" confirmation prompt. Ignored in single-task mode.
   */
  readonly force?: boolean;
  readonly nonInteractive: boolean;
  /**
   * True when invoked from `harness ship`. Enables two behaviours:
   *   1. Overrides `config.git.push` and `config.git.createPR` to true
   *      for the duration of the run, so the git phase pushes and opens
   *      a PR at the end.
   *   2. Suppresses the project-mode stopped/complete summary in favour
   *      of the ship-specific blocks printed by `commands/ship.ts`.
   */
  readonly ship?: boolean;
  /**
   * Combined with `ship: true`, overrides `config.git.createPR` to
   * false (push still honours `ship`). Project-mode ship sets this per
   * task so the individual runs push their commits to the remote but
   * don't open a PR — one project-level PR is opened after all tasks
   * complete.
   */
  readonly noCreatePR?: boolean;
}

// Phases registered so far. Each step in task-list.md adds to this list.
// Order matters — it's the pipeline execution order.
const PHASES: readonly Phase[] = [
  preflightPhase,
  designPhase,
  specPhase,
  contextPhase,
  buildPhase,
  reconcilePhase,
  hardGatesPhase,
  qaPhase,
  e2ePhase,
  softGatesPhase,
  prAssemblyPhase,
  gitPhase,
];

export async function runCommand(args: RunCommandArgs): Promise<number> {
  if (args.project !== undefined) {
    process.stderr.write(
      'run: --project flag is deprecated. Pass the project as the positional argument: `harness run <project>`.\n',
    );
    return 64;
  }
  if (!args.task) {
    process.stderr.write(
      'run: task or project reference required (e.g. `harness run tick/1-types` or `harness run tick`)\n',
    );
    return 64;
  }

  // Project mode: no slash in the slug.
  if (!args.task.includes('/')) {
    return runProjectMode(args.task, args);
  }

  return runSingleTask(args.task, args);
}

async function runSingleTask(
  slug: string,
  args: RunCommandArgs,
): Promise<number> {
  let taskRef: TaskRef;
  try {
    taskRef = parseTaskSlug(slug);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 64;
  }

  // --stop-after in single-task mode must be a PhaseId.
  let stopAfterPhase: PhaseId | undefined;
  if (args.stopAfter !== undefined) {
    if (!(PHASE_IDS as readonly string[]).includes(args.stopAfter)) {
      process.stderr.write(
        `run: --stop-after '${args.stopAfter}' is not a phase id. In single-task mode ` +
          `--stop-after accepts only phase ids: ${PHASE_IDS.join(', ')}. For task-level ` +
          `stop-after, use project mode: \`harness run <project> --stop-after <task>\`.\n`,
      );
      return 64;
    }
    stopAfterPhase = args.stopAfter as PhaseId;
  }

  // --from in single-task mode only accepts a phase. Task-scoped shapes
  // are rejected with a message pointing at project mode.
  let fromPhase: PhaseId | undefined;
  if (args.from !== undefined) {
    if (args.from.kind === 'phase') {
      fromPhase = args.from.phase;
    } else {
      process.stderr.write(
        `run: --from <task> is not valid in single-task mode (you already specified the task). Either:\n` +
          `  harness run ${taskRef.project} --resume --from ${args.from.kind === 'task-phase' ? `${args.from.task}/${args.from.phase}` : args.from.task}      (project mode)\n` +
          `  harness run ${taskRef.project}/${taskRef.task} --resume --from <phase>\n`,
      );
      return 64;
    }
  }

  let paths;
  let config;
  try {
    paths = resolveHarnessPaths();
    config = loadConfig(paths);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`harness: startup failed: ${msg}\n`);
    return 1;
  }

  if (args.ship) {
    config = withShipOverrides(config, { noCreatePR: args.noCreatePR === true });
  }

  const taskPaths = resolveTaskPaths(paths, taskRef);
  mkdirSync(taskPaths.runsDir, { recursive: true });

  const taskFrontmatter = readFrontmatterOrDefault(taskPaths.taskFile, taskRef);

  const runId = args.resume
    ? (detectResumeRunId(taskPaths.currentRunSymlink) ?? resolveRunId())
    : resolveRunId();
  const runPaths = resolveRunPaths(taskPaths, runId);
  mkdirSync(runPaths.runDir, { recursive: true });
  mkdirSync(runPaths.outputsDir, { recursive: true });
  updateCurrentSymlink(taskPaths.currentRunSymlink, runPaths.runDir);

  let lockHandle: LockHandle;
  try {
    const acquired = acquireLock({ path: taskPaths.lockFile, runId });
    if (acquired.staleCleared) {
      process.stderr.write(
        `harness: cleared stale lock (pid ${acquired.staleCleared.pid}, run ${acquired.staleCleared.runId})\n`,
      );
    }
    lockHandle = acquired.handle;
  } catch (err) {
    if (err instanceof LockError) {
      process.stderr.write(
        `harness: task is locked by pid ${err.existingPid} (run ${err.existingRunId})\n`,
      );
      return 1;
    }
    throw err;
  }

  const logger = createLogger({
    runId,
    project: taskRef.project,
    task: taskRef.task,
    eventsFile: runPaths.eventsFile,
    logFile: runPaths.logFile,
  });

  const branch = sanitizeBranch(taskRef, runId);

  const flags: RunFlags = {
    resume: args.resume,
    patchParent: null,
    nonInteractive: args.nonInteractive,
    ...(stopAfterPhase !== undefined ? { stopAfter: stopAfterPhase } : {}),
    ...(fromPhase !== undefined ? { resumeFrom: fromPhase } : {}),
    dryRun: args.dryRun,
  };

  // run.json is written up front so debug/status can see the run exists.
  // Unlike state.json, this is metadata (not progress), so pre-emptive
  // write is correct.
  writeRunMeta(
    runPaths.runMetaFile,
    createRunMeta({ runId, task: taskRef, branch, flags }),
  );

  let shuttingDownFlag = false;
  const ctx: RunContext = {
    config,
    paths,
    taskPaths,
    runPaths,
    logger,
    task: taskRef,
    branch,
    taskFrontmatter,
    capabilities: null,
    outputs: {},
    flags,
    shuttingDown: () => shuttingDownFlag,
  };

  try {
    const code = await runPipeline({
      phases: [...PHASES],
      ctx,
      lockHandle,
      setShuttingDown: () => {
        shuttingDownFlag = true;
      },
    });
    return code;
  } catch (err) {
    if (err instanceof EscalationError) {
      process.stderr.write(`ESCALATION: ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`harness: run failed: ${msg}\n`);
    return 1;
  } finally {
    try {
      await logger.close();
    } catch {
      // swallow — close is best-effort
    }
    lockHandle.release();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateCurrentSymlink(symlinkPath: string, targetDir: string): void {
  try {
    unlinkSync(symlinkPath);
  } catch {
    // not present, that's fine
  }
  try {
    symlinkSync(targetDir, symlinkPath);
  } catch {
    // symlink creation can fail on filesystems without link support;
    // not critical — --resume falls back to scanning when the symlink
    // is absent.
  }
}

function detectResumeRunId(currentSymlink: string): string | null {
  try {
    const target = readLinkSafely(currentSymlink);
    if (!target) return null;
    const parts = target.split('/');
    const last = parts[parts.length - 1];
    return last ?? null;
  } catch {
    return null;
  }
}

function readLinkSafely(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readlinkSync(path);
  } catch {
    return null;
  }
}

// Resolve the task's frontmatter from the on-disk task file.
//
// Task files come in two shapes:
//   1. Harness-native: opens with a `---`-delimited YAML frontmatter block
//      carrying `type:`, `hasDesign:`, `depends:` etc.
//   2. Task-breaker agent output: no frontmatter block. Type is derived
//      from the `## File Manifest` YAML block (all test/story entries →
//      `e2e`, any `.tsx`/`.jsx` impl → `ui`, otherwise `logic`).
//      `depends-on:` is parsed from the top-of-file markdown listing.
//
// Both shapes fall back to a safe placeholder if neither signal is
// present, so project mode's "no phases registered" path still works.
function readFrontmatterOrDefault(
  taskFile: string,
  ref: TaskRef,
): TaskFrontmatter {
  const defaultFrontmatter: TaskFrontmatter = {
    type: 'ui',
    hasDesign: false,
    project: ref.project,
    depends: [],
  };
  if (!existsSync(taskFile)) return defaultFrontmatter;
  try {
    const raw = readFileSync(taskFile, 'utf8');
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n---/m.exec(raw);
    if (match) {
      return parseSimpleFrontmatter(match[1]!, ref, defaultFrontmatter);
    }
    return deriveFrontmatterFromAgentMarkdown(raw, ref, defaultFrontmatter);
  } catch {
    return defaultFrontmatter;
  }
}

function deriveFrontmatterFromAgentMarkdown(
  raw: string,
  ref: TaskRef,
  fallback: TaskFrontmatter,
): TaskFrontmatter {
  return {
    type: deriveTypeFromManifest(raw) ?? fallback.type,
    hasDesign: fallback.hasDesign,
    project: ref.project,
    depends: parseDependsOnList(raw),
  };
}

// Find the first ```yaml block after a `## File Manifest` heading and
// classify the manifest shape. We parse deliberately narrowly — just
// enough structure to infer task type without pulling in a YAML lib.
function deriveTypeFromManifest(raw: string): TaskType | null {
  const manifestBlock = extractManifestYamlBlock(raw);
  if (!manifestBlock) return null;

  // Each entry starts with `- path: ...` or `- test: true`. We scan each
  // entry-block's `path:` and boolean markers to classify.
  const entries = splitManifestEntries(manifestBlock);
  if (entries.length === 0) return null;

  let hasUiImpl = false;
  let everyEntryIsTestOrStory = true;
  for (const entry of entries) {
    const pathMatch = /^\s*path:\s*([^\s#]+)/m.exec(entry);
    const path = pathMatch ? pathMatch[1]! : '';
    const isTest = /^\s*test:\s*true\b/m.test(entry);
    const isStory = /^\s*story:\s*true\b/m.test(entry);
    const kindMatch = /^\s*kind:\s*(\w+)/m.exec(entry);
    const kind = kindMatch ? kindMatch[1]! : '';
    const isKindTestOrStory = kind === 'test' || kind === 'story';

    if (!isTest && !isStory && !isKindTestOrStory) {
      everyEntryIsTestOrStory = false;
      if (path.endsWith('.tsx') || path.endsWith('.jsx')) {
        hasUiImpl = true;
      }
    }
  }

  if (everyEntryIsTestOrStory) return 'e2e';
  if (hasUiImpl) return 'ui';
  return 'logic';
}

function extractManifestYamlBlock(raw: string): string | null {
  const headingIdx = raw.search(/^##\s+File Manifest\b/m);
  if (headingIdx === -1) return null;
  const afterHeading = raw.slice(headingIdx);
  const fenceMatch = /```ya?ml\s*\r?\n([\s\S]*?)\r?\n```/m.exec(afterHeading);
  if (!fenceMatch) return null;
  return fenceMatch[1]!;
}

function splitManifestEntries(block: string): string[] {
  // Strip an optional leading `manifest:` key. Entries are top-level `-`
  // list items at 2-space indent (js-yaml convention the agent emits).
  const lines = block.split(/\r?\n/);
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s*manifest:\s*$/.test(line)) continue;
    if (/^\s*-\s/.test(line)) {
      if (current.length > 0) entries.push(current.join('\n'));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) entries.push(current.join('\n'));
  return entries;
}

// Parse the `depends-on:` block that the task-breaker agent writes near
// the top of the task file. Accepts either an inline empty list or a
// multi-line `- <project>/<N>-<name>` sequence ended by a blank line
// or a `##` heading.
function parseDependsOnList(raw: string): string[] {
  const idx = raw.search(/^depends-on:/m);
  if (idx === -1) return [];
  const after = raw.slice(idx);
  const newline = after.indexOf('\n');
  if (newline === -1) return [];
  const body = after.slice(newline + 1);
  const deps: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) {
      if (deps.length > 0) break; // blank line ends the list
      continue;
    }
    if (/^##\s/.test(line)) break; // next heading
    const m = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!m) break; // non-list line ends the block
    const value = m[1]!.replace(/^['"]|['"]$/g, '');
    if (value.length > 0) deps.push(value);
  }
  return deps;
}

function parseSimpleFrontmatter(
  block: string,
  ref: TaskRef,
  fallback: TaskFrontmatter,
): TaskFrontmatter {
  const fields = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    fields.set(key, value);
  }
  const type = parseTaskType(fields.get('type')) ?? fallback.type;
  const hasDesign =
    fields.get('hasDesign') === 'true'
      ? true
      : fields.get('hasDesign') === 'false'
        ? false
        : fallback.hasDesign;
  const project = fields.get('project') ?? ref.project;
  const depends = parseList(fields.get('depends'));
  return { type, hasDesign, project, depends };
}

function parseTaskType(raw: string | undefined): TaskType | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (
    lowered === 'ui' ||
    lowered === 'logic' ||
    lowered === 'e2e' ||
    lowered === 'data'
  ) {
    return lowered;
  }
  return null;
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0);
}

// Keep an unused lock-peek helper available to stop-after logic later.
void readLockIfExists;

// ---------------------------------------------------------------------------
// Project mode
// ---------------------------------------------------------------------------

async function runProjectMode(
  project: string,
  args: RunCommandArgs,
): Promise<number> {
  let paths;
  try {
    paths = resolveHarnessPaths();
    loadConfig(paths); // validate config; we'll re-load inside each single task.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`harness: startup failed: ${msg}\n`);
    return 1;
  }

  const projectDir = resolve(paths.tasksDir, project);
  if (!existsSync(projectDir)) {
    process.stderr.write(
      `run: project not found — no directory at ${projectDir}\n`,
    );
    return 64;
  }

  const graph = loadDependencyGraph(
    resolve(projectDir, 'dependency-graph.yml'),
  );
  const allTasks = collectProjectTasks(projectDir, graph);
  if (allTasks.length === 0) {
    process.stderr.write(
      `run: ${project} has no task files (looked for <N>-<name>.md under ${projectDir})\n`,
    );
    return 64;
  }

  // Resolve --from to a concrete (task, phase?) pair. Project mode
  // accepts task / task-phase. A bare phase auto-scopes only when the
  // project has exactly one task; otherwise it's ambiguous and we
  // print the correct syntax options.
  let fromTargetTask: string | null = null;
  let fromTargetPhase: PhaseId | undefined;
  if (args.from !== undefined) {
    const f = args.from;
    if (f.kind === 'phase') {
      if (allTasks.length === 1) {
        const only = allTasks[0]!;
        process.stderr.write(
          `run: --from <phase> in project mode auto-scoped to the only task (${only}).\n`,
        );
        fromTargetTask = only;
        fromTargetPhase = f.phase;
      } else {
        process.stderr.write(
          `run: --from <phase> in project mode is ambiguous when the project has multiple tasks. Use one of:\n` +
            `  harness run ${project} --resume --from <task>\n` +
            `  harness run ${project} --resume --from <task>/${f.phase}\n` +
            `  harness run ${project}/<task> --resume --from ${f.phase}\n`,
        );
        return 64;
      }
    } else {
      const resolution = resolveProjectTaskNameTyped(project, f.task);
      if (!resolution.ok) {
        process.stderr.write(`run: ${resolution.message}\n`);
        return 64;
      }
      if (!allTasks.includes(resolution.task)) {
        process.stderr.write(
          `run: --from task '${resolution.task}' is not part of ${project}. Known tasks: ${allTasks.join(', ')}\n`,
        );
        return 64;
      }
      fromTargetTask = resolution.task;
      if (f.kind === 'task-phase') fromTargetPhase = f.phase;
    }
  }

  // --stop-after in project mode must be a task id that exists in the project.
  let stopAfterTask: string | undefined;
  if (args.stopAfter !== undefined) {
    if ((PHASE_IDS as readonly string[]).includes(args.stopAfter)) {
      process.stderr.write(
        `run: --stop-after '${args.stopAfter}' is a phase id. Project mode's ` +
          `--stop-after takes a task id. Phase-level stop-after is single-task ` +
          `mode: \`harness run <project>/<task> --stop-after ${args.stopAfter}\`.\n`,
      );
      return 64;
    }
    if (!allTasks.includes(args.stopAfter)) {
      process.stderr.write(
        `run: --stop-after '${args.stopAfter}' not found in ${project}. Known tasks: ${allTasks.join(', ')}\n`,
      );
      return 64;
    }
    stopAfterTask = args.stopAfter;
  }

  // Resume semantics:
  //   - `--resume`: seed `completed` from each task's prior state on disk.
  //     Tasks whose state.json says `status: complete` are skipped; the
  //     run picks up from the next not-yet-complete task. (Matches the
  //     earlier default.)
  //   - default (no --resume): start fresh — every task is retried. We
  //     still read prior state to COUNT how many completes would be
  //     discarded, so we can show a confirmation prompt.
  //
  // `parked` is populated only for THIS invocation: a task that escalates
  // during this run goes into parked and its dependents stay blocked for
  // the remainder of the run. They'll be attempted again next `harness
  // run <project>`.
  const completed = new Set<string>();
  const parked = new Set<string>();
  const skippedByHuman = new Set<string>();
  const priorCompleted: string[] = [];
  for (const task of allTasks) {
    const state = readCurrentTaskState(paths, project, task);
    if (state?.status === 'complete') {
      priorCompleted.push(task);
      if (args.resume) completed.add(task);
    } else if (state?.status === 'skipped-by-human') {
      // --skip tasks always count as complete for dependency resolution,
      // independently of --resume. The human has explicitly decided this
      // task is not going to be built in this project.
      completed.add(task);
      skippedByHuman.add(task);
    }
  }

  // --from <task>[/<phase>]: skip everything before the target task by
  // marking earlier tasks as complete for dependency resolution, and
  // force-re-run the target itself even if prior state said complete.
  // Dependents run as normal after the target finishes.
  if (fromTargetTask !== null) {
    const targetIdx = allTasks.indexOf(fromTargetTask);
    for (let i = 0; i < targetIdx; i += 1) {
      completed.add(allTasks[i]!);
    }
    completed.delete(fromTargetTask);
    parked.delete(fromTargetTask);
  }

  if (args.dryRun) {
    return printWavePlan(project, graph, allTasks, completed, parked, stopAfterTask);
  }

  // Fresh-start confirmation: if we're NOT resuming and there's prior
  // complete state on disk, warn the user before throwing it away. Run
  // history under `runs/` is preserved regardless — this just means
  // those tasks will be re-executed on new branches.
  if (!args.resume && priorCompleted.length > 0) {
    const bypass = args.force === true || args.nonInteractive;
    if (!bypass) {
      const proceed = await confirmDiscardPriorState(project, priorCompleted);
      if (!proceed) {
        process.stderr.write('aborted — no changes.\n');
        return 0;
      }
    } else if (args.force !== true && args.nonInteractive) {
      process.stdout.write(
        `${project}: --non-interactive set; retrying ${priorCompleted.length} task(s) that were previously complete.\n`,
      );
    }
  }

  // Live run.
  const retryingCount = allTasks.length - completed.size;
  const intro = args.resume
    ? `${project} — ${allTasks.length} task(s); ${completed.size} already complete, ${retryingCount} to attempt`
    : `${project} — ${allTasks.length} task(s); starting from scratch (prior run state ignored)`;
  process.stdout.write(`${intro}\n\n`);

  const runStart = Date.now();
  const runDurations = new Map<string, number>();
  let stoppedBy: StoppedBy | null = null;
  while (true) {
    const ready = getReadyTasks({ graph, completed, parked });
    const filteredReady = ready.filter(
      (t) => !completed.has(t) && !parked.has(t),
    );
    if (filteredReady.length === 0) break;

    const nextTask = filteredReady[0]!;
    // No separator here — runPipeline prints its own `━━━ <task> ━━━` task
    // banner via logTaskStart, and logTaskEnd closes each task's block.
    // Between tasks, a blank line keeps the boundaries readable.
    if (completed.size + parked.size > 0) process.stdout.write('\n');
    const taskStart = Date.now();
    // Build a single-task args object. Strip project-level --stop-after
    // (it refers to a task id and is meaningless inside one task's pipeline).
    // When --from targets this task, resume its prior run dir and pass
    // the phase through so the pipeline picks up mid-stream.
    const isFromTarget = fromTargetTask !== null && nextTask === fromTargetTask;
    const perTaskArgs: RunCommandArgs = {
      task: `${project}/${nextTask}`,
      dryRun: false,
      resume: isFromTarget,
      nonInteractive: args.nonInteractive,
      ship: args.ship === true,
      // Project ship opens ONE PR after every task completes — per-task
      // runs push their commits so the remote stays current, but skip PR
      // creation. createProjectPullRequest below handles the single PR.
      noCreatePR: args.ship === true,
      ...(isFromTarget && fromTargetPhase !== undefined
        ? { from: { kind: 'phase', phase: fromTargetPhase } }
        : {}),
    };
    const code = await runSingleTask(`${project}/${nextTask}`, perTaskArgs);
    runDurations.set(nextTask, Date.now() - taskStart);

    // Exit codes: 0 = complete, 130 = interrupted (propagate), else escalated/failed.
    if (code === 130) {
      process.stderr.write(
        `project run interrupted at ${project}/${nextTask}\n`,
      );
      return 130;
    }
    if (code === 0) {
      completed.add(nextTask);
      if (stopAfterTask && nextTask === stopAfterTask) {
        process.stdout.write(
          `\n--stop-after ${stopAfterTask}: halting project run\n\n`,
        );
        break;
      }
      continue;
    }

    // Non-zero exit — the task ended in a terminal non-complete status
    // (escalated, failed, interrupted). Stop the whole project run:
    // anything that depends on this task can't run, and anything that
    // doesn't isn't worth silently skipping past a hard failure.
    const taskState = readCurrentTaskState(paths, project, nextTask);
    const rawStatus = taskState?.status ?? 'failed';
    const status: StoppedBy['status'] =
      rawStatus === 'escalated' || rawStatus === 'interrupted'
        ? rawStatus
        : 'failed';
    parked.add(nextTask);
    stoppedBy = { task: nextTask, status };
    break;
  }

  // Project-level PR. Only on fully-successful ship runs: every queued
  // task completed, no parks, no skips of type `failed`. A skipped-by-
  // human task does NOT block the project PR — that's an explicit human
  // decision, not a failure.
  if (args.ship === true && stoppedBy === null && !args.dryRun) {
    const completedOrdered = allTasks.filter(
      (t) => completed.has(t) && !skippedByHuman.has(t),
    );
    if (completedOrdered.length > 0) {
      process.stdout.write('\n');
      await createProjectPullRequest({
        paths,
        project,
        completedTasks: completedOrdered,
        skippedByHumanTasks: [...skippedByHuman].sort(),
      });
    }
  }

  // `harness ship` prints its own top-level blocks (shipped/STOPPED) —
  // suppress the project-mode summary in that case to avoid two
  // competing summaries on screen.
  if (args.ship !== true) {
    printProjectSummary(
      paths,
      project,
      graph,
      allTasks,
      completed,
      parked,
      runDurations,
      stoppedBy,
    );
    const totalMs = Date.now() - runStart;
    process.stdout.write(`  project run time: ${formatDuration(totalMs)}\n`);
  }

  if (stoppedBy !== null) return 1;
  return parked.size > 0 ? 1 : 0;
}

/**
 * Produce a config whose git.push and git.createPR are both `true`, for
 * the duration of a single `harness ship` run. Other fields pass
 * through unchanged. Returns a new object — the caller's original
 * HarnessConfig is not mutated.
 */
function withShipOverrides(
  config: HarnessConfig,
  opts: { noCreatePR?: boolean } = {},
): HarnessConfig {
  return {
    ...config,
    git: { push: true, createPR: opts.noCreatePR !== true },
  };
}

interface StoppedBy {
  readonly task: string;
  readonly status: 'failed' | 'escalated' | 'interrupted';
}

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------

/**
 * Prompt the user before discarding prior task-completion state on a
 * fresh project run. Returns true on y/yes/Y (case-insensitive empty
 * = no). When stdin is not a TTY (piped) we refuse without prompting —
 * the caller is expected to pass `--force` or `--non-interactive`
 * explicitly in non-interactive contexts.
 */
async function confirmDiscardPriorState(
  project: string,
  priorCompleted: readonly string[],
): Promise<boolean> {
  const count = priorCompleted.length;
  const sample = priorCompleted.slice(0, 3).join(', ');
  const suffix = count > 3 ? `, …` : '';
  process.stdout.write(
    `${project}: ${count} task(s) were previously complete (${sample}${suffix}).\n` +
      `This run will ignore that state and retry every task from the start.\n` +
      `Runs history under runs/${project}/ stays intact — tasks just get new branches.\n` +
      `Pass --resume to keep prior completes, or --force to skip this prompt.\n\n`,
  );

  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      'stdin is not a TTY; refusing to proceed without explicit --resume or --force.\n',
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((res) => {
      rl.question('Continue and start over? [y/N] ', res);
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

// Task files follow the `<N>-<name>.md` naming convention mandated by
// the task-breaker agent spec. Brief/README files never match the
// leading-number shape, so no special-case exclusion is needed.
const PROJECT_TASK_FILE_RE = /^\d+-.+\.md$/;

function collectProjectTasks(
  projectDir: string,
  graph: DependencyGraph,
): string[] {
  const union = new Set<string>(graph.allTasks);
  let entries: string[] = [];
  try {
    entries = readdirSync(projectDir);
  } catch {
    // Empty — projectDir doesn't exist; caller already checked.
  }
  for (const name of entries) {
    if (!PROJECT_TASK_FILE_RE.test(name)) continue;
    const full = resolve(projectDir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    union.add(name.replace(/\.md$/, ''));
  }
  return [...union].sort(naturalTaskCompare);
}

function readCurrentTaskState(
  paths: ReturnType<typeof resolveHarnessPaths>,
  project: string,
  task: string,
): RunState | null {
  const symlink = resolve(paths.tasksDir, project, task, 'runs', 'current');
  if (!existsSync(symlink)) return null;
  let target: string;
  try {
    target = readlinkSync(symlink);
  } catch {
    return null;
  }
  const statePath = resolve(target, 'state.json');
  try {
    return readStateIfExists(statePath);
  } catch {
    return null;
  }
}

// Sort `1-foo`, `2-bar`, ..., `10-baz` numerically, not lexicographically.
function naturalTaskCompare(a: string, b: string): number {
  const ma = /^(\d+)(?:-|$)/.exec(a);
  const mb = /^(\d+)(?:-|$)/.exec(b);
  if (ma && mb) {
    const na = Number(ma[1]);
    const nb = Number(mb[1]);
    if (na !== nb) return na - nb;
  }
  return a.localeCompare(b);
}

// ---------------------------------------------------------------------------
// Dry-run wave plan
// ---------------------------------------------------------------------------

function printWavePlan(
  project: string,
  graph: DependencyGraph,
  allTasks: readonly string[],
  completed: ReadonlySet<string>,
  parked: ReadonlySet<string>,
  stopAfterTask: string | undefined,
): number {
  process.stdout.write(
    `${project} — execution plan (${allTasks.length} task${allTasks.length === 1 ? '' : 's'})\n\n`,
  );
  const waves = computeWaves(graph, allTasks);
  for (let i = 0; i < waves.length; i += 1) {
    const header =
      i === 0 ? 'wave 1 (no dependencies):' : `wave ${i + 1} (after wave ${i}):`;
    process.stdout.write(`  ${header}\n`);
    for (const task of waves[i]!) {
      const deps = graph.dependencies.get(task) ?? [];
      const depsText = deps.length > 0 ? `  (needs: ${deps.join(', ')})` : '';
      const tags: string[] = [];
      if (completed.has(task)) tags.push('already complete');
      else if (parked.has(task)) tags.push('escalated — skip until resolved');
      const tagText = tags.length > 0 ? `  [${tags.join('; ')}]` : '';
      process.stdout.write(`    ${task}${depsText}${tagText}\n`);
      if (stopAfterTask && task === stopAfterTask) {
        process.stdout.write(`    [stop-after: halt after this task]\n`);
      }
    }
    process.stdout.write('\n');
  }
  return 0;
}

function computeWaves(
  graph: DependencyGraph,
  allTasks: readonly string[],
): string[][] {
  const placed = new Set<string>();
  const remaining = new Set(allTasks);
  const waves: string[][] = [];
  let guard = allTasks.length + 1;
  while (remaining.size > 0 && guard-- > 0) {
    const wave: string[] = [];
    for (const task of remaining) {
      const deps = graph.dependencies.get(task) ?? [];
      if (deps.every((d) => placed.has(d))) wave.push(task);
    }
    if (wave.length === 0) {
      // Defensive: cyclic or orphan. Emit the rest as a final wave and stop.
      waves.push([...remaining].sort(naturalTaskCompare));
      break;
    }
    wave.sort(naturalTaskCompare);
    waves.push(wave);
    for (const t of wave) {
      placed.add(t);
      remaining.delete(t);
    }
  }
  return waves;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printProjectSummary(
  paths: ReturnType<typeof resolveHarnessPaths>,
  project: string,
  graph: DependencyGraph,
  allTasks: readonly string[],
  completed: ReadonlySet<string>,
  parked: ReadonlySet<string>,
  runDurations: ReadonlyMap<string, number>,
  stoppedBy: StoppedBy | null = null,
): void {
  if (stoppedBy !== null) {
    printStoppedProjectSummary(
      paths,
      project,
      graph,
      allTasks,
      completed,
      runDurations,
      stoppedBy,
    );
    return;
  }
  const useColor = shouldUseColor();
  const BANNER_WIDTH = 80;
  const tokensMap = tallyTaskTokens(paths);

  // Header: ━━━ <project> ━━━…
  const headerLeft = `━━━ ${project} `;
  const headerFill = '━'.repeat(Math.max(3, BANNER_WIDTH - headerLeft.length));
  const header = useColor
    ? `${C.violet}${C.bold}${headerLeft}${C.reset}${C.violet}${headerFill}${C.reset}`
    : `${headerLeft}${headerFill}`;
  process.stdout.write(`\n${header}\n\n`);

  const col1 = Math.max(10, ...allTasks.map((t) => t.length));
  let nComplete = 0;
  let nEscalated = 0;

  for (const task of allTasks) {
    const tokensEntry = tokensMap.get(`${project}/${task}`);
    const tokens = tokensEntry
      ? tokensEntry.promptTokensActual + tokensEntry.completionTokens
      : null;

    if (completed.has(task)) {
      nComplete += 1;
      const ms =
        runDurations.get(task) ??
        computeStateDuration(paths, project, task);
      const duration = ms ? formatDuration(ms) : '—';
      const tokensText = tokens !== null ? formatTokens(tokens) : '';
      const symbol = tint('✓', C.green, useColor);
      const name = tint(task.padEnd(col1), C.violet, useColor);
      const label = tint('complete'.padEnd(10), C.green, useColor);
      const dur = tint(duration.padEnd(8), C.dimWhite, useColor);
      const tok = tokens !== null ? tint(tokensText, C.dimCyan, useColor) : '';
      process.stdout.write(`  ${symbol}  ${name}  ${label}  ${dur}  ${tok}\n`);
    } else if (parked.has(task)) {
      nEscalated += 1;
      const ms =
        runDurations.get(task) ??
        computeStateDuration(paths, project, task);
      const duration = ms ? formatDuration(ms) : '—';
      const symbol = tint('⚠', C.amber, useColor);
      const name = tint(task.padEnd(col1), C.violet, useColor);
      const label = tint('escalated'.padEnd(10), C.amber, useColor);
      const dur = tint(duration.padEnd(8), C.dimWhite, useColor);
      process.stdout.write(`  ${symbol}  ${name}  ${label}  ${dur}\n`);
      const indent = '  '.padEnd(col1 + 8); // align with the name column
      const arrow = `→ harness/tasks/${project}/${task}/runs/current/ESCALATION.md`;
      process.stdout.write(
        `${indent}${tint(arrow, C.dimGray, useColor)}\n`,
      );
    }
    // Blocked tasks are not shown in the summary — they'll pick up on the
    // next `harness run <project>` automatically. Only surface actionable
    // state here.
  }

  const summary =
    nEscalated > 0
      ? `  ${nComplete} complete · ${nEscalated} escalated`
      : `  ${nComplete} complete`;
  process.stdout.write(`\n${summary}\n`);

  if (nEscalated > 0) {
    const firstEscalated = allTasks.find((t) => parked.has(t));
    const hint = firstEscalated
      ? `harness resume ${project}/${leadingNumber(firstEscalated) ?? firstEscalated}`
      : `harness run ${project}`;
    process.stdout.write(`  Fix the escalation then: ${hint}\n`);
  } else if (nComplete < allTasks.length) {
    process.stdout.write(`  Continue with: harness run ${project}\n`);
  }
}

/**
 * Summary variant used when the project run stops mid-stream because a
 * task ended in a non-complete terminal state. Shows completed tasks,
 * the stopping task, and every remaining task as `blocked` (with the
 * transitive-dep reason so the user can see why each is held up).
 */
function printStoppedProjectSummary(
  paths: ReturnType<typeof resolveHarnessPaths>,
  project: string,
  graph: DependencyGraph,
  allTasks: readonly string[],
  completed: ReadonlySet<string>,
  runDurations: ReadonlyMap<string, number>,
  stoppedBy: StoppedBy,
): void {
  const useColor = shouldUseColor();
  const BANNER_WIDTH = 80;

  const headerLeft = `━━━ ${project} — stopped (${stoppedBy.task} ${stoppedBy.status}) `;
  const headerFill = '━'.repeat(Math.max(3, BANNER_WIDTH - headerLeft.length));
  const headerColor = stoppedBy.status === 'escalated' ? C.amber : C.red;
  const header = useColor
    ? `${headerColor}${C.bold}${headerLeft}${C.reset}${headerColor}${headerFill}${C.reset}`
    : `${headerLeft}${headerFill}`;
  process.stdout.write(`\n${header}\n\n`);

  const col1 = Math.max(10, ...allTasks.map((t) => t.length));
  let nComplete = 0;
  let nBlocked = 0;
  const statusLabel = stoppedBy.status; // 'failed' | 'escalated' | 'interrupted'

  for (const task of allTasks) {
    if (completed.has(task)) {
      nComplete += 1;
      const ms =
        runDurations.get(task) ??
        computeStateDuration(paths, project, task);
      const duration = ms ? formatDuration(ms) : '—';
      const symbol = tint('✓', C.green, useColor);
      const name = tint(task.padEnd(col1), C.violet, useColor);
      const label = tint('complete'.padEnd(10), C.green, useColor);
      const dur = tint(duration.padEnd(8), C.dimWhite, useColor);
      process.stdout.write(`  ${symbol}  ${name}  ${label}  ${dur}\n`);
      continue;
    }

    if (task === stoppedBy.task) {
      const ms =
        runDurations.get(task) ??
        computeStateDuration(paths, project, task);
      const duration = ms ? formatDuration(ms) : '—';
      const failColor = stoppedBy.status === 'escalated' ? C.amber : C.red;
      const failSymbol = stoppedBy.status === 'escalated' ? '⚠' : '✗';
      const symbol = tint(failSymbol, failColor, useColor);
      const name = tint(task.padEnd(col1), C.violet, useColor);
      const label = tint(statusLabel.padEnd(10), failColor, useColor);
      const dur = tint(duration.padEnd(8), C.dimWhite, useColor);
      process.stdout.write(`  ${symbol}  ${name}  ${label}  ${dur}\n`);
      if (stoppedBy.status === 'escalated') {
        const indent = '  '.padEnd(col1 + 8);
        const arrow = `→ harness/tasks/${project}/${task}/runs/current/ESCALATION.md`;
        process.stdout.write(
          `${indent}${tint(arrow, C.dimGray, useColor)}\n`,
        );
      }
      continue;
    }

    // Everything else = blocked. Tell the user why: if it transitively
    // depends on the stopping task, name that; otherwise it was simply
    // further down the queue.
    nBlocked += 1;
    const reason = dependsTransitivelyOn(graph, task, stoppedBy.task)
      ? `(waiting on ${stoppedBy.task})`
      : '(would have run later)';
    const symbol = tint('—', C.dimGray, useColor);
    const name = tint(task.padEnd(col1), C.dimGray, useColor);
    const label = tint('blocked'.padEnd(10), C.dimGray, useColor);
    const dur = tint(' '.repeat(8), C.dimGray, useColor);
    const tail = tint(reason, C.dimGray, useColor);
    process.stdout.write(`  ${symbol}  ${name}  ${label}  ${dur}  ${tail}\n`);
  }

  const summary = `  ${nComplete} complete · 1 ${statusLabel} · ${nBlocked} blocked`;
  process.stdout.write(`\n${summary}\n`);

  const taskShort = leadingNumber(stoppedBy.task) ?? stoppedBy.task;
  process.stdout.write(`  Fix the issue then:\n`);
  process.stdout.write(
    `    harness resume ${project}/${taskShort}        resume the ${statusLabel} task\n`,
  );
  process.stdout.write(
    `    harness run ${project}             re-run project from next pending task\n`,
  );
}

/**
 * True if `candidate` transitively depends on `target` — i.e. `target`
 * is reachable by following `dependencies` from `candidate`.
 */
function dependsTransitivelyOn(
  graph: DependencyGraph,
  candidate: string,
  target: string,
): boolean {
  if (candidate === target) return false;
  const seen = new Set<string>();
  const stack = [candidate];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const dep of graph.dependencies.get(node) ?? []) {
      if (dep === target) return true;
      if (!seen.has(dep)) stack.push(dep);
    }
  }
  return false;
}

function tint(text: string, color: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${color}${text}${C.reset}`;
}

function leadingNumber(taskName: string): string | null {
  const m = /^(\d+)-/.exec(taskName);
  return m ? m[1]! : null;
}

function formatTokens(n: number): string {
  return `${n.toLocaleString('en-US')} tokens`;
}

function computeStateDuration(
  paths: ReturnType<typeof resolveHarnessPaths>,
  project: string,
  task: string,
): number | null {
  const state = readCurrentTaskState(paths, project, task);
  if (!state) return null;
  const s = Date.parse(state.startedAt);
  const e = Date.parse(state.updatedAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return Math.max(0, e - s);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}
