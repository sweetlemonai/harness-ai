// Two distinct retry primitives.
//
//   retry<T>         — mechanical retry for transient failures (timeouts,
//                      empty output, 5xx-equivalent errors). The operation
//                      is the same every attempt; only the external world
//                      is expected to improve.
//
//   correctionLoop   — gate correction loop. The operation (gate) is the
//                      same every attempt; between attempts a different
//                      "fix" function runs with the CURRENT attempt's
//                      errors so the agent can correct course. Previous
//                      attempts' errors are NOT accumulated into the fix
//                      prompt — each attempt is independent. If attempt 1
//                      fixed eslint but not vitest, attempt 2's prompt
//                      only sees the vitest failure.
//
// These shapes are intentionally different. Do not collapse into one.

import { RetryExhaustedError, type PhaseId } from '../types.js';

// ---------------------------------------------------------------------------
// retry<T>
// ---------------------------------------------------------------------------

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly phase: PhaseId;
  /** Return true to retry the caught error. Default: always retry. */
  readonly shouldRetry?: (err: unknown, attempt: number) => boolean;
  readonly onRetry?: (err: unknown, attempt: number) => void;
  /** Optional fixed delay (ms) between attempts. Default: 0. */
  readonly backoffMs?: number;
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  if (config.maxAttempts < 1) {
    throw new Error('retry: maxAttempts must be >= 1');
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= config.maxAttempts) break;
      if (config.shouldRetry && !config.shouldRetry(err, attempt)) break;
      config.onRetry?.(err, attempt);
      if (config.backoffMs && config.backoffMs > 0) {
        await sleep(config.backoffMs);
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new RetryExhaustedError(config.phase, config.maxAttempts, msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// correctionLoop
// ---------------------------------------------------------------------------

export interface GateRunResult<R> {
  readonly passed: boolean;
  /** Always set; the result whether the gate passed or failed. */
  readonly result: R;
  /** Empty array when passed; one-or-more error strings when failed. */
  readonly errors: readonly string[];
}

export type GateRunner<R> = (attempt: number) => Promise<GateRunResult<R>>;

export type FixRunner = (
  currentErrors: readonly string[],
  attempt: number,
) => Promise<void>;

export interface CorrectionLoopConfig {
  readonly maxAttempts: number;
  readonly phase: PhaseId;
}

export interface CorrectionLoopOutcome<R> {
  readonly passed: boolean;
  readonly attempts: number;
  readonly result: R;
  /** Errors observed on each attempt, oldest first. Retained only for
   *  post-mortem display (escalation summaries, events.jsonl). Never
   *  fed back into the fix prompt. */
  readonly errorsByAttempt: readonly (readonly string[])[];
  /** Errors from the last (failing) attempt. Empty when the loop passed. */
  readonly lastErrors: readonly string[];
}

export async function correctionLoop<R>(args: {
  readonly gate: GateRunner<R>;
  readonly fix: FixRunner;
  readonly config: CorrectionLoopConfig;
}): Promise<CorrectionLoopOutcome<R>> {
  const { gate, fix, config } = args;
  if (config.maxAttempts < 1) {
    throw new Error('correctionLoop: maxAttempts must be >= 1');
  }

  const errorsByAttempt: string[][] = [];

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const gateResult = await gate(attempt);
    if (gateResult.passed) {
      return {
        passed: true,
        attempts: attempt,
        result: gateResult.result,
        errorsByAttempt,
        lastErrors: [],
      };
    }
    errorsByAttempt.push([...gateResult.errors]);

    if (attempt >= config.maxAttempts) {
      return {
        passed: false,
        attempts: attempt,
        result: gateResult.result,
        errorsByAttempt,
        lastErrors: gateResult.errors,
      };
    }

    // Fix runs against CURRENT errors only — each attempt is independent.
    await fix(gateResult.errors, attempt);
  }

  // Unreachable — loop always returns via passed or exhausted branches.
  throw new Error('correctionLoop: unreachable');
}
