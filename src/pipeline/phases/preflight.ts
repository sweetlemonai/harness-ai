// Phase 0 — Preflight.
//
// Gates the run before any agent is invoked. Every failure mode here is a
// PreflightCheckError: the runner catches that specifically and exits 1
// WITHOUT writing state.json or ESCALATION.md, because no phase has made
// progress and no pipeline state yet exists.
//
// Scope (per blueprint-v3):
//   - Node version >= config.requirements.minNodeVersion
//   - Claude Code installed and version >= config.requirements.minClaudeCodeVersion
//   - Task file exists and frontmatter type is a known enum value
//   - All required agent .md files exist
//   - .claude/CLAUDE.md exists
//   - Git identity (user.name + user.email) is configured
//   - git init + empty initial commit if the repo has no HEAD
//   - Fresh runs: create the harness/<project>/<task>-<runId> branch
//
// Dependency-graph cycle detection lives in lib/dependencies.ts (Step 7).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveClaudeAsset } from '../../lib/paths.js';
import {
  PreflightCheckError,
  TASK_TYPES,
  type Phase,
  type PhaseResult,
  type PreflightOutputs,
  type RunContext,
  type TaskType,
} from '../../types.js';

const REQUIRED_AGENTS: readonly string[] = [
  'spec.agent.md',
  'context.agent.md',
  'coding.agent.md',
  'test.agent.md',
  'reconciliation.agent.md',
  'qa.agent.md',
  'standards.agent.md',
  'accessibility.agent.md',
  'performance.agent.md',
  'security.agent.md',
  'pr-assembly.agent.md',
];

export const preflightPhase: Phase<'preflight'> = {
  name: 'preflight',
  shouldRun(): boolean {
    return true;
  },
  async run(ctx: RunContext): Promise<PhaseResult<PreflightOutputs>> {
    const startedAt = Date.now();
    ctx.logger.info('preflight: starting');

    checkNodeVersion(ctx.config.requirements.minNodeVersion);
    checkClaudeCliVersion(ctx.config.requirements.minClaudeCodeVersion);
    checkTaskFile(ctx);
    checkAgentFiles(ctx);
    checkClaudeMd(ctx);

    // git init must run before the identity check so repo-local
    // user.name / user.email (if the user sets them after cloning) is
    // visible. `git init` does not require identity; `git commit` does.
    ensureGitRepoInitialized(ctx);
    checkGitIdentity(ctx);
    ensureGitFirstCommit(ctx);

    const freshRun = !ctx.flags.resume;
    // On a fresh run we start from a clean working tree. Before creating
    // the new branch, triage anything uncommitted:
    //   • harness artifacts (workspace/, e2e/, .claude/) → commit, so a
    //     previous run's valuable output (spec.md, manifest.json,
    //     context.md, design-spec.md, E2E tests) survives.
    //   • project files (src/ and anything outside harness/) → discard,
    //     because an interrupted run's half-written code is more likely
    //     to cause confusion than to help. The new task will regenerate
    //     whatever it needs.
    if (freshRun) {
      cleanupUncommittedChanges(ctx);
    }

    if (freshRun) {
      createBranch(ctx);
    } else {
      checkoutBranch(ctx);
    }

    const durationMs = Date.now() - startedAt;
    ctx.logger.success(`preflight: ok (${durationMs}ms)`);
    return {
      status: 'complete',
      durationMs,
      attempts: 1,
      outputs: { branch: ctx.branch, freshRun },
    };
  },
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkNodeVersion(min: string): void {
  const actual = process.versions.node;
  if (!versionGte(actual, min)) {
    throw new PreflightCheckError(
      'node-version',
      `Node ${actual} < required ${min}. Install Node ${min} or newer.`,
    );
  }
}

function checkClaudeCliVersion(min: string): void {
  const found = spawnSync('claude', ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (found.status !== 0) {
    const stderr = (found.stderr ?? '').trim() || 'not reachable';
    throw new PreflightCheckError(
      'claude-cli',
      `\`claude --version\` failed: ${stderr}. Install Claude Code: npm install -g @anthropic-ai/claude-code`,
    );
  }
  const stdout = (found.stdout ?? '').toString();
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  if (!match) {
    throw new PreflightCheckError(
      'claude-cli',
      `could not parse claude version from '${stdout.trim()}'`,
    );
  }
  const actual = match[1]!;
  if (!versionGte(actual, min)) {
    throw new PreflightCheckError(
      'claude-cli',
      `Claude Code ${actual} < required ${min}. Update with: npm install -g @anthropic-ai/claude-code@latest`,
    );
  }
}

function checkTaskFile(ctx: RunContext): void {
  const path = ctx.taskPaths.taskFile;
  if (!existsSync(path)) {
    throw new PreflightCheckError(
      'task-file',
      `task file not found: ${path}. Expected at harness/tasks/${ctx.task.project}/${ctx.task.task}.md`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PreflightCheckError(
      'task-file',
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Frontmatter is optional — the task-breaker agent writes task files
  // without it (type is derived from the `## File Manifest` section
  // downstream by readFrontmatterOrDefault + inferCapabilities). When
  // frontmatter IS present, still validate the type enum so a typo
  // can't silently change pipeline behaviour.
  const fm = extractFrontmatterType(raw);
  if (fm !== null && !(TASK_TYPES as readonly string[]).includes(fm)) {
    throw new PreflightCheckError(
      'task-file',
      `${path}: frontmatter type '${fm}' is not one of ${TASK_TYPES.join(', ')}`,
    );
  }
}

function checkAgentFiles(ctx: RunContext): void {
  for (const name of REQUIRED_AGENTS) {
    let p: string;
    try {
      p = resolveClaudeAsset(ctx.paths, `agents/${name}`);
    } catch (err) {
      throw new PreflightCheckError(
        'agent-files',
        `agent file '${name}' missing at both repo (.claude/agents/) and package defaults. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const content = readFileSync(p, 'utf8');
    if (content.trim().length === 0) {
      throw new PreflightCheckError('agent-files', `agent file is empty: ${p}`);
    }
  }
}

function checkClaudeMd(ctx: RunContext): void {
  if (!existsSync(ctx.paths.claudeMdFile)) {
    throw new PreflightCheckError(
      'claude-md',
      `missing ${ctx.paths.claudeMdFile}`,
    );
  }
}

function checkGitIdentity(ctx: RunContext): void {
  const name = gitConfig(ctx.paths.repoRoot, 'user.name');
  const email = gitConfig(ctx.paths.repoRoot, 'user.email');
  if (!name || !email) {
    throw new PreflightCheckError(
      'git-identity',
      `git user.name / user.email not configured. Run:\n  git config --global user.name "Your Name"\n  git config --global user.email "you@example.com"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Git setup
// ---------------------------------------------------------------------------

function ensureGitRepoInitialized(ctx: RunContext): void {
  const gitDir = resolve(ctx.paths.repoRoot, '.git');
  if (!existsSync(gitDir)) {
    const init = runGit(ctx.paths.repoRoot, ['init']);
    if (init.status !== 0) {
      throw new PreflightCheckError(
        'git-init',
        `git init failed: ${init.stderr}`,
      );
    }
    ctx.logger.info('preflight: initialised git repo');
  }
}

function ensureGitFirstCommit(ctx: RunContext): void {
  const head = runGit(ctx.paths.repoRoot, ['rev-parse', '--verify', 'HEAD']);
  if (head.status === 0) return;

  // No commits yet — create a baseline that INCLUDES every file
  // currently in the working tree. Without `git add -A` here, a repo
  // that was just `git init`-ed has no tracked files, so downstream
  // checks like `git ls-files` return empty and the git phase's
  // staged-files verification flags every file as "unexpected".
  const add = runGit(ctx.paths.repoRoot, ['add', '-A']);
  if (add.status !== 0) {
    ctx.logger.warn(
      `preflight: git add -A for baseline failed: ${add.stderr.trim()}`,
    );
  }
  const commit = runGit(ctx.paths.repoRoot, [
    'commit',
    '-m',
    'chore: baseline',
    '--allow-empty', // degenerate case: truly empty working tree
  ]);
  if (commit.status !== 0) {
    throw new PreflightCheckError(
      'git-init',
      `git commit (baseline) failed: ${commit.stderr}`,
    );
  }
  ctx.logger.info('preflight: baseline commit created');
}

function createBranch(ctx: RunContext): void {
  const branch = ctx.branch;
  const existing = runGit(ctx.paths.repoRoot, [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}`,
  ]);
  if (existing.status === 0) {
    throw new PreflightCheckError(
      'git-branch',
      `branch '${branch}' already exists. Another run may have used this runId — retry.`,
    );
  }
  const create = runGit(ctx.paths.repoRoot, ['checkout', '-b', branch]);
  if (create.status !== 0) {
    throw new PreflightCheckError(
      'git-branch',
      `failed to create branch '${branch}': ${create.stderr}`,
    );
  }
  ctx.logger.info(`preflight: created branch ${branch}`);
}

// ---------------------------------------------------------------------------
// Fresh-run workspace triage
//
// Uncommitted changes fall into two buckets:
//   1. Harness artifacts (workspace/, e2e/, .claude/): valuable outputs of
//      a previous run — commit them so the record isn't lost. Commit is
//      made on whatever branch we're currently on (usually a stale
//      harness branch from the aborted run); the new branch we create
//      next inherits the commit via `git checkout -b`.
//   2. Project files (src/ and anything else outside harness/): discard,
//      both tracked modifications and untracked additions. Restart with
//      a known-clean application tree.
// ---------------------------------------------------------------------------

interface GitStatusEntry {
  readonly code: string; // two-character porcelain status code
  readonly path: string;
}

function cleanupUncommittedChanges(ctx: RunContext): void {
  // `-z` gives null-terminated records with UNQUOTED paths. Without it,
  // paths containing spaces or unicode come back wrapped in quotes,
  // which `git checkout --` and `git clean --` then can't match.
  const status = runGit(ctx.paths.repoRoot, ['status', '--porcelain', '-z']);
  if (status.status !== 0) {
    ctx.logger.warn(
      `preflight: git status failed (${status.stderr.trim()}) — skipping workspace triage`,
    );
    return;
  }
  const entries = parsePorcelainZ(status.stdout);
  if (entries.length === 0) return; // already clean

  const harnessEntries: GitStatusEntry[] = [];
  const projectEntries: GitStatusEntry[] = [];
  for (const e of entries) {
    if (isHarnessArtifact(e.path)) harnessEntries.push(e);
    else if (isProjectFile(ctx, e.path)) projectEntries.push(e);
    // Everything else (harness/src, harness/config.json, manually-edited
    // README, etc.) is left alone — we only touch the two categories.
  }

  if (harnessEntries.length > 0) {
    commitHarnessArtifacts(ctx, harnessEntries);
  }
  if (projectEntries.length > 0) {
    discardProjectFiles(ctx, projectEntries);
  }
}

function commitHarnessArtifacts(
  ctx: RunContext,
  entries: readonly GitStatusEntry[],
): void {
  for (const entry of entries) {
    const addRes = runGit(ctx.paths.repoRoot, ['add', '--', entry.path]);
    if (addRes.status !== 0) {
      ctx.logger.warn(
        `preflight: git add '${entry.path}' failed: ${addRes.stderr.trim()}`,
      );
    }
  }
  // After staging, we may have nothing staged if every add failed. Check
  // via diff --cached --name-only; commit would otherwise fail with
  // "nothing to commit".
  const diff = runGit(ctx.paths.repoRoot, ['diff', '--cached', '--name-only']);
  if (diff.stdout.trim().length === 0) {
    ctx.logger.info('preflight: no harness artifacts to commit');
    return;
  }
  const prevTask = parsePreviousTask(ctx);
  const message = prevTask
    ? `chore: harness workspace [${prevTask}]`
    : 'chore: harness workspace';
  const commit = runGit(ctx.paths.repoRoot, ['commit', '-m', message]);
  if (commit.status !== 0) {
    ctx.logger.warn(
      `preflight: harness-artifact commit failed: ${commit.stderr.trim()}`,
    );
    return;
  }
  ctx.logger.info(
    `preflight: committed ${entries.length} harness artifact(s) → ${message}`,
  );
}

function discardProjectFiles(
  ctx: RunContext,
  entries: readonly GitStatusEntry[],
): void {
  let restored = 0;
  let removed = 0;
  for (const entry of entries) {
    if (isUntracked(entry.code)) {
      // untracked: git clean removes the file/dir.
      const cleanRes = runGit(ctx.paths.repoRoot, [
        'clean',
        '-fd',
        '--',
        entry.path,
      ]);
      if (cleanRes.status === 0) removed += 1;
      else
        ctx.logger.warn(
          `preflight: git clean '${entry.path}' failed: ${cleanRes.stderr.trim()}`,
        );
    } else {
      // tracked but modified/deleted: restore to HEAD.
      const checkoutRes = runGit(ctx.paths.repoRoot, [
        'checkout',
        'HEAD',
        '--',
        entry.path,
      ]);
      if (checkoutRes.status === 0) restored += 1;
      else
        ctx.logger.warn(
          `preflight: git checkout '${entry.path}' failed: ${checkoutRes.stderr.trim()}`,
        );
    }
  }
  ctx.logger.warn(
    `preflight: discarded ${restored + removed} project file change(s) ` +
      `(${restored} reverted, ${removed} removed)`,
  );
}

function parsePorcelainZ(stdout: string): GitStatusEntry[] {
  // Records are NUL-separated. Each record is `XY <space> <path>`.
  // For renames and copies (code starts with R or C) the entry is
  // followed by an additional record holding the old path — we record
  // the NEW path and skip the old-path record.
  const out: GitStatusEntry[] = [];
  const records = stdout.split('\0').filter((r) => r.length >= 3);
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]!;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    out.push({ code, path });
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1; // skip the paired old-path record
    }
  }
  return out;
}

function isUntracked(code: string): boolean {
  return code === '??';
}

function isHarnessArtifact(path: string): boolean {
  return (
    path.startsWith('harness/workspace/') ||
    path === 'harness/workspace' ||
    path.startsWith('harness/e2e/') ||
    path === 'harness/e2e' ||
    path.startsWith('.claude/') ||
    path === '.claude'
  );
}

function isProjectFile(ctx: RunContext, path: string): boolean {
  // Project files live at the repo root (src/, public/, index.html,
  // package.json, vite.config.ts, etc.) — NOT inside harness/. The
  // harness folder contains tool code + its own artifacts; anything
  // outside it is the app under development.
  if (path.startsWith('harness/')) return false;
  if (path === 'harness') return false;
  // Anything already classified as a harness artifact (.claude/) is
  // excluded from this bucket.
  if (isHarnessArtifact(path)) return false;
  void ctx; // kept in the signature for future path-based rules
  return true;
}

function parsePreviousTask(ctx: RunContext): string | null {
  const res = runGit(ctx.paths.repoRoot, ['branch', '--show-current']);
  if (res.status !== 0) return null;
  const branch = res.stdout.trim();
  if (!branch) return null;
  // Format: harness/<project>/<task>-<YYYYMMDDHHmmss>-<6charRand>
  // The sanitizer lower-cases + replaces underscore in runId with
  // hyphen, so the run-id segment is `<14 digits>-<6 alnum>`.
  const m = /^harness\/([^/]+)\/(.+)-(\d{14}-[a-z0-9]{6})$/.exec(branch);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

function checkoutBranch(ctx: RunContext): void {
  const current = runGit(ctx.paths.repoRoot, ['branch', '--show-current']);
  if (current.status === 0 && current.stdout.trim() === ctx.branch) {
    return;
  }
  const res = runGit(ctx.paths.repoRoot, ['checkout', ctx.branch]);
  if (res.status !== 0) {
    throw new PreflightCheckError(
      'git-branch',
      `cannot checkout '${ctx.branch}': ${res.stderr}`,
    );
  }
  ctx.logger.info(`preflight: resumed on branch ${ctx.branch}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runGit(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args as string[], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
  };
}

function gitConfig(cwd: string, key: string): string {
  const res = runGit(cwd, ['config', '--get', key]);
  if (res.status !== 0) return '';
  return res.stdout.trim();
}

function versionGte(actual: string, min: string): boolean {
  const a = parseVersion(actual);
  const b = parseVersion(min);
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

function parseVersion(raw: string): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function extractFrontmatterType(raw: string): TaskType | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---/m.exec(raw);
  if (!match) return null;
  const block = match[1] ?? '';
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (key !== 'type') continue;
    const rawValue = trimmed.slice(idx + 1).trim();
    return rawValue as TaskType;
  }
  return null;
}
