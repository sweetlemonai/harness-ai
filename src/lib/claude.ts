// Single entry point for invoking a Claude Code subprocess.
//
// Invariants (locked on first write):
//   1. The exact assembled prompt is written to runs/<id>/prompts/
//      <phase>-attempt-<n>.txt BEFORE the subprocess spawns.
//   2. AbortController owns the timeout. On abort we SIGKILL the whole
//      process group (process.kill(-pid, 'SIGKILL')), not just the
//      direct child — claude spawns helpers and an orphaned grandchild
//      would leak.
//   3. Stdout and stderr are captured separately. A non-zero exit is
//      not immediately fatal; if the stdout contains a valid JSON
//      contract block, we still return it so the caller can decide.
//   4. Token estimate (promptText.length / 4) is logged before the call.
//      The actual token count comes from the agent's contract block
//      when present and is logged alongside.
//   5. JSON extraction delegates to extractLastFencedJson from spec.ts —
//      there is exactly one implementation.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AgentContractError,
  AgentTimeoutError,
  type PhaseId,
  type RunContext,
} from '../types.js';
import { trackChild } from '../pipeline/runner.js';
import { promptFileFor } from './paths.js';
import { estimateTokens } from './tokens.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CallAgentArgs {
  readonly ctx: RunContext;
  /** Human-readable agent identifier (e.g. "spec.agent", "coding.agent"). */
  readonly agent: string;
  /** Phase name — used for prompts/<phase>-attempt-<n>.txt. */
  readonly phase: PhaseId | string;
  /** 1-indexed attempt number within the phase. */
  readonly attempt: number;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface CallAgentResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly estimatedTokens: number;
  readonly reportedTokens: number | null;
  readonly contract: unknown | null;
  readonly promptPath: string;
}

/**
 * Invoke the `claude` CLI with the supplied prompt. Returns once the
 * subprocess exits; throws AgentTimeoutError on timeout.
 */
export function callAgent(args: CallAgentArgs): Promise<CallAgentResult> {
  const promptPath = promptFileFor(args.ctx.runPaths, String(args.phase), args.attempt);
  mkdirSync(dirname(promptPath), { recursive: true });
  writeFileSync(promptPath, args.prompt, 'utf8');

  const estimatedTokens = estimateTokens(args.prompt);
  args.ctx.logger.info(
    `agent ${args.agent}: invoking (attempt ${args.attempt}, ~${estimatedTokens} tokens in)`,
  );

  return new Promise<CallAgentResult>((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const child = spawn(
      'claude',
      ['--dangerously-skip-permissions', '-p'],
      {
        cwd: args.ctx.paths.repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // new process group so we can SIGKILL grandchildren
      },
    );
    const stopTracking = trackChild(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // ---- Timeout via AbortController ----
    let timedOut = false;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
      killGroup(child.pid, 'SIGKILL');
    }, args.timeoutMs);
    timer.unref();

    const finalize = (
      settle: (resolve: typeof resolvePromise, reject: typeof rejectPromise) => void,
    ): void => {
      clearTimeout(timer);
      stopTracking();
      settle(resolvePromise, rejectPromise);
    };

    child.once('error', (err) => {
      finalize((_resolve, reject) => {
        if (timedOut) {
          reject(
            new AgentTimeoutError(args.agent, args.timeoutMs, args.attempt),
          );
          return;
        }
        reject(err);
      });
    });

    child.once('exit', (code, signal) => {
      const durationMs = Date.now() - startedAt;

      // Try to extract contract regardless of exit code.
      let contract: unknown | null = null;
      try {
        contract = extractLastFencedJson(stdout);
      } catch {
        contract = null;
      }
      const reportedTokens = extractTokenCount(contract);

      args.ctx.logger.event('agent_call', {
        agent: args.agent,
        phase: String(args.phase),
        attempt: args.attempt,
        promptTokensEstimated: estimatedTokens,
        promptTokensActual: reportedTokens,
        completionTokens: extractCompletionTokens(contract),
        durationMs,
        exitCode: code,
        signal,
        contractFound: contract !== null,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
      });

      finalize((resolve, reject) => {
        if (timedOut) {
          reject(
            new AgentTimeoutError(args.agent, args.timeoutMs, args.attempt),
          );
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          signal: signal ?? null,
          durationMs,
          estimatedTokens,
          reportedTokens,
          contract,
          promptPath,
        });
      });
    });

    child.stdin?.end(args.prompt);

    // The signal we pass to spawn is a convenience for our own reference
    // (ac above); aborts are actually enforced by killGroup in the timer.
    void ac;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  // Negative pid sends the signal to every member of the group.
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // process group may not exist (e.g. child already exited); fall back
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ignore — already gone
  }
}

// ---------------------------------------------------------------------------
// Fenced JSON extraction
//
// All structured-output agents (spec, reconcile, qa, soft-gates) append a
// final ```json ...``` block to stdout. Exactly one implementation lives
// here — other modules import this function, never re-implement it.
// ---------------------------------------------------------------------------

const FENCED_JSON_RE = /```json\s*\r?\n([\s\S]*?)\r?\n```/g;

export function extractLastFencedJson(stdout: string): unknown {
  let lastBody: string | null = null;
  let match: RegExpExecArray | null;
  FENCED_JSON_RE.lastIndex = 0;
  while ((match = FENCED_JSON_RE.exec(stdout)) !== null) {
    lastBody = match[1] ?? null;
  }
  if (lastBody === null) {
    throw new AgentContractError(
      'unknown',
      'no \`\`\`json ...\`\`\` block found in stdout',
    );
  }
  try {
    return JSON.parse(lastBody);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AgentContractError(
      'unknown',
      `last \`\`\`json block failed to parse: ${reason}`,
    );
  }
}

function extractTokenCount(contract: unknown): number | null {
  if (contract === null || typeof contract !== 'object') return null;
  const c = contract as Record<string, unknown>;
  const t =
    c.promptTokensActual ??
    c.inputTokens ??
    c.tokensIn ??
    null;
  return typeof t === 'number' ? t : null;
}

function extractCompletionTokens(contract: unknown): number | null {
  if (contract === null || typeof contract !== 'object') return null;
  const c = contract as Record<string, unknown>;
  const t =
    c.completionTokens ??
    c.outputTokens ??
    c.tokensOut ??
    null;
  return typeof t === 'number' ? t : null;
}
