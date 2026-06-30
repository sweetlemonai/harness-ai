// Compatibility entry point for invoking the configured model adapter.
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
//   5. JSON extraction delegates to extractLastFencedJson from this module -
//      there is exactly one implementation.

import { invokeRegisteredModel } from './models/invocation.js';
import { extractLastFencedJson } from './models/contracts.js';
import type {
  ModelInvocationArgs,
  ModelInvocationResult,
} from './models/types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CallAgentArgs = ModelInvocationArgs;
export type CallAgentResult = ModelInvocationResult;

/**
 * Invoke the configured model adapter with the supplied prompt. The default
 * adapter remains `claude-cli-v1`, so existing callers still execute:
 *
 *   claude --dangerously-skip-permissions -p
 *
 * Returns once the adapter exits; throws AgentTimeoutError on timeout.
 */
export function callAgent(args: CallAgentArgs): Promise<CallAgentResult> {
  return invokeRegisteredModel(args);
}

// ---------------------------------------------------------------------------
// Fenced JSON extraction
//
// All structured-output agents (spec, reconcile, qa, soft-gates) append a
// final ```json ...``` block to stdout. Exactly one implementation lives
// here — other modules import this function, never re-implement it.
// ---------------------------------------------------------------------------

export { extractLastFencedJson };
