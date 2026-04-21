// Phase 8 — E2E Gate.
//
// Runs the Playwright suite against the webServer Vite config points to.
// Flake detection is precise:
//
//   run 1: playwright ... --reporter=list,json (dual reporter — humans
//     watch the list output, we parse the JSON file).
//   run 1 all pass → complete.
//
//   run 2 (flake probe): same invocation, fresh JSON file.
//   run 2 all pass → warn flaky, complete.
//   run 2 failing set != run 1 failing set (by signature)
//     → escalate immediately. Different errors on the same code means
//       the environment is wrong — Claude can't fix that.
//   run 2 failing set == run 1 failing set
//     → correction loop (retries.e2e attempts, same shape as hardGates).
//
// Every subprocess uses stdio: ['pipe', 'pipe', 'pipe'] — never a TTY.
// Playwright's list reporter switches to an interactive format when a
// TTY is detected, which breaks the list-portion stdout we want to log.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  EscalationError,
  type E2EOutputs,
  type EscalationDetail,
  type ManifestEntry,
  type Phase,
  type PhaseResult,
  type RunContext,
  type SpecOutputs,
} from '../../types.js';
import { callAgent } from '../../lib/claude.js';
import { resolveClaudeAsset } from '../../lib/paths.js';
import {
  fallbackBefore,
  restoreSnapshot,
  takeSnapshot,
  type SnapshotHandle,
} from '../../lib/workspace.js';
import { trackChild } from '../runner.js';

export const e2ePhase: Phase<'e2e'> = {
  name: 'e2e',
  shouldRun(ctx: RunContext): boolean {
    // Global kill-switch — lets a user run the full pipeline without
    // any browser/playwright work via `config.phases.e2e: false`.
    if (!ctx.config.phases.e2e) return false;
    // Must have UI (or be an explicit E2E-only task) AND at least one
    // spec file on disk. The capabilities check protects against stale
    // `.spec.ts` files lingering in the e2e dir for a task that the
    // human declared as `type: logic` or `type: data`.
    if (!ctx.capabilities?.hasUI && !ctx.capabilities?.isE2ETask) return false;
    return e2eDirHasSpecs(ctx.taskPaths.e2eDir);
  },

  async run(ctx: RunContext): Promise<PhaseResult<E2EOutputs>> {
    const startedAt = Date.now();
    const spec = requireSpecOutputs(ctx);

    const snapshot = takeSnapshot(
      { paths: ctx.paths, taskPaths: ctx.taskPaths, runPaths: ctx.runPaths },
      'e2e',
    );
    ctx.logger.event('snapshot_taken', {
      phase: 'e2e',
      path: snapshot.path,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.checksum,
    });

    // Run 1.
    const run1 = await runPlaywright(ctx, 1);
    if (run1.exitCode === 0 && run1.failureSignatures.length === 0) {
      return {
        status: 'complete',
        durationMs: Date.now() - startedAt,
        attempts: 1,
        outputs: { passed: true, flaky: false, correctionAttempts: 0 },
      };
    }

    // Run 2 — flake probe. Same invocation, fresh report.
    ctx.logger.warn('e2e: run 1 failed — running once more for flake detection');
    const run2 = await runPlaywright(ctx, 2);

    if (run2.exitCode === 0 && run2.failureSignatures.length === 0) {
      ctx.logger.warn(
        `e2e: FLAKY — run 1 failed, run 2 passed (${run1.failureSignatures.length} failures on run 1)`,
      );
      return {
        status: 'complete',
        durationMs: Date.now() - startedAt,
        attempts: 2,
        outputs: { passed: true, flaky: true, correctionAttempts: 0 },
      };
    }

    if (!signatureSetsEqual(run1.failureSignatures, run2.failureSignatures)) {
      throw escalate(
        'e2e failures differ between identical runs — environment is flaky',
        summarizeDiff(run1.failureSignatures, run2.failureSignatures),
      );
    }

    // Deterministic failure — enter correction loop.
    let correctionAttempts = 0;
    const maxAttempts = ctx.config.retries.e2e;
    let lastFailures = run2.failureSignatures;
    const accumulatedFailures: FailureSignature[] = [
      ...run1.failureSignatures,
      ...run2.failureSignatures,
    ];

    while (correctionAttempts < maxAttempts) {
      correctionAttempts += 1;
      ctx.logger.info(
        `e2e: correction attempt ${correctionAttempts}/${maxAttempts} — restoring snapshot`,
      );
      restoreSnapshotWithFallback(ctx, snapshot);

      const prompt = buildCorrectionPrompt(ctx, spec, lastFailures, accumulatedFailures);
      const agent = await callAgent({
        ctx,
        agent: 'coding.agent (e2e correction)',
        phase: 'e2e',
        attempt: correctionAttempts,
        prompt,
        timeoutMs: ctx.config.timeouts.buildAgentMs,
      });
      ctx.logger.event('correction_attempt', {
        phase: 'e2e',
        attempt: correctionAttempts,
        failureCount: lastFailures.length,
        agentExitCode: agent.exitCode,
      });
      if (agent.exitCode !== 0) {
        throw escalate(
          `coding agent exited non-zero during e2e correction attempt ${correctionAttempts}`,
          (agent.stderr || agent.stdout).slice(-600),
        );
      }

      const nextRun = await runPlaywright(ctx, correctionAttempts + 2);
      if (nextRun.exitCode === 0 && nextRun.failureSignatures.length === 0) {
        return {
          status: 'complete',
          durationMs: Date.now() - startedAt,
          attempts: correctionAttempts + 2,
          outputs: { passed: true, flaky: false, correctionAttempts },
        };
      }
      lastFailures = nextRun.failureSignatures;
      accumulatedFailures.push(...nextRun.failureSignatures);
    }

    throw escalate(
      `e2e failed after ${correctionAttempts} correction attempts`,
      describeFailures(lastFailures),
    );
  },
};

// ---------------------------------------------------------------------------
// Playwright invocation
// ---------------------------------------------------------------------------

interface PlaywrightRunResult {
  readonly exitCode: number;
  readonly failureSignatures: readonly FailureSignature[];
  readonly durationMs: number;
}

interface FailureSignature {
  readonly file: string;
  readonly title: string;
  readonly errorLine: string;
}

function runPlaywright(ctx: RunContext, runNumber: number): Promise<PlaywrightRunResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const scratch = mkdtempSync(join(tmpdir(), `harness-playwright-${runNumber}-`));
    const reportFile = join(scratch, 'report.json');

    const e2eRel = relative(ctx.paths.harnessRoot, ctx.taskPaths.e2eDir);
    const args = [
      'playwright',
      'test',
      e2eRel,
      '--reporter=list,json',
    ];

    const env = {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
      CI: '1', // suppresses interactive prompts from playwright/vite
    };

    const child = spawn('npx', args, {
      cwd: ctx.paths.harnessRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      detached: true,
    });
    const stopTracking = trackChild(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
    }, ctx.config.timeouts.buildAgentMs);
    timer.unref();

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      stopTracking();
      const exitCode = code ?? -1;
      let signatures: FailureSignature[] = [];
      try {
        if (existsSync(reportFile)) {
          signatures = parsePlaywrightFailures(readFileSync(reportFile, 'utf8'));
        }
      } catch (err) {
        ctx.logger.warn(
          `e2e: could not parse playwright JSON report: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      ctx.logger.event('gate', {
        gate: 'e2e',
        run: runNumber,
        passed: exitCode === 0 && signatures.length === 0,
        exitCode,
        signal,
        timedOut,
        failureCount: signatures.length,
        durationMs: Date.now() - startedAt,
      });
      if (timedOut) {
        stderr += `\n[harness] playwright timed out after ${ctx.config.timeouts.buildAgentMs}ms`;
      }
      // Surface a human-readable tail to aid debugging.
      if (exitCode !== 0) {
        ctx.logger.warn(
          `e2e: run ${runNumber} exit=${exitCode} failures=${signatures.length}\n${stderr.slice(-400) || stdout.slice(-400)}`,
        );
      }
      resolvePromise({
        exitCode,
        failureSignatures: signatures,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once('error', (err) => {
      clearTimeout(timer);
      stopTracking();
      ctx.logger.error(`e2e: run ${runNumber} spawn error: ${err.message}`);
      resolvePromise({
        exitCode: -1,
        failureSignatures: [],
        durationMs: Date.now() - startedAt,
      });
    });

    child.stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// Playwright JSON report parser
//
// The report shape varies slightly across Playwright versions. We walk
// every suite recursively and collect anything with an "errors" field on
// a failed result.
// ---------------------------------------------------------------------------

interface SuiteLike {
  readonly title?: string;
  readonly file?: string;
  readonly suites?: readonly SuiteLike[];
  readonly specs?: readonly SpecLike[];
}

interface SpecLike {
  readonly title?: string;
  readonly file?: string;
  readonly tests?: readonly TestLike[];
}

interface TestLike {
  readonly results?: readonly TestResultLike[];
}

interface TestResultLike {
  readonly status?: string;
  readonly errors?: readonly { readonly message?: string }[];
  readonly error?: { readonly message?: string };
}

function parsePlaywrightFailures(raw: string): FailureSignature[] {
  const data = JSON.parse(raw) as { suites?: readonly SuiteLike[] };
  const out: FailureSignature[] = [];
  const walk = (suite: SuiteLike, parentTitles: readonly string[]): void => {
    const titleChain = suite.title ? [...parentTitles, suite.title] : parentTitles;
    for (const sub of suite.suites ?? []) walk(sub, titleChain);
    for (const s of suite.specs ?? []) {
      const specTitle = [...titleChain, s.title ?? '(untitled)'].join(' › ');
      const file = s.file ?? suite.file ?? '(unknown)';
      for (const t of s.tests ?? []) {
        for (const r of t.results ?? []) {
          if (r.status === 'passed' || r.status === 'skipped') continue;
          const messages = (r.errors ?? []).map((e) => e.message ?? '').filter(Boolean);
          const firstError = r.error?.message ?? messages[0] ?? '(no error message)';
          out.push({
            file,
            title: specTitle,
            errorLine: canonicalizeErrorLine(firstError),
          });
        }
      }
    }
  };
  for (const top of data.suites ?? []) walk(top, []);
  return out;
}

function canonicalizeErrorLine(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? '';
  // Strip ANSI and normalise whitespace so two runs with the same logical
  // error compare equal even if timings drift.
  return firstLine.replace(/\x1b\[[0-9;]*m/g, '').trim();
}

function signatureSetsEqual(
  a: readonly FailureSignature[],
  b: readonly FailureSignature[],
): boolean {
  if (a.length !== b.length) return false;
  const key = (s: FailureSignature): string => `${s.file} :: ${s.title} :: ${s.errorLine}`;
  const ka = new Set(a.map(key));
  const kb = new Set(b.map(key));
  if (ka.size !== kb.size) return false;
  for (const k of ka) if (!kb.has(k)) return false;
  return true;
}

function summarizeDiff(
  a: readonly FailureSignature[],
  b: readonly FailureSignature[],
): string {
  const lines: string[] = [];
  lines.push('--- Run 1 failures ---');
  for (const f of a) lines.push(`  ${f.title}: ${f.errorLine}`);
  lines.push('--- Run 2 failures ---');
  for (const f of b) lines.push(`  ${f.title}: ${f.errorLine}`);
  return lines.join('\n');
}

function describeFailures(failures: readonly FailureSignature[]): string {
  if (failures.length === 0) return '(no failure details captured)';
  return failures
    .map((f, i) => `${i + 1}. [${f.file}] ${f.title}\n   ${f.errorLine}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Correction prompt
// ---------------------------------------------------------------------------

function buildCorrectionPrompt(
  ctx: RunContext,
  spec: SpecOutputs,
  currentFailures: readonly FailureSignature[],
  accumulatedFailures: readonly FailureSignature[],
): string {
  const coding = readFile(resolveClaudeAsset(ctx.paths, 'agents/coding.agent.md'));
  const specText = readFile(spec.specPath);

  const impls = spec.manifestEntries.filter(
    (e: ManifestEntry) => (e.action === 'create' || e.action === 'modify') && e.kind !== 'test',
  );
  const implBlock = impls
    .map((e) => {
      const abs = resolve(ctx.paths.repoRoot, e.path);
      const body = readFileOr(abs, '(could not read)');
      return `--- ${e.path} ---\n${body}`;
    })
    .join('\n\n');

  const testFiles = collectE2eFiles(ctx.taskPaths.e2eDir);
  const testsBlock = testFiles
    .map((p) => {
      const rel = relative(ctx.paths.repoRoot, p);
      return `--- ${rel} ---\n${readFileOr(p, '(unreadable)')}`;
    })
    .join('\n\n');

  const currentBlock = describeFailures(currentFailures);
  const historyBlock = describeFailures(accumulatedFailures);

  const noTouch = spec.manifestEntries
    .filter((e) => e.action === 'no-touch')
    .map((e) => `  - ${e.path}${e.read === false ? ' (DO NOT read)' : ''}`)
    .join('\n');

  return [
    '=== CODING AGENT INSTRUCTIONS (E2E correction) ===',
    coding.trim(),
    '',
    '=== CURRENT E2E FAILURES ===',
    currentBlock,
    '',
    '=== IMPLEMENTATION FILES (full content — fix these) ===',
    implBlock || '(none)',
    '',
    '=== E2E TEST FILES (reference only — do not edit unless a test itself is wrong) ===',
    testsBlock || '(none)',
    '',
    '=== SPEC ===',
    specText.trim(),
    '',
    '=== ACCUMULATED FAILURES FROM ALL ATTEMPTS ===',
    historyBlock,
    '',
    '=== NO-TOUCH FILES ===',
    noTouch || '(none)',
    '',
    '=== YOUR TASK ===',
    'Fix the implementation so the E2E tests pass. Do not modify the tests unless one is demonstrably wrong against the spec. Do not touch no-touch files. Run `npx tsc --noEmit` from the repo root before declaring done.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Snapshot restore fallback
// ---------------------------------------------------------------------------

function restoreSnapshotWithFallback(ctx: RunContext, handle: SnapshotHandle): void {
  try {
    restoreSnapshot(handle, {
      paths: ctx.paths,
      taskPaths: ctx.taskPaths,
      runPaths: ctx.runPaths,
    });
    return;
  } catch (err) {
    ctx.logger.warn(
      `e2e: primary snapshot failed verification (${err instanceof Error ? err.message : String(err)}), trying fallback`,
    );
  }
  const fb = fallbackBefore(ctx.runPaths, 'e2e');
  if (!fb) {
    throw new Error('e2e: no valid snapshot to restore from (primary corrupted, no fallback)');
  }
  ctx.logger.warn(`e2e: restoring from fallback snapshot phase=${fb.phase}`);
  restoreSnapshot(fb, {
    paths: ctx.paths,
    taskPaths: ctx.taskPaths,
    runPaths: ctx.runPaths,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function e2eDirHasSpecs(dir: string): boolean {
  if (!existsSync(dir)) return false;
  let hit = false;
  const walk = (current: string): void => {
    if (hit) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hit) return;
      const full = resolve(current, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && /\.(spec|test)\.[tj]sx?$/.test(entry)) hit = true;
      } catch {
        /* skip */
      }
    }
  };
  walk(dir);
  return hit;
}

function collectE2eFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(current, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && /\.(spec|test)\.[tj]sx?$/.test(entry)) out.push(full);
      } catch {
        /* skip */
      }
    }
  };
  walk(dir);
  return out;
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return `(could not read ${path}: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function readFileOr(path: string, fallback: string): string {
  try {
    if (!existsSync(path)) return fallback;
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function requireSpecOutputs(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error('e2e phase invoked without SpecOutputs — spec must run first');
  }
  return spec;
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'e2e',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/e2e-attempt-*.txt and the Playwright JSON reports (written to a temp dir during each run); re-run with --from e2e after fixing.',
  };
  return new EscalationError(detail);
}

// Keep mkdirSync referenced so future file-writing helpers import it.
void mkdirSync;
