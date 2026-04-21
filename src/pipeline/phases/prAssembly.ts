// Phase 10 — PR Assembly.
//
// Condenses every prior phase's structured outputs into two artefacts
// humans actually read: COMMIT_MESSAGE.txt and PR_DESCRIPTION.md, both
// at runs/<id>/. The agent receives STRUCTURED data from ctx.outputs.*,
// not raw logs — the prompt is a digest, not a dump.
//
// Retry policy: one retry on empty output. Escalate if still empty.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  EscalationError,
  type BuildOutputs,
  type E2EOutputs,
  type EscalationDetail,
  type HardGateOutputs,
  type Phase,
  type PhaseResult,
  type PRAssemblyOutputs,
  type ReconcileOutputs,
  type RunContext,
  type SoftGateOutputs,
  type SoftGateReport,
  type SpecOutputs,
} from '../../types.js';
import { callAgent } from '../../lib/claude.js';
import { resolveClaudeAsset } from '../../lib/paths.js';

export const prAssemblyPhase: Phase<'prAssembly'> = {
  name: 'prAssembly',
  shouldRun(): boolean {
    return true;
  },

  async run(ctx: RunContext): Promise<PhaseResult<PRAssemblyOutputs>> {
    const startedAt = Date.now();
    const spec = requireSpec(ctx);
    const commitMsgPath = resolve(ctx.runPaths.runDir, 'COMMIT_MESSAGE.txt');
    const prDescPath = resolve(ctx.runPaths.runDir, 'PR_DESCRIPTION.md');

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = buildPrompt(ctx, spec, commitMsgPath, prDescPath, attempt);
      const result = await callAgent({
        ctx,
        agent: 'pr-assembly.agent',
        phase: 'prAssembly',
        attempt,
        prompt,
        timeoutMs: ctx.config.timeouts.otherAgentMs,
      });

      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout).slice(-500);
        ctx.logger.warn(`prAssembly: attempt ${attempt} exited ${result.exitCode}: ${tail}`);
        if (attempt === 2) {
          throw escalate('pr-assembly agent exited non-zero twice', tail);
        }
        continue;
      }

      const commitOk = isNonEmpty(commitMsgPath);
      const descOk = isNonEmpty(prDescPath);
      if (commitOk && descOk) {
        const commit = readFileSync(commitMsgPath, 'utf8').trim();
        ctx.logger.info(`prAssembly: commit="${commit.split('\n')[0]}"`);
        return {
          status: 'complete',
          durationMs: Date.now() - startedAt,
          attempts: attempt,
          outputs: {
            commitMessagePath: commitMsgPath,
            prDescriptionPath: prDescPath,
          },
        };
      }

      if (attempt === 2) {
        throw escalate(
          'pr-assembly agent did not produce both required files after retry',
          [
            `COMMIT_MESSAGE.txt present+non-empty: ${commitOk}`,
            `PR_DESCRIPTION.md present+non-empty: ${descOk}`,
          ].join('\n'),
        );
      }
      ctx.logger.warn(
        `prAssembly: attempt ${attempt} left files missing/empty — retrying`,
      );
    }

    // Unreachable — loop always returns or throws by attempt 2.
    throw escalate('prAssembly exhausted retries unexpectedly', '');
  },
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildPrompt(
  ctx: RunContext,
  spec: SpecOutputs,
  commitMsgPath: string,
  prDescPath: string,
  attempt: number,
): string {
  const agentInstructions = resolveAgentOr(ctx, 'pr-assembly.agent.md', '(agent file missing)');
  const specTitle = readSpecTitle(spec.specPath);

  const build = ctx.outputs.build as BuildOutputs | undefined;
  const hardGates = ctx.outputs.hardGates as HardGateOutputs | undefined;
  const reconcile = ctx.outputs.reconcile as ReconcileOutputs | undefined;
  const e2e = ctx.outputs.e2e as E2EOutputs | undefined;
  const soft = ctx.outputs.softGates as SoftGateOutputs | undefined;

  const acCount = countAcceptanceCriteria(spec.specPath);
  const manifestSummary = summarizeManifest(spec);
  const publicApi = readPublicApiList(spec.specPath);
  const gatesBlock = summarizeHardGates(hardGates);
  const reconcileBlock = summarizeReconcile(reconcile);
  const e2eBlock = summarizeE2E(e2e);
  const softBlock = summarizeSoftGates(soft);
  const buildBlock = summarizeBuild(build);
  const skippedByHumanBlock = summarizeSkippedByHuman(ctx);

  const debugCmd = `npx tsx src/cli.ts debug ${ctx.task.project}/${ctx.task.task} --run ${ctx.runPaths.runId}`;

  const parts: string[] = [
    '=== AGENT INSTRUCTIONS ===',
    agentInstructions.trim(),
    '',
    '=== SPEC SUMMARY ===',
    `Title: ${specTitle || '(no title)'}`,
    `Task: ${ctx.task.project}/${ctx.task.task}`,
    `Branch: ${ctx.branch}`,
    `Acceptance criteria count: ${acCount}`,
    `Manifest: ${manifestSummary.impl} impl, ${manifestSummary.test} test, ${manifestSummary.story} story, ${manifestSummary.noTouch} no-touch`,
    '',
    '=== PUBLIC API (exported symbols) ===',
    publicApi || '(none listed)',
    '',
    '=== BUILD OUTPUTS ===',
    buildBlock,
    '',
    '=== HARD GATE RESULTS ===',
    gatesBlock,
    '',
    '=== RECONCILE RESULT ===',
    reconcileBlock,
    '',
    '=== E2E RESULT ===',
    e2eBlock,
    '',
    '=== SOFT GATE FINDINGS (counts by severity) ===',
    softBlock,
    '',
    '=== SKIPPED TASKS (project-level, skipped-by-human) ===',
    skippedByHumanBlock,
    '',
    '=== REQUIRED OUTPUT FILES (absolute paths) ===',
    `COMMIT_MESSAGE.txt: ${commitMsgPath}`,
    `PR_DESCRIPTION.md:  ${prDescPath}`,
    '',
    '=== COMMIT MESSAGE FORMAT ===',
    `Single line, no body. Format exactly: "feat(${ctx.task.task}): <concise spec title>"`,
    '',
    '=== PR DESCRIPTION REQUIREMENTS ===',
    '- Section "## What Was Built" — 2-4 sentences summarising the change.',
    '- Section "## Files Changed" — bullet list of each create/modify path with its action.',
    '- Section "## Tests" — unit/component/e2e counts and any flaky or skipped indicators.',
    '- Section "## Quality Gates" — one line per hard gate (pass/fail/skip), plus visual diff if run.',
    '- Section "## Soft Gate Findings" — per-agent severity counts (the reports themselves live at runs/.../reports/).',
    '- Section "## Reconciliation Notes" — only when reconcile was FIX; otherwise omit.',
    '- Section "## Skipped tasks" — ONLY when the SKIPPED TASKS block above lists one or more entries. Show each task name and note it was manually skipped (`skipped-by-human via harness ship --skip`). Omit the whole section when no tasks were skipped.',
    '- Final section "## Debug" — exact line:',
    `    ${debugCmd}`,
    '',
  ];

  if (attempt > 1) {
    parts.push(
      '=== PREVIOUS ATTEMPT DIAGNOSTIC ===',
      'Your previous attempt did not produce both files non-empty. Write them again at the EXACT absolute paths above. No prose before or after; just the two file writes.',
      '',
    );
  }

  parts.push(
    '=== YOUR TASK ===',
    'Write both files now at their supplied paths. Keep prose tight; this is for a reviewer who already read the spec. No JSON contract block required.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Summary helpers — all operate on ctx.outputs (structured data)
// ---------------------------------------------------------------------------

function summarizeBuild(build: BuildOutputs | undefined): string {
  if (!build) return '(build phase did not run — E2E-only task)';
  const lines = [
    `files written: ${build.filesWritten.length}`,
    ...build.filesWritten.map((p) => `  - ${p}`),
  ];
  if (build.noTouchViolations.length > 0) {
    lines.push(`no-touch observations:`);
    for (const v of build.noTouchViolations) {
      lines.push(`  - ${v.path} (${v.kind}): ${v.description}`);
    }
  }
  lines.push(`correction attempts: ${build.correctionAttempts}`);
  return lines.join('\n');
}

function summarizeHardGates(hg: HardGateOutputs | undefined): string {
  if (!hg) return '(hard gates did not run)';
  // Every gate field is treated as nullable at the render layer. The
  // type declares tsc/eslint as non-null, but persisted outputs from
  // earlier harness versions can have them as null — prAssembly must
  // not crash on historical data.
  const lines = [
    `tsc:        ${gateLine(hg.tsc)}`,
    `eslint:     ${gateLine(hg.eslint)}`,
    `vitest:     ${gateLine(hg.vitest)}`,
    `storybook:  ${gateLine(hg.storybook)}`,
  ];
  if (hg.visualDiff) {
    const ok = hg.visualDiff.passed ? 'PASS' : 'FAIL';
    lines.push(
      `visualDiff: ${ok} (${hg.visualDiff.entries.length} stories, threshold=${hg.visualDiff.threshold})`,
    );
  } else {
    lines.push('visualDiff: skipped');
  }
  lines.push(`correction attempts: ${hg.correctionAttempts}`);
  return lines.join('\n');
}

function gateLine(
  g: { passed: boolean; durationMs: number; errors: readonly string[] } | null | undefined,
): string {
  if (!g) return 'skipped';
  const status = g.passed ? 'PASS' : 'FAIL';
  const suffix = g.passed ? '' : ` — ${g.errors.length} error(s)`;
  return `${status} (${g.durationMs}ms)${suffix}`;
}

function summarizeReconcile(r: ReconcileOutputs | undefined): string {
  if (!r) return 'skipped (no tests in this task)';
  const base = `status: ${r.status} (fix attempts: ${r.fixAttempts})`;
  if (r.issues.length === 0) return base;
  const issues = r.issues
    .slice(0, 5)
    .map((i) => `  - [${i.kind}] ${i.specClause}: ${i.description}`)
    .join('\n');
  return `${base}\n${issues}`;
}

function summarizeE2E(e: E2EOutputs | undefined): string {
  if (!e) return 'skipped (no e2e tests)';
  const parts = [
    `passed: ${e.passed}`,
    `flaky:  ${e.flaky}`,
    `correction attempts: ${e.correctionAttempts}`,
  ];
  return parts.join('\n');
}

/**
 * Collect sibling tasks in the same project whose `state.json` status
 * is `skipped-by-human`. Rendered as a list the agent can transcribe
 * into the PR_DESCRIPTION's "## Skipped tasks" section. Never throws —
 * a missing symlink or unreadable state file just means "no skip here".
 */
function summarizeSkippedByHuman(ctx: RunContext): string {
  const projectDir = resolve(ctx.paths.tasksDir, ctx.task.project);
  let entries: string[] = [];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return '(none)';
  }
  const skipped: string[] = [];
  for (const entry of entries) {
    const candidate = resolve(projectDir, entry);
    let st;
    try {
      st = statSync(candidate);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // Task folders match the `<N>-<slug>` shape; sibling markdown files
    // (brief.md, README.md) aren't directories so they're already
    // excluded. The task folder's own runs/current/state.json is the
    // marker for skipped-by-human.
    const statePath = resolve(candidate, 'runs', 'current', 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const raw = readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw) as { status?: unknown };
      if (parsed.status === 'skipped-by-human') {
        skipped.push(entry);
      }
    } catch {
      // corrupt state.json — skip silently
    }
  }
  if (skipped.length === 0) return '(none)';
  skipped.sort();
  return skipped.map((t) => `  - ${ctx.task.project}/${t}`).join('\n');
}

function summarizeSoftGates(s: SoftGateOutputs | undefined): string {
  if (!s) return 'skipped (non-UI task)';
  const rows: string[] = [];
  for (const [name, report] of Object.entries(s) as [string, SoftGateReport | null][]) {
    if (!report) {
      rows.push(`${name.padEnd(14)} (no report)`);
      continue;
    }
    const counts = countBySeverity(report.findings);
    rows.push(
      `${name.padEnd(14)} ${report.status} — high: ${counts.high}, medium: ${counts.medium}, low: ${counts.low}`,
    );
  }
  return rows.join('\n');
}

function countBySeverity(findings: readonly { severity: string }[]): {
  high: number;
  medium: number;
  low: number;
} {
  return {
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  };
}

function summarizeManifest(spec: SpecOutputs): {
  impl: number;
  test: number;
  story: number;
  noTouch: number;
} {
  let impl = 0;
  let test = 0;
  let story = 0;
  let noTouch = 0;
  for (const e of spec.manifestEntries) {
    if (e.action === 'no-touch') noTouch += 1;
    else if (e.kind === 'impl') impl += 1;
    else if (e.kind === 'test') test += 1;
    else if (e.kind === 'story') story += 1;
  }
  return { impl, test, story, noTouch };
}

// ---------------------------------------------------------------------------
// Spec parsers (cheap — avoid feeding full spec.md through again)
// ---------------------------------------------------------------------------

function readSpecTitle(specPath: string): string {
  try {
    const raw = readFileSync(specPath, 'utf8');
    const m = /^#\s+(.+)$/m.exec(raw);
    return m ? (m[1] ?? '').trim() : '';
  } catch {
    return '';
  }
}

function countAcceptanceCriteria(specPath: string): number {
  try {
    const raw = readFileSync(specPath, 'utf8');
    const m = /^#{1,3}\s+.*Acceptance Criteria[^\n]*\r?\n([\s\S]*?)(?=^#{1,3}\s|\Z)/m.exec(raw);
    if (!m) return 0;
    const section = m[1] ?? '';
    const items = section.match(/^(?:[-*]|\d+\.)\s+\S/gm);
    return items ? items.length : 0;
  } catch {
    return 0;
  }
}

function readPublicApiList(specPath: string): string {
  try {
    const raw = readFileSync(specPath, 'utf8');
    const m = /^#{1,3}\s+.*Public API[^\n]*\r?\n([\s\S]*?)(?=^#{1,3}\s|\Z)/m.exec(raw);
    if (!m) return '';
    const section = m[1] ?? '';
    const lines: string[] = [];
    const codeBlocks = section.match(/```[^\n]*\r?\n([\s\S]*?)```/g) ?? [];
    for (const block of codeBlocks) {
      for (const line of block.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('export ') || t.startsWith('// ')) lines.push(t);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmpty(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
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

function resolveAgentOr(ctx: RunContext, name: string, fallback: string): string {
  try {
    return readFileSync(resolveClaudeAsset(ctx.paths, `agents/${name}`), 'utf8');
  } catch {
    return fallback;
  }
}

function requireSpec(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error('prAssembly invoked without SpecOutputs — spec must run first');
  }
  return spec;
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'prAssembly',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/prAssembly-attempt-*.txt and the pr-assembly agent prompt; re-run with --from prAssembly after fixing.',
  };
  return new EscalationError(detail);
}

void writeFileSync;
