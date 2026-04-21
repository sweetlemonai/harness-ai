// Phase 5 — Reconcile.
//
// Checks for contradictions between implementation and tests, and for
// spec ambiguities either of them could have interpreted differently.
// The reconciliation agent appends a JSON contract block with:
//
//   { "status": "CLEAN" | "NOTE" | "FIX" | "ESCALATE",
//     "issues":  [{ "file": "...", "type": "contradiction"|"ambiguity", "description": "..." }] }
//
// Status handling (exact — no collapsing):
//   CLEAN     → continue
//   NOTE      → log issues as events, continue
//   FIX       → send only the contradiction details to the coding agent;
//               then re-run reconcile ONCE. If still FIX → escalate.
//   ESCALATE  → escalate immediately; no retry.
//
// Missing/invalid JSON block → AgentContractError → escalate (agent is
// broken, retrying won't help).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AgentContractError,
  EscalationError,
  RECONCILE_STATUSES,
  type EscalationDetail,
  type ManifestEntry,
  type Phase,
  type PhaseResult,
  type ReconcileIssue,
  type ReconcileOutputs,
  type ReconcileStatus,
  type RunContext,
  type SpecOutputs,
  type TaskCapabilities,
} from '../../types.js';
import { callAgent } from '../../lib/claude.js';
import { resolveClaudeAsset } from '../../lib/paths.js';

interface ReconcileContract {
  readonly status: ReconcileStatus;
  readonly issues: readonly ReconcileIssue[];
}

export const reconcilePhase: Phase<'reconcile'> = {
  name: 'reconcile',
  shouldRun(ctx: RunContext): boolean {
    return ctx.capabilities?.hasTests === true;
  },

  async run(ctx: RunContext): Promise<PhaseResult<ReconcileOutputs>> {
    const startedAt = Date.now();
    const caps = requireCapabilities(ctx);
    const spec = requireSpecOutputs(ctx);
    if (!caps.hasTests) {
      // shouldRun guards against this, but be defensive.
      return {
        status: 'skipped',
        durationMs: Date.now() - startedAt,
        attempts: 0,
        outputs: { status: 'CLEAN', fixAttempts: 0, issues: [] },
      };
    }

    // First pass.
    const first = await runReconcile(ctx, spec, 1, null);

    if (first.contract.status === 'CLEAN') {
      return complete(startedAt, 'CLEAN', 0, first.contract.issues);
    }

    if (first.contract.status === 'NOTE') {
      logIssues(ctx, first.contract.issues, 'NOTE');
      return complete(startedAt, 'NOTE', 0, first.contract.issues);
    }

    if (first.contract.status === 'ESCALATE') {
      throw escalate(
        'reconciliation agent returned ESCALATE',
        describeIssues(first.contract.issues),
      );
    }

    // status === 'FIX' — one targeted coding-agent pass, then re-reconcile once.
    logIssues(ctx, first.contract.issues, 'FIX');
    const contradictions = first.contract.issues.filter((i) => i.kind === 'contradiction');
    if (contradictions.length === 0) {
      // Unusual: FIX with no contradictions — escalate, nothing concrete to fix.
      throw escalate(
        'reconciliation agent returned FIX with no contradictions',
        describeIssues(first.contract.issues),
      );
    }

    const fixPrompt = buildFixPrompt(ctx, spec, contradictions);
    const fix = await callAgent({
      ctx,
      agent: 'coding.agent (reconcile fix)',
      phase: 'reconcile',
      attempt: 1,
      prompt: fixPrompt,
      timeoutMs: ctx.config.timeouts.otherAgentMs,
    });
    ctx.logger.event('correction_attempt', {
      phase: 'reconcile',
      attempt: 1,
      agentExitCode: fix.exitCode,
      contradictionCount: contradictions.length,
    });
    if (fix.exitCode !== 0) {
      throw escalate(
        'coding agent exited non-zero during reconciliation fix',
        (fix.stderr || fix.stdout).slice(-600),
      );
    }

    // Re-run reconcile ONCE.
    const second = await runReconcile(ctx, spec, 2, first.contract.issues);

    if (second.contract.status === 'CLEAN') {
      return complete(startedAt, 'CLEAN', 1, second.contract.issues);
    }
    if (second.contract.status === 'NOTE') {
      logIssues(ctx, second.contract.issues, 'NOTE');
      return complete(startedAt, 'NOTE', 1, second.contract.issues);
    }

    // Still FIX (or ESCALATE) after the one allowed fix — escalate.
    throw escalate(
      `reconciliation still ${second.contract.status} after one fix attempt`,
      describeIssues(second.contract.issues),
    );
  },
};

// ---------------------------------------------------------------------------
// Agent invocation + contract validation
// ---------------------------------------------------------------------------

interface ReconcileRunResult {
  readonly contract: ReconcileContract;
}

async function runReconcile(
  ctx: RunContext,
  spec: SpecOutputs,
  attempt: number,
  previousIssues: readonly ReconcileIssue[] | null,
): Promise<ReconcileRunResult> {
  const prompt = buildReconcilePrompt(ctx, spec, previousIssues);
  const result = await callAgent({
    ctx,
    agent: 'reconciliation.agent',
    phase: 'reconcile',
    attempt,
    prompt,
    timeoutMs: ctx.config.timeouts.otherAgentMs,
  });
  if (result.exitCode !== 0) {
    throw escalate(
      `reconciliation agent exited non-zero on attempt ${attempt}`,
      (result.stderr || result.stdout).slice(-600),
    );
  }
  if (result.contract === null) {
    throw escalate(
      'reconciliation agent did not produce a JSON contract block',
      `stdout tail:\n${result.stdout.slice(-400)}`,
    );
  }
  try {
    const contract = assertContractShape(result.contract);
    ctx.logger.event('info', {
      kind: 'reconcile_status',
      attempt,
      status: contract.status,
      issueCount: contract.issues.length,
    });
    return { contract };
  } catch (err) {
    if (err instanceof AgentContractError) {
      throw escalate(
        'reconciliation agent violated JSON contract',
        err.message,
      );
    }
    throw err;
  }
}

function assertContractShape(value: unknown): ReconcileContract {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentContractError(
      'reconciliation.agent',
      'contract must be a JSON object',
    );
  }
  const v = value as Record<string, unknown>;
  const status = v.status;
  if (
    typeof status !== 'string' ||
    !(RECONCILE_STATUSES as readonly string[]).includes(status)
  ) {
    throw new AgentContractError(
      'reconciliation.agent',
      `status must be one of ${RECONCILE_STATUSES.join('|')}`,
    );
  }
  const issues = v.issues;
  if (!Array.isArray(issues)) {
    throw new AgentContractError(
      'reconciliation.agent',
      'issues must be an array',
    );
  }
  const parsed: ReconcileIssue[] = [];
  for (let i = 0; i < issues.length; i += 1) {
    const entry = issues[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AgentContractError(
        'reconciliation.agent',
        `issues[${i}] must be an object`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || (e.type !== 'contradiction' && e.type !== 'ambiguity')) {
      throw new AgentContractError(
        'reconciliation.agent',
        `issues[${i}].type must be 'contradiction' | 'ambiguity'`,
      );
    }
    const description = typeof e.description === 'string' ? e.description : '';
    const specClause = typeof e.specClause === 'string' ? e.specClause : (typeof e.file === 'string' ? e.file : '');
    parsed.push({
      kind: e.type,
      specClause,
      description,
    });
  }
  return { status: status as ReconcileStatus, issues: parsed };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildReconcilePrompt(
  ctx: RunContext,
  spec: SpecOutputs,
  previousIssues: readonly ReconcileIssue[] | null,
): string {
  const agentInstructions = readFile(
    resolveClaudeAsset(ctx.paths, 'agents/reconciliation.agent.md'),
  );
  const specText = readFile(spec.specPath);
  const manifestText = readFile(spec.manifestPath);

  const implContents = collectFileContents(
    ctx,
    spec.manifestEntries.filter((e) => e.kind !== 'test' && e.action !== 'no-touch'),
  );
  const testContents = collectFileContents(
    ctx,
    spec.manifestEntries.filter((e) => e.kind === 'test'),
  );

  const pieces: string[] = [
    '=== AGENT INSTRUCTIONS ===',
    agentInstructions.trim(),
    '',
    '=== SPEC ===',
    specText.trim(),
    '',
    '=== MANIFEST ===',
    manifestText.trim(),
    '',
    '=== IMPLEMENTATION FILES ===',
    implContents,
    '',
    '=== TEST FILES ===',
    testContents,
    '',
  ];

  if (previousIssues && previousIssues.length > 0) {
    pieces.push(
      '=== PREVIOUSLY FLAGGED ISSUES (from earlier attempt) ===',
      previousIssues
        .map((i) => `- [${i.kind}] ${i.specClause}: ${i.description}`)
        .join('\n'),
      '',
      'The coding agent just attempted a fix. Re-evaluate.',
      '',
    );
  }

  pieces.push(
    '=== YOUR TASK ===',
    'Compare implementation vs tests vs spec. Output exactly one JSON contract block at the end of your response (no prose after).',
  );

  return pieces.join('\n');
}

function buildFixPrompt(
  ctx: RunContext,
  spec: SpecOutputs,
  contradictions: readonly ReconcileIssue[],
): string {
  const codingInstructions = readFile(
    resolveClaudeAsset(ctx.paths, 'agents/coding.agent.md'),
  );

  const fileContents = new Map<string, string>();
  for (const issue of contradictions) {
    if (!issue.specClause) continue;
    const abs = resolve(ctx.paths.repoRoot, issue.specClause);
    if (!existsSync(abs)) continue;
    try {
      fileContents.set(issue.specClause, readFileSync(abs, 'utf8'));
    } catch {
      // skip unreadable
    }
  }

  const filesBlock = [...fileContents.entries()]
    .map(([p, c]) => `--- ${p} ---\n${c}`)
    .join('\n\n');

  const contradictionList = contradictions
    .map((i, idx) => `${idx + 1}. [${i.specClause}] ${i.description}`)
    .join('\n');

  const noTouch = spec.manifestEntries
    .filter((e) => e.action === 'no-touch')
    .map((e) => `  - ${e.path}${e.read === false ? ' (DO NOT read)' : ''}`)
    .join('\n');

  return [
    '=== CODING AGENT INSTRUCTIONS (reconciliation fix) ===',
    codingInstructions.trim(),
    '',
    '=== CONTRADICTIONS TO RESOLVE ===',
    contradictionList,
    '',
    '=== IMPLICATED FILES (full content) ===',
    filesBlock || '(none identified)',
    '',
    '=== NO-TOUCH FILES ===',
    noTouch || '(none)',
    '',
    '=== YOUR TASK ===',
    'Resolve ONLY the listed contradictions. Do not refactor unrelated code. Do not modify tests unless the contradiction explicitly requires it. Run `npx tsc --noEmit` from the repo root before declaring done.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFileContents(
  ctx: RunContext,
  entries: readonly ManifestEntry[],
): string {
  if (entries.length === 0) return '(none)';
  const parts: string[] = [];
  for (const entry of entries) {
    const abs = resolve(ctx.paths.repoRoot, entry.path);
    if (!existsSync(abs)) {
      parts.push(`--- ${entry.path} ---\n(file not found on disk)`);
      continue;
    }
    try {
      parts.push(`--- ${entry.path} ---\n${readFileSync(abs, 'utf8')}`);
    } catch {
      parts.push(`--- ${entry.path} ---\n(unreadable)`);
    }
  }
  return parts.join('\n\n');
}

function logIssues(
  ctx: RunContext,
  issues: readonly ReconcileIssue[],
  status: ReconcileStatus,
): void {
  for (const i of issues) {
    ctx.logger.event('info', {
      kind: 'reconcile_issue',
      status,
      issueKind: i.kind,
      specClause: i.specClause,
      description: i.description,
    });
  }
}

function describeIssues(issues: readonly ReconcileIssue[]): string {
  if (issues.length === 0) return '(no issues reported)';
  return issues
    .map((i, idx) => `${idx + 1}. [${i.kind}] ${i.specClause}: ${i.description}`)
    .join('\n');
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return `(could not read ${path}: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function complete(
  startedAt: number,
  status: ReconcileStatus,
  fixAttempts: number,
  issues: readonly ReconcileIssue[],
): PhaseResult<ReconcileOutputs> {
  return {
    status: 'complete',
    durationMs: Date.now() - startedAt,
    attempts: fixAttempts + 1,
    outputs: { status, fixAttempts, issues },
  };
}

function requireCapabilities(ctx: RunContext): TaskCapabilities {
  if (!ctx.capabilities) {
    throw new Error('reconcile phase invoked without TaskCapabilities — spec must run first');
  }
  return ctx.capabilities;
}

function requireSpecOutputs(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error('reconcile phase invoked without SpecOutputs — spec must run first');
  }
  return spec;
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'reconcile',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/reconcile-attempt-*.txt; clarify the spec or fix the test/impl contradiction, then re-run with --from reconcile.',
  };
  return new EscalationError(detail);
}
