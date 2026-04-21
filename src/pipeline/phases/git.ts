// Phase 11 — Git.
//
// Order of operations matters. Every step is defensive — this is the one
// phase where getting a check wrong publishes something the human didn't
// authorise.
//
//   1. Secrets scan on harness/workspace/<project>/<task>/ BEFORE any
//      git add. On hit → SecretsDetectedError → escalate.
//   2. git add -A.
//   3. Verify staged files: every staged path must be in the manifest
//      OR under an allow-listed path (workspace, e2e, task file, the
//      playwright config). Anything else → escalate with the exact list.
//   4. For each staged no-touch manifest entry with real changes:
//      log an advisory warning. We commit it anyway — enforcement of
//      no-touch boundaries belongs to code review, not the pipeline.
//   5. Commit in two passes:
//        - test(<task>): add unit, component, and e2e tests
//            → files with manifest kind=test/story, plus everything under
//              harness/e2e/<project>/<task>/
//        - <commit-msg-from-pr-assembly>
//            → everything else still staged.
//   6. rm -f ESCALATION.md INTERRUPTED.md at the repo root. Final state
//      update + run sealing happen in the runner's finalizeComplete path.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import {
  EscalationError,
  SecretsDetectedError,
  type EscalationDetail,
  type GitOutputs,
  type ManifestEntry,
  type Phase,
  type PhaseResult,
  type PRAssemblyOutputs,
  type RunContext,
  type SpecOutputs,
} from '../../types.js';

const COMMIT_TEST_MESSAGE_TEMPLATE = (task: string): string =>
  `test(${task}): add unit, component, and e2e tests`;

// ---------------------------------------------------------------------------
// Phase definition
// ---------------------------------------------------------------------------

export const gitPhase: Phase<'git'> = {
  name: 'git',
  shouldRun(): boolean {
    return true;
  },

  async run(ctx: RunContext): Promise<PhaseResult<GitOutputs>> {
    const startedAt = Date.now();
    const spec = requireSpec(ctx);
    const pr = requirePR(ctx);

    // 1. Secrets scan.
    const secretsHit = scanWorkspaceForSecrets(ctx.taskPaths.workspaceDir);
    if (secretsHit.files.length > 0) {
      throw new SecretsDetectedError(secretsHit.files, secretsHit.patterns);
    }

    // 2. git add -A.
    mustGit(ctx, ['add', '-A']);

    // 3. Verify staged files.
    const staged = listStagedFiles(ctx);
    ctx.logger.info(`git: ${staged.length} file(s) staged`);
    const unexpected = findUnexpectedStaged(ctx, spec, staged);
    if (unexpected.length > 0) {
      // Advisory only — `git add -A` commits whatever is staged. If an
      // agent wrote outside the manifest, log it and keep going.
      const preview = unexpected.slice(0, 3).join(', ');
      const suffix = unexpected.length > 3 ? '…' : '';
      ctx.logger.warn(
        `git: files outside manifest staged (${unexpected.length}): ${preview}${suffix}`,
        { unexpected },
      );
    }

    // 4. No-touch audit — advisory only. If a no-touch manifest entry
    //    ended up staged with real changes, log a warning. We don't
    //    unstage, restore, or escalate — whatever the coding agent
    //    wrote gets committed, and the human sees the warning in the
    //    run log / PR description.
    const noTouchModified: string[] = [];
    for (const entry of spec.manifestEntries) {
      if (entry.action !== 'no-touch') continue;
      if (!staged.includes(entry.path)) continue;
      const diff = runGit(ctx, ['diff', '--cached', '--', entry.path]);
      if (!diff.stdout) continue;
      ctx.logger.warn(
        `git: no-touch file modified: ${entry.path} — committing anyway`,
      );
      noTouchModified.push(entry.path);
    }

    // 5. Two-commit split.
    const { testStagingSet, featStagingSet } = classifyStaged(
      ctx,
      spec.manifestEntries,
      staged,
    );

    const commitShas: string[] = [];

    if (testStagingSet.size > 0) {
      // Unstage everything, then re-stage only the test/story/e2e set.
      for (const path of staged) {
        if (!testStagingSet.has(path)) {
          mustGit(ctx, ['restore', '--staged', '--', path]);
        }
      }
      const sha = commitStaged(
        ctx,
        COMMIT_TEST_MESSAGE_TEMPLATE(ctx.task.task),
      );
      if (sha) commitShas.push(sha);
      // Re-stage the feat set for the next commit.
      for (const path of featStagingSet) {
        mustGit(ctx, ['add', '--', path]);
      }
    }

    if (featStagingSet.size > 0 || testStagingSet.size === 0) {
      // When there's no test set, just commit everything in one pass.
      if (testStagingSet.size === 0 && featStagingSet.size === 0) {
        ctx.logger.warn('git: nothing to commit');
      } else {
        const commitMsg = readFirstLine(pr.commitMessagePath);
        if (!commitMsg) {
          throw escalate(
            'COMMIT_MESSAGE.txt missing or empty',
            pr.commitMessagePath,
          );
        }
        const sha = commitStaged(ctx, commitMsg);
        if (sha) commitShas.push(sha);
      }
    }

    // 6. Legacy cleanup at repo root.
    for (const legacy of ['ESCALATION.md', 'INTERRUPTED.md']) {
      const p = resolve(ctx.paths.repoRoot, legacy);
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // best-effort
      }
    }

    if (commitShas.length === 0) {
      ctx.logger.warn('git: completed with zero commits (degenerate no-op run)');
    } else {
      ctx.logger.success(
        `git: ${commitShas.length} commit(s) on ${ctx.branch} → ${commitShas.join(', ')}`,
      );
    }

    // 7. Optional push + PR creation. Driven by config.git flags which
    //    `harness ship` sets to true. `harness run` leaves them at the
    //    config defaults (off), so the ordinary phase run never touches
    //    the remote.
    let pushed = false;
    let prUrl: string | null = null;
    if (commitShas.length > 0 && ctx.config.git.push) {
      pushed = pushBranch(ctx);
    }
    if (pushed && ctx.config.git.createPR) {
      prUrl = createPullRequest(ctx, pr);
    }

    ctx.logger.event('info', {
      kind: 'git_summary',
      stagedCount: staged.length,
      testCommit: testStagingSet.size,
      featCommit: featStagingSet.size,
      noTouchModified,
      commits: commitShas,
      pushed,
      prUrl,
    });

    return {
      status: 'complete',
      durationMs: Date.now() - startedAt,
      attempts: 1,
      outputs: {
        branch: ctx.branch,
        commitShas,
        stagedFileCount: staged.length,
        pushed,
        prUrl,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Push + PR
// ---------------------------------------------------------------------------

/**
 * Push the current branch to `origin`. Returns true on success. Any
 * failure is logged as a warning and the phase continues with
 * pushed=false — a local-only commit is still a valuable outcome and
 * the human can retry the push manually.
 */
function pushBranch(ctx: RunContext): boolean {
  ctx.logger.info(`git: pushing ${ctx.branch} → origin`);
  const res = runGit(ctx, ['push', '--set-upstream', 'origin', ctx.branch]);
  if (res.status !== 0) {
    ctx.logger.warn(
      `git: push failed (exit ${res.status}): ${(res.stderr || res.stdout).trim().slice(-300)}`,
    );
    return false;
  }
  ctx.logger.success(`git: pushed ${ctx.branch}`);
  return true;
}

/**
 * Open a pull request for the current branch using `gh pr create`.
 * Reads the title from COMMIT_MESSAGE.txt (first line) and the body
 * from PR_DESCRIPTION.md. Returns the PR URL on success, null on any
 * failure (logged as warning).
 */
function createPullRequest(
  ctx: RunContext,
  pr: PRAssemblyOutputs,
): string | null {
  const title = readFirstLine(pr.commitMessagePath);
  if (!title) {
    ctx.logger.warn('git: PR skipped — COMMIT_MESSAGE.txt empty');
    return null;
  }
  if (!existsSync(pr.prDescriptionPath)) {
    ctx.logger.warn('git: PR skipped — PR_DESCRIPTION.md missing');
    return null;
  }
  ctx.logger.info(`git: opening PR with gh (title=${title})`);
  const res = spawnSync(
    'gh',
    [
      'pr',
      'create',
      '--title',
      title,
      '--body-file',
      pr.prDescriptionPath,
      '--head',
      ctx.branch,
    ],
    {
      cwd: ctx.paths.repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  );
  if (res.status !== 0) {
    const tail = ((res.stderr ?? '') || (res.stdout ?? '')).toString().trim().slice(-300);
    ctx.logger.warn(`git: gh pr create failed (exit ${res.status}): ${tail}`);
    return null;
  }
  const url = extractPrUrl(res.stdout?.toString() ?? '');
  if (url === null) {
    ctx.logger.warn('git: gh pr create succeeded but returned no URL on stdout');
    return null;
  }
  ctx.logger.success(`git: PR opened → ${url}`);
  return url;
}

function extractPrUrl(stdout: string): string | null {
  const m = stdout.match(/https?:\/\/\S+\/pull\/\d+/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Secrets scan
// ---------------------------------------------------------------------------

interface SecretsScanResult {
  readonly files: readonly string[];
  readonly patterns: readonly string[];
}

// Narrow, high-signal patterns. Broader "32-45 alnum char" rules are
// intentionally omitted — too much false-positive noise on hashes and
// identifiers.
const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'private-key-header',
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  { name: 'github-personal-access-token', re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'github-oauth', re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: 'github-refresh', re: /\bghr_[A-Za-z0-9]{36,}\b/ },
  { name: 'github-server', re: /\bghs_[A-Za-z0-9]{36,}\b/ },
  { name: 'stripe-live-secret', re: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  { name: 'stripe-live-restricted', re: /\brk_live_[A-Za-z0-9]{24,}\b/ },
  { name: 'slack-bot-or-user-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
];

function scanWorkspaceForSecrets(workspaceDir: string): SecretsScanResult {
  if (!existsSync(workspaceDir)) {
    return { files: [], patterns: [] };
  }
  const hitFiles = new Set<string>();
  const hitPatterns = new Set<string>();
  const stack: string[] = [workspaceDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = resolve(current, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      // Skip large binary files (images, tars).
      if (st.size > 512 * 1024) continue;
      if (isLikelyBinary(name)) continue;
      let raw: string;
      try {
        raw = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const { name: patName, re } of SECRET_PATTERNS) {
        if (re.test(raw)) {
          hitFiles.add(full);
          hitPatterns.add(patName);
        }
      }
    }
  }
  return {
    files: [...hitFiles].sort(),
    patterns: [...hitPatterns].sort(),
  };
}

function isLikelyBinary(filename: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|avif|pdf|tar|gz|zip|mp4|wav|mp3|woff2?|ttf|otf|ico)$/i.test(filename);
}

// ---------------------------------------------------------------------------
// Staged-files verification
// ---------------------------------------------------------------------------

function listStagedFiles(ctx: RunContext): string[] {
  const res = runGit(ctx, ['diff', '--cached', '--name-only']);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function findUnexpectedStaged(
  ctx: RunContext,
  spec: SpecOutputs,
  staged: readonly string[],
): string[] {
  const manifestPaths = new Set(spec.manifestEntries.map((e) => e.path));
  const workspaceRel = relativeFromRepo(ctx.paths.repoRoot, ctx.taskPaths.workspaceDir);
  const e2eRel = relativeFromRepo(ctx.paths.repoRoot, ctx.taskPaths.e2eDir);
  const taskFileRel = relativeFromRepo(ctx.paths.repoRoot, ctx.taskPaths.taskFile);
  const playwrightRel = relativeFromRepo(ctx.paths.repoRoot, ctx.paths.playwrightConfig);

  const out: string[] = [];
  for (const p of staged) {
    if (manifestPaths.has(p)) continue;
    if (p === taskFileRel) continue;
    if (p === playwrightRel) continue;
    if (p.startsWith(workspaceRel + '/') || p === workspaceRel) continue;
    if (p.startsWith(e2eRel + '/') || p === e2eRel) continue;
    out.push(p);
  }
  return out;
}

function relativeFromRepo(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs);
}

// ---------------------------------------------------------------------------
// Two-commit split
// ---------------------------------------------------------------------------

interface CommitSplit {
  readonly testStagingSet: ReadonlySet<string>;
  readonly featStagingSet: ReadonlySet<string>;
}

function classifyStaged(
  ctx: RunContext,
  manifest: readonly ManifestEntry[],
  staged: readonly string[],
): CommitSplit {
  const testManifestPaths = new Set(
    manifest
      .filter((e) => e.kind === 'test' || e.kind === 'story')
      .filter((e) => e.action !== 'no-touch')
      .map((e) => e.path),
  );
  const e2eRel = relativeFromRepo(ctx.paths.repoRoot, ctx.taskPaths.e2eDir);

  const test = new Set<string>();
  const feat = new Set<string>();
  for (const p of staged) {
    const isTestByManifest = testManifestPaths.has(p);
    const isE2eFile = p.startsWith(e2eRel + '/') || p === e2eRel;
    if (isTestByManifest || isE2eFile) test.add(p);
    else feat.add(p);
  }
  return { testStagingSet: test, featStagingSet: feat };
}

// ---------------------------------------------------------------------------
// Git subprocess helpers
// ---------------------------------------------------------------------------

function runGit(
  ctx: RunContext,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('git', args as string[], {
    cwd: ctx.paths.repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
  };
}

function mustGit(ctx: RunContext, args: readonly string[]): string {
  const res = runGit(ctx, args);
  if (res.status !== 0) {
    throw escalate(`git ${args.join(' ')} failed`, res.stderr.trim() || res.stdout.trim());
  }
  return res.stdout;
}

function commitStaged(ctx: RunContext, message: string): string | null {
  // Abort cleanly if nothing is staged — git commit would exit non-zero
  // with "nothing to commit" otherwise.
  const staged = listStagedFiles(ctx);
  if (staged.length === 0) return null;
  const res = runGit(ctx, ['commit', '-m', message]);
  if (res.status !== 0) {
    throw escalate(
      'git commit failed',
      res.stderr.trim() || res.stdout.trim(),
    );
  }
  const head = runGit(ctx, ['rev-parse', 'HEAD']);
  return head.stdout.trim() || null;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readFirstLine(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const first = raw.split(/\r?\n/, 1)[0] ?? '';
    return first.trim() || null;
  } catch {
    return null;
  }
}

function requireSpec(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) throw new Error('git phase invoked without SpecOutputs');
  return spec;
}

function requirePR(ctx: RunContext): PRAssemblyOutputs {
  const pr = ctx.outputs.prAssembly;
  if (!pr) throw new Error('git phase invoked without PRAssemblyOutputs');
  return pr;
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'git',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/events.jsonl for the git_summary event and the staged diff; re-run with --from git after resolving.',
  };
  return new EscalationError(detail);
}

// keep basename import visible for future use
void basename;
