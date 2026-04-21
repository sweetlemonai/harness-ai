// Gate helpers. Never eval. Every gate returns a typed GateResult.
//
// Each helper owns the exact invocation for its tool and the exact shape
// of the output it parses. That shape is the ONE thing the harness is
// not free to change — parsing regex on top of a varying format was the
// single biggest source of false signals in the Bash harness. Use the
// tool's machine-readable format (JSON flag, structured error lines),
// never "best-effort grep".
//
// durationMs is measured by this module, not the caller.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackChild } from '../pipeline/runner.js';
import type { GateResult } from '../types.js';

// ---------------------------------------------------------------------------
// runCommand — thin spawn wrapper
// ---------------------------------------------------------------------------

export interface RunCommandOpts {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
}

export interface GateExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export function runCommand(
  cmd: string,
  args: readonly string[],
  opts: RunCommandOpts,
): Promise<GateExecResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args as string[], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
      detached: true, // process group so we can SIGKILL on timeout
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
            // already gone
          }
        }
      }
    }, opts.timeoutMs);
    timer.unref();

    child.once('error', (err) => {
      clearTimeout(timer);
      stopTracking();
      resolvePromise({
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: -1,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      stopTracking();
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? -1,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

// ---------------------------------------------------------------------------
// tsc
//
// `tsc --noEmit --pretty false` emits one line per diagnostic in the
// canonical CI format:
//   src/foo.ts(12,5): error TS2322: Type 'string' is not assignable…
// We parse each line individually — never the output as a single string.
// Errors may appear on stdout (typical) or stderr; we handle both.
// ---------------------------------------------------------------------------

const TSC_LINE_RE =
  /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

export async function runTsc(opts: {
  cwd: string;
  timeoutMs: number;
}): Promise<GateResult> {
  // `-b` (build mode) handles both flat tsconfigs and project-reference
  // setups (tsconfig.json referencing tsconfig.app.json etc.). Without
  // `-b`, a references-only tsconfig is a no-op and exits 0 — silently
  // hiding errors. `--noEmit` still applies.
  const exec = await runCommand(
    'npx',
    ['tsc', '-b', '--noEmit', '--pretty', 'false'],
    { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
  );
  const lines = `${exec.stdout}\n${exec.stderr}`.split(/\r?\n/);
  const failingFiles = new Set<string>();
  const errors: string[] = [];

  for (const line of lines) {
    const m = TSC_LINE_RE.exec(line.trim());
    if (!m) continue;
    const [, file, lineNo, colNo, severity, code, message] = m;
    if (severity !== 'error') continue;
    failingFiles.add(file!);
    errors.push(`${file}(${lineNo},${colNo}): ${code} ${message}`);
  }

  // exit 0 with no parsed errors → passed.
  // exit !== 0 with no parsed errors → tsc itself failed to run (missing
  // tsconfig, etc.); surface the stderr tail as a single error.
  if (exec.exitCode !== 0 && errors.length === 0) {
    const tail = (exec.stderr || exec.stdout).trim().slice(-400);
    errors.push(`tsc exited ${exec.exitCode} with no parseable diagnostics: ${tail}`);
  }

  return {
    passed: exec.exitCode === 0 && errors.length === 0,
    failingFiles: [...failingFiles].sort(),
    errors,
    durationMs: exec.durationMs,
  };
}

// ---------------------------------------------------------------------------
// eslint
//
// `eslint --format json` prints a JSON array of file reports to stdout.
// Map errorCount > 0 files into failingFiles; flatten messages for
// `errors`. Warnings do not fail this gate (our config uses
// --max-warnings 0 which turns warnings into non-zero exit).
// ---------------------------------------------------------------------------

interface EslintFileReport {
  readonly filePath: string;
  readonly messages: ReadonlyArray<{
    readonly severity: number;
    readonly line: number;
    readonly column: number;
    readonly message: string;
    readonly ruleId: string | null;
  }>;
  readonly errorCount: number;
  readonly warningCount: number;
}

export async function runEslint(opts: {
  cwd: string;
  timeoutMs: number;
  target?: string;
}): Promise<GateResult> {
  const target = opts.target ?? 'src/';
  const exec = await runCommand(
    'npx',
    ['eslint', target, '--format', 'json', '--max-warnings', '0'],
    { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
  );

  const failingFiles = new Set<string>();
  const errors: string[] = [];

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(exec.stdout);
  } catch {
    // If eslint couldn't run at all it often writes config errors to
    // stderr with no JSON at all. Surface the stderr tail.
    if (exec.exitCode !== 0) {
      const tail = (exec.stderr || exec.stdout).trim().slice(-400);
      errors.push(`eslint exited ${exec.exitCode} with unparseable output: ${tail}`);
    }
    return {
      passed: exec.exitCode === 0 && errors.length === 0,
      failingFiles: [],
      errors,
      durationMs: exec.durationMs,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      passed: false,
      failingFiles: [],
      errors: ['eslint JSON output was not an array'],
      durationMs: exec.durationMs,
    };
  }

  for (const report of parsed as EslintFileReport[]) {
    if (!report || typeof report.filePath !== 'string') continue;
    if (report.errorCount > 0) {
      failingFiles.add(report.filePath);
    }
    for (const msg of report.messages ?? []) {
      if (msg.severity !== 2) continue; // 2 = error, 1 = warn
      errors.push(
        `${report.filePath}:${msg.line}:${msg.column}: ${msg.ruleId ?? '(no-rule)'} — ${msg.message}`,
      );
    }
  }

  return {
    passed: exec.exitCode === 0 && errors.length === 0,
    failingFiles: [...failingFiles].sort(),
    errors,
    durationMs: exec.durationMs,
  };
}

// ---------------------------------------------------------------------------
// vitest
//
// `vitest run --reporter=json --outputFile=<tmp>` writes a JSON report to
// a temp file. Stdout mixes progress and summary and is not reliable to
// parse, so we always read from the temp file and clean it up.
// ---------------------------------------------------------------------------

interface VitestReport {
  readonly numTotalTests?: number;
  readonly numFailedTests?: number;
  readonly testResults?: ReadonlyArray<VitestTestFile>;
}

interface VitestTestFile {
  readonly name?: string;
  readonly status?: string;
  readonly assertionResults?: ReadonlyArray<VitestAssertion>;
}

interface VitestAssertion {
  readonly status?: string;
  readonly fullName?: string;
  readonly failureMessages?: readonly string[];
}

export async function runVitest(opts: {
  cwd: string;
  timeoutMs: number;
  pattern?: string;
}): Promise<GateResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'harness-vitest-'));
  const reportPath = join(scratch, 'report.json');
  const args = ['vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`];
  if (opts.pattern) args.push(opts.pattern);

  const exec = await runCommand('npx', args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });

  const failingFiles = new Set<string>();
  const errors: string[] = [];

  let report: VitestReport | null = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as VitestReport;
  } catch {
    report = null;
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  if (!report) {
    if (exec.exitCode !== 0) {
      const tail = (exec.stderr || exec.stdout).trim().slice(-500);
      errors.push(`vitest exited ${exec.exitCode} with no report file: ${tail}`);
    }
    return {
      passed: exec.exitCode === 0 && errors.length === 0,
      failingFiles: [],
      errors,
      durationMs: exec.durationMs,
    };
  }

  for (const file of report.testResults ?? []) {
    const name = file.name ?? '(unknown test file)';
    if (file.status && file.status !== 'passed') {
      failingFiles.add(name);
    }
    for (const a of file.assertionResults ?? []) {
      if (a.status === 'failed') {
        const prefix = `${name} :: ${a.fullName ?? '(unnamed)'}`;
        if (a.failureMessages && a.failureMessages.length > 0) {
          for (const fm of a.failureMessages) {
            errors.push(`${prefix} — ${fm.split('\n')[0] ?? fm}`);
          }
        } else {
          errors.push(`${prefix} — failed (no message)`);
        }
      }
    }
  }

  const totalFailed = report.numFailedTests ?? errors.length;
  return {
    passed: exec.exitCode === 0 && totalFailed === 0 && errors.length === 0,
    failingFiles: [...failingFiles].sort(),
    errors,
    durationMs: exec.durationMs,
  };
}

// ---------------------------------------------------------------------------
// storybook
//
// Storybook-build has no machine-readable output. Exit code is the only
// reliable signal; on failure, capture the last ~600 chars of stderr so
// the correction loop has something to show the coding agent.
// ---------------------------------------------------------------------------

export async function runStorybook(opts: {
  cwd: string;
  timeoutMs: number;
}): Promise<GateResult> {
  const exec = await runCommand('npx', ['storybook', 'build', '--quiet'], {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
  });
  if (exec.exitCode === 0) {
    return {
      passed: true,
      failingFiles: [],
      errors: [],
      durationMs: exec.durationMs,
    };
  }
  const tail = (exec.stderr || exec.stdout).trim().slice(-600);
  return {
    passed: false,
    failingFiles: [],
    errors: [`storybook build exited ${exec.exitCode}: ${tail}`],
    durationMs: exec.durationMs,
  };
}

// ---------------------------------------------------------------------------
// Convenience resolver for absolute working dir.
// ---------------------------------------------------------------------------

export function resolveCwd(repoRoot: string): string {
  return resolve(repoRoot);
}
