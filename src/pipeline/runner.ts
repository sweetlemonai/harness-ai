// Phase runner. Owns the phase loop, signal handling, state persistence,
// and escalation handling. Knows nothing about what any individual phase
// does — phases are opaque { shouldRun, run } objects.
//
// Critical invariants (locked down on the first pass):
//   1. SIGINT + SIGTERM handlers are installed BEFORE any phase runs.
//      On signal: set shuttingDown, kill tracked subprocesses, let the
//      main loop finish its write-state cleanup, exit 130.
//   2. state.json is written only after a phase returns status=complete
//      (for progress) or when the run reaches a terminal status
//      (complete, interrupted, escalated, failed). Never during a phase.
//      Outputs land at runs/<id>/outputs/<phase>.json at the same moment.
//   3. --stop-after halts the pipeline immediately after the named phase
//      completes. --dry-run prints shouldRun() results and returns without
//      calling run() on anything.
//
// Exit codes:
//   0    clean completion (incl. successful --stop-after, --dry-run, empty phases)
//   1    escalation or unrecoverable error
//   130  interrupted by SIGINT / SIGTERM

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EscalationError,
  PreflightCheckError,
  type EscalationDetail,
  type Phase,
  type PhaseId,
  type PhaseOutputs,
  type PhaseResult,
  type PhaseStatus,
  type RunContext,
  type RunState,
  type TaskCapabilities,
} from '../types.js';
import { phaseOutputFileFor } from '../lib/paths.js';
import {
  createInitialState,
  markPhaseComplete,
  markPhaseSkipped,
  markStatus,
  readStateIfExists,
  writeState,
} from '../lib/state.js';
import { sealRun } from '../lib/analytics.js';
import {
  initLogger,
  logPhaseComplete,
  logPhaseHeader,
  logSkippedPhases,
  logTaskEnd,
  logTaskStart,
  sumTaskTokens,
} from '../lib/logger.js';
import type { LockHandle } from '../lib/lock.js';

// ---------------------------------------------------------------------------
// Subprocess registry
//
// lib/claude.ts and lib/shell.ts will register any spawned ChildProcess here
// so that the signal handler can terminate them. For Day 1 the registry is
// empty but the plumbing is in place.
// ---------------------------------------------------------------------------

const trackedChildren = new Set<ChildProcess>();

export function trackChild(child: ChildProcess): () => void {
  trackedChildren.add(child);
  const remove = (): void => {
    trackedChildren.delete(child);
  };
  child.once('exit', remove);
  child.once('error', remove);
  return remove;
}

export function untrackChild(child: ChildProcess): void {
  trackedChildren.delete(child);
}

function killAllChildren(signal: NodeJS.Signals): void {
  for (const child of trackedChildren) {
    if (child.killed) continue;
    try {
      // Kill the whole process group when possible; falls back to child PID.
      if (typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal);
          continue;
        } catch {
          // fall through to child.kill
        }
      }
      child.kill(signal);
    } catch {
      // ignore — the child may already be gone
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunPipelineArgs {
  readonly phases: readonly Phase[];
  readonly ctx: RunContext;
  readonly lockHandle: LockHandle;
  readonly setShuttingDown: () => void;
}

export async function runPipeline(args: RunPipelineArgs): Promise<number> {
  const { phases, ctx } = args;

  // Initialise the project-root prefix BEFORE anything logs. Every
  // subsequent info/warn/error/success call relativizes paths in its
  // message against this root.
  initLogger(ctx.paths.repoRoot);

  if (args.ctx.flags.dryRun) {
    return runDryRun(phases, ctx);
  }

  if (phases.length === 0) {
    process.stdout.write('no phases registered\n');
    ctx.logger.info('runner: no phases registered — nothing to run', {
      runId: ctx.runPaths.runId,
    });
    return 0;
  }

  const signals = installSignalHandlers(args);
  logTaskStart(ctx.task.project, ctx.task.task);
  const taskStartedAt = Date.now();
  let exitCode = 1;

  try {
    const state = initStateForResume(ctx);
    exitCode = await runLoop(phases, ctx, state);
    return exitCode;
  } finally {
    emitTaskFooter(ctx, taskStartedAt, exitCode);
    signals.remove();
  }
}

function emitTaskFooter(
  ctx: RunContext,
  startedAtMs: number,
  exitCode: number,
): void {
  const finalState = readStateIfExists(ctx.runPaths.stateFile);
  let status = finalState?.status;
  if (!status) {
    status =
      exitCode === 0
        ? 'complete'
        : exitCode === 130
          ? 'interrupted'
          : existsSync(ctx.runPaths.escalationFile)
            ? 'escalated'
            : 'failed';
  }
  const durationMs = Date.now() - startedAtMs;
  const totalTokens = sumTaskTokens(ctx.runPaths.eventsFile);
  const escalationPath =
    status === 'escalated' && existsSync(ctx.runPaths.escalationFile)
      ? `harness/tasks/${ctx.task.project}/${ctx.task.task}/runs/current/ESCALATION.md`
      : undefined;
  logTaskEnd(status, durationMs, totalTokens, escalationPath);
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

function runDryRun(phases: readonly Phase[], ctx: RunContext): number {
  const header = `Dry run — ${ctx.task.project}/${ctx.task.task}  runId=${ctx.runPaths.runId}`;
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${'-'.repeat(header.length)}\n`);
  if (phases.length === 0) {
    process.stdout.write('no phases registered\n');
    return 0;
  }
  const stopAfter = ctx.flags.stopAfter;
  const resumeFrom = ctx.flags.resumeFrom;
  let reached = resumeFrom === undefined;
  for (const phase of phases) {
    if (!reached) {
      if (phase.name === resumeFrom) {
        reached = true;
      } else {
        process.stdout.write(`  skip(from)   ${phase.name}\n`);
        continue;
      }
    }
    let willRun: boolean;
    try {
      willRun = phase.shouldRun(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  error        ${phase.name}: ${msg}\n`);
      continue;
    }
    const tag = willRun ? 'run         ' : 'skip        ';
    process.stdout.write(`  ${tag} ${phase.name}\n`);
    if (stopAfter !== undefined && phase.name === stopAfter) {
      process.stdout.write(`  [stop-after] ${phase.name}\n`);
      break;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runLoop(
  phases: readonly Phase[],
  ctx: RunContext,
  initialState: RunState,
): Promise<number> {
  let state = initialState;
  const resumeFrom = ctx.flags.resumeFrom;
  const stopAfter = ctx.flags.stopAfter;
  let reached = resumeFrom === undefined;
  const completedSet = new Set<PhaseId>(state.completedPhases);

  // Consecutive skipped phases collapse into a single dim-gray
  // `—  p1 · p2  skipped` line. We buffer names here and flush the
  // buffer right before the next active phase header (or at task end).
  let skippedBuffer: PhaseId[] = [];
  const flushSkipped = (): void => {
    if (skippedBuffer.length > 0) {
      logSkippedPhases(skippedBuffer);
      skippedBuffer = [];
    }
  };

  for (const phase of phases) {
    if (ctx.shuttingDown()) break;

    // --from: skip phases until we hit the named one. Phases skipped
    // by --from still have their persisted outputs attached so downstream
    // phases can read ctx.outputs.* / ctx.capabilities.
    if (!reached) {
      if (phase.name === resumeFrom) {
        reached = true;
      } else {
        if (completedSet.has(phase.name)) {
          attachPersistedOutputs(ctx, phase.name);
        }
        skippedBuffer.push(phase.name);
        continue;
      }
    }

    // Resume: phases already completed in a prior run are skipped and
    // their persisted outputs attached. --from overrides this for the
    // named starting phase so it is actually re-run.
    if (
      completedSet.has(phase.name) &&
      ctx.flags.resume &&
      phase.name !== resumeFrom
    ) {
      skippedBuffer.push(phase.name);
      attachPersistedOutputs(ctx, phase.name);
      continue;
    }

    const shouldRun = safeShouldRun(phase, ctx);
    ctx.logger.event('phase_start', {
      phase: phase.name,
      shouldRun,
    });

    if (!shouldRun) {
      skippedBuffer.push(phase.name);
      state = markPhaseSkipped(state, phase.name);
      writeState(ctx.runPaths.stateFile, state);
      persistSkippedOutput(ctx, phase.name);
      completedSet.add(phase.name);
      ctx.logger.event('phase_end', {
        phase: phase.name,
        status: 'skipped' satisfies PhaseStatus,
      });
      if (stopAfter !== undefined && phase.name === stopAfter) break;
      continue;
    }

    flushSkipped();
    logPhaseHeader(phase.name);
    let result: PhaseResult<PhaseOutputs[PhaseId]>;
    const startedAt = Date.now();
    try {
      result = await phase.run(ctx);
    } catch (err) {
      if (ctx.shuttingDown()) {
        // Phase aborted because we sent SIGTERM to its subprocess.
        // The post-loop shutdown path handles state persistence.
        ctx.logger.warn(`phase ${phase.name}: aborted by signal`);
        break;
      }
      if (err instanceof PreflightCheckError) {
        // Preflight failures must not leave state.json or ESCALATION.md —
        // the run hasn't started. Log to terminal + events.jsonl and bail.
        process.stderr.write(
          `preflight failed [${err.check}]: ${err.message}\n`,
        );
        ctx.logger.error(`preflight failed [${err.check}]: ${err.message}`);
        return 1;
      }
      if (err instanceof EscalationError) {
        return finalizeEscalation(ctx, state, err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : null;
      // Include the full stack in harness.log (via the message, which is
      // multi-line-safe) and as a structured `stack` field on the error
      // event in events.jsonl so debug tooling can surface it.
      const logMessage = stack
        ? `phase ${phase.name}: unhandled error: ${msg}\n${stack}`
        : `phase ${phase.name}: unhandled error: ${msg}`;
      ctx.logger.error(logMessage, stack !== null ? { stack } : undefined);
      return finalizeFailure(ctx, state, phase.name, msg);
    }
    const durationMs = Date.now() - startedAt;
    ctx.logger.event('phase_end', {
      phase: phase.name,
      status: result.status,
      durationMs,
      attempts: result.attempts,
    });

    if (result.status === 'escalate') {
      const detail: EscalationDetail = result.escalation ?? {
        phase: phase.name,
        reason: 'phase returned escalate without detail',
        details: '',
      };
      return finalizeEscalation(ctx, state, new EscalationError(detail));
    }

    // status is 'complete' or 'skipped' — persist output file, then state.
    // Order: output first (idempotent), state second (the durable marker).
    persistPhaseOutput(ctx, phase.name, result);
    (ctx.outputs as Record<string, unknown>)[phase.name] = result.outputs;
    state = markPhaseComplete(state, phase.name);
    writeState(ctx.runPaths.stateFile, state);
    completedSet.add(phase.name);
    logPhaseComplete(phase.name, durationMs);

    if (ctx.shuttingDown()) break;
    if (stopAfter !== undefined && phase.name === stopAfter) {
      ctx.logger.info(`--stop-after ${stopAfter}: halting pipeline`);
      break;
    }
  }

  // Flush any tail skipped phases so they still show before the footer.
  flushSkipped();

  if (ctx.shuttingDown()) {
    return finalizeInterrupt(ctx, state);
  }
  return finalizeComplete(ctx, state);
}

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

function finalizeComplete(ctx: RunContext, state: RunState): number {
  const final = markStatus(state, 'complete');
  writeState(ctx.runPaths.stateFile, final);
  // Seal only on a fully-complete git phase run, not on partial
  // --stop-after exits. `git` being in completedPhases is the marker.
  // The task footer shows the completion status — we don't need extra
  // terminal lines here, so we route both outcomes through event() (→
  // events.jsonl + harness.log only, no stdout).
  if (final.completedPhases.includes('git')) {
    try {
      const result = sealRun(ctx);
      ctx.logger.event('info', {
        kind: 'run_sealed',
        analyticsFile: result.analyticsFile,
        linesAppended: result.linesAppended,
        retention: result.retention,
      });
    } catch (err) {
      ctx.logger.event('warn', {
        kind: 'run_seal_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return 0;
}

function finalizeInterrupt(ctx: RunContext, state: RunState): number {
  const final = markStatus(state, 'interrupted');
  writeState(ctx.runPaths.stateFile, final);
  writeInterruptedMarker(ctx);
  ctx.logger.event('interruption', { runId: ctx.runPaths.runId });
  return 130;
}

function finalizeEscalation(
  ctx: RunContext,
  state: RunState,
  err: EscalationError,
): number {
  const final = markStatus(state, 'escalated');
  writeState(ctx.runPaths.stateFile, final);
  writeEscalationFile(ctx, err);
  ctx.logger.event('escalation', {
    phase: err.phase,
    reason: err.reason,
  });
  ctx.logger.error(`ESCALATION in phase ${err.phase}: ${err.reason}`);
  return 1;
}

function finalizeFailure(
  ctx: RunContext,
  state: RunState,
  phase: PhaseId,
  message: string,
): number {
  const final = markStatus(state, 'failed');
  writeState(ctx.runPaths.stateFile, final);
  ctx.logger.event('error', { phase, message });
  return 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeShouldRun(phase: Phase, ctx: RunContext): boolean {
  try {
    return phase.shouldRun(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.error(`phase ${phase.name}: shouldRun threw: ${msg}`);
    return false;
  }
}

function initStateForResume(ctx: RunContext): RunState {
  const existing = readStateIfExists(ctx.runPaths.stateFile);
  if (!existing) {
    // No state file yet — synthesize an in-memory starting state. We do
    // not persist it; state.json materialises only after the first phase
    // completes (or on terminal status).
    return createInitialState();
  }
  // On resume, re-hydrate ctx.outputs from persisted files for every
  // phase we already completed, so downstream phases see what the
  // earlier run produced.
  if (ctx.flags.resume) {
    for (const completed of existing.completedPhases) {
      attachPersistedOutputs(ctx, completed);
    }
  }
  return existing;
}

function attachPersistedOutputs(ctx: RunContext, phase: PhaseId): void {
  const outputPath = phaseOutputFileFor(ctx.runPaths, phase);
  try {
    const raw = readFileSync(outputPath, 'utf8');
    const parsed = JSON.parse(raw) as { outputs?: unknown; status?: string };
    if (parsed.status === 'skipped') {
      // Skipped phases have no usable outputs; nothing to attach.
      return;
    }
    const outputs = parsed.outputs ?? null;
    if (outputs !== null && outputs !== undefined) {
      (ctx.outputs as Record<string, unknown>)[phase] = outputs;
    }
    // Special-case: spec phase carries TaskCapabilities. Rehydrate it so
    // downstream phases that gate on ctx.capabilities see the same state
    // they would have seen in the original run.
    if (phase === 'spec' && outputs && typeof outputs === 'object') {
      const specOut = outputs as { capabilities?: TaskCapabilities };
      if (specOut.capabilities) {
        ctx.capabilities = specOut.capabilities;
      }
    }
  } catch {
    // Missing output file is not a hard error — some phases have null outputs
    // or were added after the run started. Log and move on.
    ctx.logger.warn(`phase ${phase}: no persisted output to rehydrate`);
  }
}

function persistPhaseOutput<Id extends PhaseId>(
  ctx: RunContext,
  phase: Id,
  result: PhaseResult<PhaseOutputs[Id]>,
): void {
  const outputPath = phaseOutputFileFor(ctx.runPaths, phase);
  mkdirSync(dirname(outputPath), { recursive: true });
  const payload = {
    phase,
    status: result.status,
    durationMs: result.durationMs,
    attempts: result.attempts,
    outputs: result.outputs,
  };
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function persistSkippedOutput(ctx: RunContext, phase: PhaseId): void {
  const outputPath = phaseOutputFileFor(ctx.runPaths, phase);
  mkdirSync(dirname(outputPath), { recursive: true });
  const payload = {
    phase,
    status: 'skipped' as const,
    durationMs: 0,
    attempts: 0,
    outputs: null,
  };
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeInterruptedMarker(ctx: RunContext): void {
  const body = `# Interrupted — ${new Date().toISOString()}

Run:     ${ctx.runPaths.runId}
Task:    ${ctx.task.project}/${ctx.task.task}
Branch:  ${ctx.branch}

Resume with:
  npx tsx src/cli.ts resume ${ctx.task.project}/${ctx.task.task}
`;
  try {
    writeFileSync(ctx.runPaths.interruptedFile, body, 'utf8');
  } catch {
    // Best-effort: the run is ending regardless.
  }
}

function writeEscalationFile(ctx: RunContext, err: EscalationError): void {
  const body = `# Escalation — Human Review Required

Run:    ${ctx.runPaths.runId}
Task:   ${ctx.task.project}/${ctx.task.task}
Phase:  ${err.phase}
Time:   ${new Date().toISOString()}

## Reason
${err.reason}

## Details
${err.details}
${err.humanAction ? `\n## Human Action\n${err.humanAction}\n` : ''}
## Resume
  npx tsx src/cli.ts run ${ctx.task.project}/${ctx.task.task} --from ${err.phase}
`;
  try {
    writeFileSync(ctx.runPaths.escalationFile, body, 'utf8');
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Signal handling
//
// Installed BEFORE the phase loop begins (requirement #1). The handler
// flips ctx.shuttingDown() to true (via the callback the caller provides)
// and kills any tracked subprocess. The main loop then runs its own
// cleanup on its next await boundary.
//
// Second press of SIGINT force-exits — the user has said "stop NOW" twice.
// ---------------------------------------------------------------------------

function installSignalHandlers(args: RunPipelineArgs): { remove(): void } {
  const grace = args.ctx.config.timeouts.gracefulShutdownMs;
  let firstShutdownAt: number | null = null;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (firstShutdownAt !== null) {
      process.stderr.write(`\n${signal} again — force exit\n`);
      try {
        killAllChildren('SIGKILL');
      } catch {
        // ignored
      }
      try {
        args.lockHandle.release();
      } catch {
        // ignored
      }
      process.exit(130);
    }
    firstShutdownAt = Date.now();
    process.stderr.write(`\n${signal} received — shutting down gracefully\n`);
    args.setShuttingDown();
    killAllChildren('SIGTERM');
    // Escalate to SIGKILL after the grace window if children are still up.
    setTimeout(() => {
      killAllChildren('SIGKILL');
    }, grace).unref();
  };

  const sigint = (): void => onSignal('SIGINT');
  const sigterm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  return {
    remove(): void {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
    },
  };
}
