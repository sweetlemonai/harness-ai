// Project-level PR creation for `harness ship <project>`.
//
// Per-task runs in project mode push their commits but do NOT open
// individual PRs (see `noCreatePR` in run.ts). After every task in the
// project completes, this module opens ONE PR against main by:
//
//   1. Reading each completed task's PR_DESCRIPTION.md + COMMIT_MESSAGE.txt
//   2. Invoking the pr-assembly agent with all task outputs + a
//      project-level prompt that asks for a senior-engineer review
//      description (architecture, grouped file changes, how to review,
//      out-of-scope notes — not per-task boilerplate)
//   3. Writing the agent's outputs to harness/tasks/<project>/.ship/
//   4. Running `gh pr create --base main --head <current-branch>` with
//      the generated title + body
//
// Failure modes (claude missing, agent empty output, gh missing, gh pr
// create fails) are all logged as warnings and the function returns a
// null PR URL — the local work is already committed and pushed, so the
// human can open the PR by hand without losing anything.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { resolveClaudeAsset } from './paths.js';
import type { HarnessPaths } from '../types.js';

export interface CreateProjectPullRequestArgs {
  readonly paths: HarnessPaths;
  readonly project: string;
  readonly completedTasks: readonly string[];
  readonly skippedByHumanTasks: readonly string[];
}

export interface ProjectPullRequestResult {
  readonly prUrl: string | null;
  readonly branch: string;
  readonly title: string | null;
}

export async function createProjectPullRequest(
  args: CreateProjectPullRequestArgs,
): Promise<ProjectPullRequestResult> {
  const { paths, project, completedTasks, skippedByHumanTasks } = args;
  const branch = currentGitBranch(paths.repoRoot) ?? 'unknown';

  if (completedTasks.length === 0) {
    warn('project-pr: no completed tasks — skipping PR creation');
    return { prUrl: null, branch, title: null };
  }

  const shipDir = resolve(paths.tasksDir, project, '.ship');
  mkdirSync(shipDir, { recursive: true });
  const commitFile = resolve(shipDir, 'COMMIT_MESSAGE.txt');
  const descriptionFile = resolve(shipDir, 'PR_DESCRIPTION.md');

  const taskInputs = collectTaskInputs(
    paths,
    project,
    completedTasks,
    skippedByHumanTasks,
  );

  const agentOk = invokePrAssemblyAgent({
    paths,
    project,
    branch,
    commitFile,
    descriptionFile,
    taskInputs,
    skippedByHumanTasks,
  });
  if (!agentOk) {
    return { prUrl: null, branch, title: null };
  }

  const title = readFirstLine(commitFile);
  if (title === null) {
    warn('project-pr: COMMIT_MESSAGE.txt missing or empty after agent run');
    return { prUrl: null, branch, title: null };
  }
  if (!existsSync(descriptionFile)) {
    warn('project-pr: PR_DESCRIPTION.md missing after agent run');
    return { prUrl: null, branch, title };
  }

  // Ensure the branch is on origin before asking gh to open the PR.
  // Per-task runs usually push already, but resumed or locally-edited
  // branches may lag — push again and let git short-circuit if it's
  // already up to date.
  pushBranch(paths.repoRoot, branch);

  const prUrl = runGhPrCreate({
    repoRoot: paths.repoRoot,
    branch,
    title,
    bodyFile: descriptionFile,
  });

  // Persist the result so commands/ship.ts can surface the PR URL in its
  // success block without having to re-invoke git / gh. Best-effort —
  // the PR itself is on the remote regardless.
  try {
    writeFileSync(
      resolve(shipDir, 'result.json'),
      `${JSON.stringify({ prUrl, branch, title }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // ignore — surface path stays the stdout line above
  }

  return { prUrl, branch, title };
}

export interface ProjectPullRequestResultFile {
  readonly prUrl: string | null;
  readonly branch: string;
  readonly title: string | null;
}

/**
 * Read the result.json persisted by {@link createProjectPullRequest}.
 * Returns null when no project-PR attempt has been made or the file is
 * missing / malformed — callers fall back to their pre-existing summary
 * path.
 */
export function readProjectPullRequestResult(
  paths: HarnessPaths,
  project: string,
): ProjectPullRequestResultFile | null {
  const file = resolve(paths.tasksDir, project, '.ship', 'result.json');
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectPullRequestResultFile>;
    if (typeof parsed.branch !== 'string') return null;
    return {
      prUrl: typeof parsed.prUrl === 'string' ? parsed.prUrl : null,
      branch: parsed.branch,
      title: typeof parsed.title === 'string' ? parsed.title : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-task inputs
// ---------------------------------------------------------------------------

interface TaskInput {
  readonly task: string;
  readonly commitMessage: string;
  readonly prDescription: string;
  readonly taskFile: string;
  readonly specTitle: string;
}

function collectTaskInputs(
  paths: HarnessPaths,
  project: string,
  completedTasks: readonly string[],
  _skippedByHumanTasks: readonly string[],
): readonly TaskInput[] {
  void _skippedByHumanTasks;
  const out: TaskInput[] = [];
  for (const task of completedTasks) {
    const runDir = resolveCurrentRunDir(paths, project, task);
    const commitMessage = runDir
      ? safeRead(resolve(runDir, 'COMMIT_MESSAGE.txt'))
      : null;
    const prDescription = runDir
      ? safeRead(resolve(runDir, 'PR_DESCRIPTION.md'))
      : null;
    const taskFile = safeRead(resolve(paths.tasksDir, project, `${task}.md`));
    out.push({
      task,
      commitMessage: (commitMessage ?? '').trim(),
      prDescription: (prDescription ?? '').trim(),
      taskFile: (taskFile ?? '').trim(),
      specTitle: extractTaskTitle(taskFile ?? '') ?? task,
    });
  }
  return out;
}

function resolveCurrentRunDir(
  paths: HarnessPaths,
  project: string,
  task: string,
): string | null {
  const symlink = resolve(paths.tasksDir, project, task, 'runs', 'current');
  if (!existsSync(symlink)) return null;
  try {
    return readlinkSync(symlink);
  } catch {
    return null;
  }
}

function extractTaskTitle(raw: string): string | null {
  const match = /^#\s+(.+)$/m.exec(raw);
  return match ? match[1]!.trim() : null;
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

interface AgentInvocationArgs {
  readonly paths: HarnessPaths;
  readonly project: string;
  readonly branch: string;
  readonly commitFile: string;
  readonly descriptionFile: string;
  readonly taskInputs: readonly TaskInput[];
  readonly skippedByHumanTasks: readonly string[];
}

function invokePrAssemblyAgent(args: AgentInvocationArgs): boolean {
  const {
    paths,
    project,
    branch,
    commitFile,
    descriptionFile,
    taskInputs,
    skippedByHumanTasks,
  } = args;

  const claudeCheck = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (claudeCheck.status !== 0) {
    warn(
      "project-pr: 'claude' CLI not available — cannot generate project PR description automatically. " +
        `Draft a description by hand from the per-task PR_DESCRIPTION.md files under harness/tasks/${project}/*/runs/current/ and run \`gh pr create\` manually.`,
    );
    return false;
  }

  let agentFile: string;
  try {
    agentFile = resolveClaudeAsset(paths, 'agents/pr-assembly.agent.md');
  } catch (err) {
    warn(
      `project-pr: pr-assembly.agent.md missing at repo and package defaults: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
  const agentBody = safeRead(agentFile) ?? '';
  const briefBody =
    safeRead(resolve(paths.tasksDir, project, 'brief.md'))?.trim() ?? '';

  const prompt = buildProjectPrompt({
    agentBody,
    briefBody,
    project,
    branch,
    commitFile,
    descriptionFile,
    taskInputs,
    skippedByHumanTasks,
  });

  process.stdout.write('project-pr: generating PR description via pr-assembly agent…\n');
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
    warn(`project-pr: pr-assembly agent exited ${res.status ?? 'unknown'}`);
    return false;
  }
  // Verify both files landed — the agent is asked to write to exact
  // absolute paths, so anything less is a failure.
  if (!existsSync(commitFile) || !existsSync(descriptionFile)) {
    warn(
      'project-pr: pr-assembly agent finished without writing both output files.',
    );
    return false;
  }
  return true;
}

function buildProjectPrompt(args: {
  agentBody: string;
  briefBody: string;
  project: string;
  branch: string;
  commitFile: string;
  descriptionFile: string;
  taskInputs: readonly TaskInput[];
  skippedByHumanTasks: readonly string[];
}): string {
  const {
    agentBody,
    briefBody,
    project,
    branch,
    commitFile,
    descriptionFile,
    taskInputs,
    skippedByHumanTasks,
  } = args;

  const taskBlocks = taskInputs.map((t, i) =>
    [
      `--- TASK ${i + 1}: ${project}/${t.task} (${t.specTitle}) ---`,
      '',
      '[task spec (trimmed)]',
      t.taskFile ? excerpt(t.taskFile, 120) : '(task file unavailable)',
      '',
      '[per-task commit message]',
      t.commitMessage || '(missing)',
      '',
      '[per-task PR_DESCRIPTION.md]',
      t.prDescription || '(missing)',
      '',
    ].join('\n'),
  );

  const skippedBlock =
    skippedByHumanTasks.length === 0
      ? '(none)'
      : skippedByHumanTasks.map((t) => `  - ${project}/${t}`).join('\n');

  return [
    '=== AGENT INSTRUCTIONS ===',
    agentBody.trim() || '(agent file empty)',
    '',
    '=== MODE OVERRIDE: PROJECT-LEVEL PR ===',
    'This is NOT a per-task PR. You are assembling a single PR that covers',
    `every task in the ${project} project (${taskInputs.length} task(s) below).`,
    'Disregard the per-task COMMIT MESSAGE FORMAT and PR DESCRIPTION REQUIREMENTS',
    'in the agent instructions above. Use the PROJECT-LEVEL REQUIREMENTS in this',
    'prompt instead.',
    '',
    '=== PROJECT BRIEF ===',
    briefBody || '(brief unavailable)',
    '',
    '=== COMPLETED TASKS (in run order) ===',
    ...taskBlocks,
    '=== SKIPPED-BY-HUMAN TASKS ===',
    skippedBlock,
    '',
    '=== RUN CONTEXT ===',
    `Project: ${project}`,
    `Branch: ${branch}`,
    `Task count: ${taskInputs.length} completed`,
    '',
    '=== REQUIRED OUTPUT FILES (absolute paths) ===',
    `COMMIT_MESSAGE.txt: ${commitFile}`,
    `PR_DESCRIPTION.md:  ${descriptionFile}`,
    '',
    '=== COMMIT MESSAGE FORMAT (project-level) ===',
    'Single line, no body. Summarise the whole feature the project delivers —',
    'NOT the last task\'s message. Format: "feat(<project-slug>): <feature summary>".',
    `For this run the slug is "${project}". Example shape:`,
    `    feat(${project}): <what the feature does, in under 12 words>`,
    '',
    '=== PR DESCRIPTION REQUIREMENTS (project-level) ===',
    'Write the description as a senior engineer preparing a real PR for review.',
    'Tight, specific, no filler. Use these sections in this order:',
    '',
    '## What was built',
    '  2-5 sentences describing the feature AND why it matters (the user-',
    '  facing / clinical problem it solves — read the brief for the why).',
    '',
    '## Architecture',
    '  Name the patterns in use: the three-layer separation (FHIR → hook →',
    '  view-model component) and the swappable `InteractionDataAdapter`',
    '  interface with a mock implementation for local/tests. 4-8 sentences.',
    '  Mention why this shape was chosen (test isolation, provider swap,',
    '  keeps UI free of raw FHIR).',
    '',
    '## Files changed',
    '  Group by CONCERN, not by task. Suggested groups: Types, Transforms,',
    '  Mock adapter + scenarios, Hook, Component (+ tests + stories),',
    '  App integration. Under each group list the paths (create/modify).',
    '',
    '## Test coverage',
    '  What is tested and how. Call out the MockClient pattern and',
    '  `@testing-library/react`. Totals by kind (unit / component /',
    '  stories) if derivable from the per-task descriptions.',
    '',
    '## How to review',
    '  Exact steps: `npm run dev`, what to open, what to look for in the',
    '  UI. Specifically mention the warfarin + aspirin scenario and the',
    '  acknowledge / override flow.',
    '',
    '## Accessibility notes',
    '  Role="alert" vs role="status" usage, keyboard reachability, any',
    '  other a11y considerations that were addressed.',
    '',
    '## Out of scope',
    '  Explicit list of what was INTENTIONALLY not built: real Medplum',
    '  API wiring, backend persistence, auth, etc.',
    '',
    skippedByHumanTasks.length > 0
      ? '## Skipped tasks\n  List each skipped-by-human task from the block above. Note they were skipped via `harness ship --skip`.\n'
      : '',
    '=== YOUR TASK ===',
    'Write both files now at the exact absolute paths shown above.',
    'No prose before or after the file writes. Do not restate this prompt.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Git + gh helpers
// ---------------------------------------------------------------------------

function pushBranch(repoRoot: string, branch: string): void {
  if (branch === 'unknown' || branch.length === 0) return;
  const res = spawnSync('git', ['push', '--set-upstream', 'origin', branch], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    warn(
      `project-pr: git push failed (exit ${res.status}): ${((res.stderr ?? '') || (res.stdout ?? '')).toString().trim().slice(-200)}`,
    );
  }
}

interface RunGhPrCreateArgs {
  readonly repoRoot: string;
  readonly branch: string;
  readonly title: string;
  readonly bodyFile: string;
}

function runGhPrCreate(args: RunGhPrCreateArgs): string | null {
  const ghCheck = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  if (ghCheck.status !== 0) {
    warn(
      "project-pr: 'gh' CLI not available — install from https://cli.github.com to open PRs automatically.",
    );
    return null;
  }
  process.stdout.write(
    `project-pr: opening PR on main ← ${args.branch} (title="${args.title}")\n`,
  );
  const res = spawnSync(
    'gh',
    [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      args.branch,
      '--title',
      args.title,
      '--body-file',
      args.bodyFile,
    ],
    {
      cwd: args.repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  );
  if (res.status !== 0) {
    const tail = ((res.stderr ?? '') || (res.stdout ?? '')).toString().trim().slice(-300);
    warn(`project-pr: gh pr create failed (exit ${res.status}): ${tail}`);
    return null;
  }
  const url = extractPrUrl(res.stdout?.toString() ?? '');
  if (url === null) {
    warn('project-pr: gh pr create succeeded but returned no URL on stdout');
    return null;
  }
  process.stdout.write(`project-pr: PR opened → ${url}\n`);
  return url;
}

function currentGitBranch(repoRoot: string): string | null {
  const res = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  const branch = (res.stdout ?? '').toString().trim();
  return branch.length > 0 ? branch : null;
}

function extractPrUrl(stdout: string): string | null {
  const m = stdout.match(/https?:\/\/\S+\/pull\/\d+/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readFirstLine(path: string): string | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  const first = raw.split(/\r?\n/, 1)[0] ?? '';
  return first.trim() || null;
}

function excerpt(raw: string, maxLines: number): string {
  const lines = raw.split(/\r?\n/);
  if (lines.length <= maxLines) return raw;
  return [...lines.slice(0, maxLines), `(truncated — ${lines.length - maxLines} more lines)`].join('\n');
}

