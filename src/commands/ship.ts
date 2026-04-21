// `harness ship` — one-liner that chains the full workflow:
//
//   fetch issue → plan → run all tasks → push branch → open PR
//
// Input forms:
//   harness ship <github-issue-url>       → import → plan → run
//   harness ship <project>                → plan (if brief only) → run
//   harness ship <project>/<task>         → single-task run + PR
//   harness ship <project> --resume       → continue after escalation
//   harness ship <project> --resume --skip <n>     → mark task n skipped-by-human
//   harness ship <project> --resume --restart <n>  → wipe task n state, re-run
//   harness ship <project> --resume --from <phase> → re-run from phase
//
// Under the hood ship is a thin coordinator: it resolves the input,
// optionally runs the import + task-breaker agents, mutates state to
// honour --skip / --restart, then delegates to `runCommand` with
// `ship: true` (which flips git.push + git.createPR on for the run).
// Escalation + success output is rendered by the logger's ship blocks
// so the summary is a single decision-making surface.
//
// What ship does NOT do: wrap the phase pipeline. Everything downstream
// of input resolution is the same code path as `harness run`.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  PHASE_IDS,
  STATE_SCHEMA_VERSION,
  type PhaseId,
  type RunState,
} from '../types.js';
import { runCommand, type RunCommandArgs } from './run.js';
import { loadConfig } from '../lib/config.js';
import { readProjectPullRequestResult } from '../lib/projectPr.js';
import { resolveClaudeAsset, resolveHarnessPaths } from '../lib/paths.js';
import { sumTaskTokens } from '../lib/logger.js';
import {
  logShipEscalation,
  logShipSuccess,
  type ShippedTaskSummary,
} from '../lib/logger.js';
import { readStateIfExists } from '../lib/state.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ShipCommandArgs {
  /** URL, `<project>`, or `<project>/<task>`. */
  readonly input: string;
  readonly resume: boolean;
  readonly skip?: string;
  readonly restart?: string;
  readonly from?: PhaseId;
  readonly dryRun: boolean;
  readonly nonInteractive: boolean;
  readonly force: boolean;
}

export async function shipCommand(args: ShipCommandArgs): Promise<number> {
  let resolved: ResolvedShipInput;
  try {
    resolved = await resolveShipInput(args.input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ship: ${msg}\n`);
    return 64;
  }

  if (args.dryRun) {
    printShipPlan(resolved);
    return 0;
  }

  // URL inputs: fetch the issue via gh, derive the project slug from
  // the issue title, then write the brief under that slug. If the fetch
  // fails the user gets a readable error and can retry by hand.
  if (resolved.kind === 'url') {
    let derivedProject: string;
    try {
      derivedProject = await fetchIssueAndWriteBrief({
        owner: resolved.owner,
        repo: resolved.repo,
        issue: resolved.issue,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`ship: fetching GitHub issue failed: ${msg}\n`);
      return 1;
    }
    resolved = { ...resolved, project: derivedProject };
    if (!briefPath(resolved.project)) {
      // fetchIssueAndWriteBrief writes; this is a sanity check only.
      return 1;
    }
  }

  // Planning: if the project folder has a brief but no task files, run
  // the task-breaker agent. The agent writes task files next to the
  // brief and a dependency-graph.yml — after that, project mode picks
  // them up naturally.
  if (needsPlanning(resolved)) {
    const planned = await runTaskBreaker(resolved);
    if (!planned) return 1;
  }

  // Pre-run state mutations for --skip / --restart. Both require a
  // known project; the single-task form ignores them with a warning.
  if (args.skip !== undefined) {
    if (resolved.kind === 'single-task') {
      process.stderr.write('ship: --skip only applies to project-mode runs\n');
      return 64;
    }
    const applied = applySkip(resolved.project, args.skip);
    if (!applied) return 1;
  }

  if (args.restart !== undefined) {
    if (resolved.kind === 'single-task') {
      process.stderr.write(
        'ship: --restart only applies to project-mode runs; for single-task runs omit --resume to start fresh\n',
      );
      return 64;
    }
    const applied = applyRestart(resolved.project, args.restart);
    if (!applied) return 1;
  }

  // Execute the pipeline via runCommand with ship mode on. The runner
  // writes state + artefacts as usual; ship re-reads state afterwards
  // to render its own summary block.
  const runStart = Date.now();
  const runArgs: RunCommandArgs = {
    task:
      resolved.kind === 'single-task'
        ? `${resolved.project}/${resolved.task}`
        : resolved.project,
    dryRun: false,
    resume: args.resume,
    force: args.force,
    nonInteractive: args.nonInteractive,
    ship: true,
    ...(args.from !== undefined ? { from: args.from } : {}),
  };
  const exitCode = await runCommand(runArgs);
  const totalMs = Date.now() - runStart;

  if (exitCode === 130) {
    // Interrupted — let the runner's output stand.
    return 130;
  }

  if (exitCode !== 0) {
    renderEscalation(resolved);
    return exitCode;
  }

  renderSuccess(resolved, totalMs);
  return 0;
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

type ResolvedShipInput =
  | { readonly kind: 'url'; readonly owner: string; readonly repo: string; readonly issue: string; readonly project: string }
  | { readonly kind: 'project'; readonly project: string }
  | { readonly kind: 'single-task'; readonly project: string; readonly task: string };

const GITHUB_ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/;

async function resolveShipInput(raw: string): Promise<ResolvedShipInput> {
  const trimmed = raw.trim();
  const urlMatch = GITHUB_ISSUE_URL_RE.exec(trimmed);
  if (urlMatch) {
    const [, owner, repo, issue] = urlMatch;
    // Placeholder project slug until the real one is derived from the
    // issue title by fetchIssueAndWriteBrief. Dry-run uses it to print
    // a plan; the live path overwrites `resolved.project` after fetch.
    return {
      kind: 'url',
      owner: owner!,
      repo: repo!,
      issue: issue!,
      project: repo!,
    };
  }

  if (trimmed.includes('/')) {
    const [project, task] = trimmed.split('/', 2);
    if (!project || !task) {
      throw new Error(
        `invalid <project>/<task> reference '${trimmed}'`,
      );
    }
    return { kind: 'single-task', project, task };
  }

  if (trimmed.length === 0) {
    throw new Error('task or project reference required');
  }
  return { kind: 'project', project: trimmed };
}

function printShipPlan(input: ResolvedShipInput): void {
  const steps: string[] = [];
  if (input.kind === 'url') {
    steps.push(
      `fetch GitHub issue ${input.owner}/${input.repo}#${input.issue}`,
      `derive project slug from issue title (fallback: ${input.repo}-${input.issue})`,
      `write brief to harness/tasks/<derived-slug>/brief.md`,
    );
  }
  if (input.kind !== 'single-task') {
    const hasTasks = projectHasTaskFiles(input.project);
    if (!hasTasks) {
      steps.push(
        `run task-breaker agent (project has brief but no task files)`,
      );
    } else {
      steps.push(
        `skip planning (task files already exist under harness/tasks/${input.project}/)`,
      );
    }
    steps.push(`run every task in dependency order`);
  } else {
    steps.push(`run single task ${input.project}/${input.task}`);
  }
  steps.push(`push branch to origin`, `open PR via gh pr create`);
  process.stdout.write(`ship plan — ${describeInput(input)}\n`);
  for (const step of steps) process.stdout.write(`  • ${step}\n`);
}

function describeInput(input: ResolvedShipInput): string {
  switch (input.kind) {
    case 'url':
      return `${input.owner}/${input.repo}#${input.issue} → project '${input.project}'`;
    case 'project':
      return `project ${input.project}`;
    case 'single-task':
      return `${input.project}/${input.task}`;
  }
}

// ---------------------------------------------------------------------------
// Planning (optional, driven by input shape)
// ---------------------------------------------------------------------------

function needsPlanning(input: ResolvedShipInput): boolean {
  if (input.kind === 'single-task') return false;
  if (input.kind === 'url') return true; // just wrote brief, no tasks yet
  return !projectHasTaskFiles(input.project);
}

// Task files follow the `<N>-<name>.md` naming convention mandated by
// the task-breaker agent spec (see .claude/agents/task-breaker.agent.md).
// Detect them by filename shape — the agent output has no frontmatter
// block, so a content-based check silently misclassifies every run.
const TASK_FILE_NAME_RE = /^\d+-.+\.md$/;

function projectHasTaskFiles(project: string): boolean {
  const paths = resolveHarnessPaths();
  const dir = resolve(paths.tasksDir, project);
  if (!existsSync(dir)) return false;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!TASK_FILE_NAME_RE.test(entry)) continue;
    const full = resolve(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    return true;
  }
  return false;
}

function briefPath(project: string): string | null {
  const paths = resolveHarnessPaths();
  const p = resolve(paths.tasksDir, project, 'brief.md');
  return existsSync(p) ? p : null;
}

/**
 * Fetch the GitHub issue via `gh issue view`, derive the project slug
 * from its title, write the brief under that slug, and return the slug.
 *
 * Slug derivation — `slugifyIssueTitle` below:
 *   "Interaction Review Panel"               → "interaction-review-panel"
 *   "Patient Sidebar — Select Patient"       → "patient-sidebar"
 *
 * Fallback — when gh fails, returns non-JSON, or the title normalises
 * to an empty slug — we use `<repo>-<issue>` (e.g. `ai-harness-medplum-2`)
 * so ship always has a project name to work with. A hard gh failure
 * (CLI missing, auth issue) still throws — there's nothing to write a
 * brief from in that case.
 */
async function fetchIssueAndWriteBrief(input: {
  readonly owner: string;
  readonly repo: string;
  readonly issue: string;
}): Promise<string> {
  const paths = resolveHarnessPaths();

  const ghCheck = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (ghCheck.status !== 0) {
    throw new Error(
      'gh CLI not available. Install from https://cli.github.com and authenticate with `gh auth login`.',
    );
  }
  const res = spawnSync(
    'gh',
    [
      'issue',
      'view',
      input.issue,
      '--repo',
      `${input.owner}/${input.repo}`,
      '--json',
      'title,body,url',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(
      `gh issue view failed (exit ${res.status}): ${(res.stderr || res.stdout).trim().slice(-300)}`,
    );
  }
  let parsed: { title?: string; body?: string; url?: string };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch (err) {
    throw new Error(
      `gh issue view returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fallback = `${input.repo}-${input.issue}`;
  const project = slugifyIssueTitle(parsed.title ?? '') ?? fallback;

  const projectDir = resolve(paths.tasksDir, project);
  mkdirSync(projectDir, { recursive: true });

  const brief = [
    `# ${parsed.title ?? `Issue #${input.issue}`}`,
    '',
    `Source: ${parsed.url ?? `https://github.com/${input.owner}/${input.repo}/issues/${input.issue}`}`,
    '',
    parsed.body ?? '(issue body was empty)',
    '',
  ].join('\n');

  const briefFile = resolve(projectDir, 'brief.md');
  writeFileSync(briefFile, brief, 'utf8');
  process.stdout.write(`ship: wrote brief → ${briefFile}\n`);
  return project;
}

/**
 * Derive a harness project slug from a GitHub issue title.
 *
 * Rules:
 *   - Split on em-dash / en-dash; keep only the first segment. Issue
 *     titles in the form "Topic — Subtitle" collapse to just "topic".
 *   - Lowercase, replace runs of non-alphanumerics with a single hyphen.
 *   - Trim leading/trailing hyphens.
 *   - Cap at 60 chars (trimmed to a clean hyphen boundary) — task folders
 *     and branch names embed this, and `sanitizeBranch` later adds the
 *     run ID on top.
 *   - Must start with `[a-z0-9]` to satisfy the harness TaskRef pattern.
 *
 * Returns null when the result is empty or the first char isn't
 * alphanumeric (e.g. a title of only punctuation). Caller supplies the
 * fallback.
 */
function slugifyIssueTitle(title: string): string | null {
  const primary = (title.split(/[\u2014\u2013]/)[0] ?? title).trim();
  if (primary.length === 0) return null;
  let slug = primary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 60) {
    slug = slug.slice(0, 60).replace(/-+$/, '');
  }
  if (slug.length === 0) return null;
  if (!/^[a-z0-9]/.test(slug)) return null;
  return slug;
}

/**
 * Invoke the task-breaker agent by spawning the `claude` CLI with the
 * agent prompt + brief content. Returns true on success. Failures are
 * logged but non-fatal so the user can run the agent by hand and then
 * re-invoke `harness ship` with the generated task files in place.
 */
async function runTaskBreaker(
  input: ResolvedShipInput,
): Promise<boolean> {
  if (input.kind === 'single-task') return true;
  const project = input.project;
  const paths = resolveHarnessPaths();
  const projectDir = resolve(paths.tasksDir, project);
  const briefFile = resolve(projectDir, 'brief.md');
  if (!existsSync(briefFile)) {
    process.stderr.write(
      `ship: cannot plan ${project} — no brief.md at ${briefFile}\n`,
    );
    return false;
  }
  let agentFile: string;
  try {
    agentFile = resolveClaudeAsset(paths, 'agents/task-breaker.agent.md');
  } catch (err) {
    process.stderr.write(
      `ship: task-breaker.agent.md missing at repo and package defaults: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }

  const brief = safeRead(briefFile) ?? '';
  const agent = safeRead(agentFile) ?? '';

  // When the e2e phase is globally disabled, tell the agent up front —
  // otherwise it generates an e2e task that the pipeline will skip,
  // leaving acceptance criteria uncovered.
  let e2eDisabledNote = '';
  try {
    const config = loadConfig(paths);
    if (!config.phases.e2e) {
      e2eDisabledNote =
        'IMPORTANT: config.phases.e2e is false. Do not create any tasks of ' +
        'type: e2e. Fold E2E test requirements into the acceptance criteria ' +
        'of the relevant component or integration task instead.';
    }
  } catch {
    // If config can't be loaded here, let the downstream pipeline surface
    // it — planning shouldn't fail on a config error this ship might
    // never reach.
  }

  const prompt = [
    '=== AGENT INSTRUCTIONS ===',
    agent.trim(),
    '',
    '=== PROJECT BRIEF ===',
    brief.trim(),
    '',
    '=== YOUR TASK ===',
    `Break the brief above into numbered task files and a dependency-graph.yml, written under:`,
    `  ${projectDir}`,
    `Each task file must be named <N>-<slug>.md and open with a YAML frontmatter block.`,
    ...(e2eDisabledNote ? ['', e2eDisabledNote] : []),
  ].join('\n');

  const ghCheck = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (ghCheck.status !== 0) {
    process.stderr.write(
      `ship: 'claude' CLI not available — cannot plan ${project} automatically.\n`,
    );
    process.stderr.write(
      `  Run the task-breaker agent manually with the brief at ${briefFile}, then re-invoke 'harness ship ${project}'.\n`,
    );
    return false;
  }

  process.stdout.write(`ship: planning ${project} via task-breaker agent…\n`);
  const res = spawnSync(
    'claude',
    ['--dangerously-skip-permissions', '-p'],
    {
      cwd: paths.repoRoot,
      input: prompt,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  if (res.status !== 0) {
    process.stderr.write(
      `ship: task-breaker agent exited ${res.status ?? 'unknown'}\n`,
    );
    return false;
  }
  if (!projectHasTaskFiles(project)) {
    process.stderr.write(
      `ship: task-breaker finished without writing task files under ${projectDir}\n`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// --skip / --restart state mutations
// ---------------------------------------------------------------------------

function applySkip(project: string, taskArg: string): boolean {
  const taskName = resolveProjectTaskName(project, taskArg);
  if (taskName === null) return false;
  const paths = resolveHarnessPaths();
  const runsDir = resolve(paths.tasksDir, project, taskName, 'runs');
  mkdirSync(runsDir, { recursive: true });

  // Write a synthetic run dir whose state.json claims skipped-by-human,
  // plus update the `current` symlink to point at it. This is the same
  // shape project-mode reads when deciding whether to run a task.
  const runId = syntheticRunId();
  const runDir = resolve(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const now = new Date().toISOString();
  const state: RunState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: 'skipped-by-human',
    currentPhase: null,
    completedPhases: [],
    skippedPhases: [],
    startedAt: now,
    updatedAt: now,
  };
  writeFileSync(
    resolve(runDir, 'state.json'),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );

  const symlink = resolve(runsDir, 'current');
  try {
    if (existsSync(symlink) || isBrokenSymlink(symlink)) {
      rmSync(symlink, { force: true });
    }
  } catch {
    // ignore
  }
  try {
    const { symlinkSync } = require('node:fs') as typeof import('node:fs');
    symlinkSync(runDir, symlink);
  } catch {
    // Best-effort; missing symlink just means project mode re-reads
    // via a readdir scan.
  }

  process.stdout.write(
    `ship: marked ${project}/${taskName} as skipped-by-human\n`,
  );
  return true;
}

function applyRestart(project: string, taskArg: string): boolean {
  const taskName = resolveProjectTaskName(project, taskArg);
  if (taskName === null) return false;
  const paths = resolveHarnessPaths();
  const runsDir = resolve(paths.tasksDir, project, taskName, 'runs');
  if (existsSync(runsDir)) {
    try {
      rmSync(runsDir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(
        `ship: --restart failed to clear ${runsDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return false;
    }
  }
  process.stdout.write(
    `ship: cleared prior run state for ${project}/${taskName} (will run from preflight)\n`,
  );
  return true;
}

function resolveProjectTaskName(
  project: string,
  taskArg: string,
): string | null {
  const paths = resolveHarnessPaths();
  const projectDir = resolve(paths.tasksDir, project);
  if (!existsSync(projectDir)) {
    process.stderr.write(`ship: project not found: ${project}\n`);
    return null;
  }
  const entries = readdirSync(projectDir).filter((n) => n.endsWith('.md'));
  // Accept either the numeric prefix (`3`) or the full name (`3-store`).
  const candidates = entries.filter((n) => {
    const base = n.replace(/\.md$/, '');
    return (
      base === taskArg || new RegExp(`^${escapeRegex(taskArg)}-`).test(base)
    );
  });
  if (candidates.length === 0) {
    process.stderr.write(
      `ship: task not found in ${project}: ${taskArg}\n`,
    );
    return null;
  }
  if (candidates.length > 1) {
    process.stderr.write(
      `ship: ambiguous task '${taskArg}' in ${project}: ${candidates.join(', ')}\n`,
    );
    return null;
  }
  return candidates[0]!.replace(/\.md$/, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isBrokenSymlink(path: string): boolean {
  try {
    readlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function syntheticRunId(): string {
  const now = new Date();
  const ts =
    now.getUTCFullYear().toString().padStart(4, '0') +
    (now.getUTCMonth() + 1).toString().padStart(2, '0') +
    now.getUTCDate().toString().padStart(2, '0') +
    now.getUTCHours().toString().padStart(2, '0') +
    now.getUTCMinutes().toString().padStart(2, '0') +
    now.getUTCSeconds().toString().padStart(2, '0');
  // Deterministic suffix for synthetic runs — distinct from the
  // random alphabet `resolveRunId` uses so these can be told apart
  // in run listings.
  return `${ts}_skiphm`;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function renderEscalation(resolved: ResolvedShipInput): void {
  const paths = resolveHarnessPaths();
  // Find the first task that actually escalated — an on-disk ESCALATION.md
  // under a non-complete run is the ground truth. For a single-task run
  // there's only one candidate.
  //
  // Non-task failures (preflight errors, config errors, anything that
  // exits before a run folder is written) deliberately fall through and
  // render nothing: the runner's own stderr output already explained the
  // problem, and stacking a placeholder block on top only misleads.
  const candidates =
    resolved.kind === 'single-task'
      ? [resolved.task]
      : listProjectTaskNames(resolved.project);

  for (const taskName of candidates) {
    const runsDir = resolve(paths.tasksDir, resolved.project, taskName, 'runs');
    const symlink = resolve(runsDir, 'current');
    if (!existsSync(symlink)) continue;
    const runDir = safeReadlink(symlink);
    if (!runDir) continue;
    const state = readStateIfExists(resolve(runDir, 'state.json'));
    if (!state) continue;
    if (state.status === 'complete' || state.status === 'skipped-by-human') {
      continue;
    }
    const escalationFile = resolve(runDir, 'ESCALATION.md');
    if (!existsSync(escalationFile)) continue;

    const phase = state.currentPhase ?? detectPhaseFromState(state) ?? 'unknown';
    const escalationRaw = safeRead(escalationFile) ?? '';
    const reason = parseEscalationReason(escalationRaw) ?? state.status;
    const whatHappened =
      parseEscalationDetails(escalationRaw) ?? '(no details captured)';
    const escalationPathRelative = `harness/tasks/${resolved.project}/${taskName}/runs/current/ESCALATION.md`;
    logShipEscalation({
      project: resolved.project,
      task: taskName,
      phase: String(phase),
      reason,
      whatHappened,
      escalationFile: escalationPathRelative,
      taskNumber: leadingNumber(taskName) ?? taskName,
    });
    return;
  }
}

function renderSuccess(
  resolved: ResolvedShipInput,
  totalMs: number,
): void {
  const paths = resolveHarnessPaths();
  const tasksToShow =
    resolved.kind === 'single-task'
      ? [resolved.task]
      : listProjectTaskNames(resolved.project);

  const summaries: ShippedTaskSummary[] = [];
  let branch = 'unknown';
  let prUrl: string | null = null;
  let prTitle: string | null = null;
  let totalTokens = 0;

  for (const taskName of tasksToShow) {
    const runsDir = resolve(paths.tasksDir, resolved.project, taskName, 'runs');
    const symlink = resolve(runsDir, 'current');
    if (!existsSync(symlink)) continue;
    const runDir = safeReadlink(symlink);
    if (!runDir) continue;
    const state = readStateIfExists(resolve(runDir, 'state.json'));
    if (!state) continue;

    if (state.status === 'skipped-by-human') {
      summaries.push({ name: taskName, durationMs: 0, skippedByHuman: true });
      continue;
    }
    if (state.status !== 'complete') continue;

    const durationMs =
      Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.startedAt)) ||
      0;
    summaries.push({ name: taskName, durationMs });
    totalTokens += sumTaskTokens(resolve(runDir, 'events.jsonl'));

    const gitOut = readPhaseOutput(runDir, 'git') as
      | { branch?: string; prUrl?: string | null }
      | null;
    if (gitOut?.branch) branch = gitOut.branch;
    if (gitOut?.prUrl) prUrl = gitOut.prUrl;

    const commitPath = resolve(runDir, 'COMMIT_MESSAGE.txt');
    if (prTitle === null && existsSync(commitPath)) {
      const raw = safeRead(commitPath);
      if (raw) prTitle = raw.split(/\r?\n/, 1)[0] ?? null;
    }
  }

  // Project-mode ship writes its own PR via createProjectPullRequest and
  // records the result at harness/tasks/<project>/.ship/result.json.
  // When present, prefer its branch + PR URL + title over the per-task
  // values gathered above (which will be null in project mode since
  // per-task runs are invoked with noCreatePR).
  if (resolved.kind !== 'single-task') {
    const projectResult = readProjectPullRequestResult(paths, resolved.project);
    if (projectResult) {
      branch = projectResult.branch || branch;
      if (projectResult.prUrl) prUrl = projectResult.prUrl;
      if (projectResult.title) prTitle = projectResult.title;
    }
  }

  logShipSuccess({
    project: resolved.project,
    totalMs,
    tasks: summaries,
    branch,
    prUrl,
    prTitle,
    totalTokens,
  });
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function listProjectTaskNames(project: string): string[] {
  const paths = resolveHarnessPaths();
  const dir = resolve(paths.tasksDir, project);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!TASK_FILE_NAME_RE.test(entry)) continue;
    const full = resolve(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    out.push(entry.replace(/\.md$/, ''));
  }
  out.sort(naturalTaskCompare);
  return out;
}

function naturalTaskCompare(a: string, b: string): number {
  const na = Number.parseInt(a.split('-', 1)[0] ?? '', 10);
  const nb = Number.parseInt(b.split('-', 1)[0] ?? '', 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

function readPhaseOutput(runDir: string, phase: string): unknown {
  const p = resolve(runDir, 'outputs', `${phase}.json`);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { outputs?: unknown };
    return parsed.outputs ?? null;
  } catch {
    return null;
  }
}

function parseEscalationReason(raw: string): string | null {
  const m = /^## Reason\s*\n([^\n]+)/m.exec(raw);
  if (!m) return null;
  return m[1]!.trim();
}

function parseEscalationDetails(raw: string): string | null {
  const m = /^## Details\s*\n([\s\S]*?)(?:^## |\Z)/m.exec(raw);
  if (!m) return null;
  return m[1]!.trim();
}

function detectPhaseFromState(state: RunState): string | null {
  if (state.currentPhase) return state.currentPhase;
  const last = state.completedPhases[state.completedPhases.length - 1];
  if (!last) return null;
  const idx = PHASE_IDS.indexOf(last);
  return idx >= 0 && idx + 1 < PHASE_IDS.length ? PHASE_IDS[idx + 1]! : last;
}

function leadingNumber(taskName: string): string | null {
  const m = /^(\d+)-/.exec(taskName);
  return m ? m[1]! : null;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeReadlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}
