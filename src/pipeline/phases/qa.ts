// Phase 7 — QA.
//
// The QA agent writes Playwright E2E tests AND adds any data-testid
// attributes it needs directly to src/ files. Both in a single claude
// invocation — there is no intermediate testid-requirements.md file and
// no second agent call.
//
// Post-agent checks (all before we mark complete):
//   1. harness/e2e/<project>/<task>/ is non-empty. Empty → escalate;
//      don't retry. An empty dir means the agent fundamentally failed,
//      not a transient error.
//   2. The agent's JSON contract block is present and parses into
//      QAOutputs-shape data.
//   3. harness/playwright.config.ts still uses `reporter: [['list']]`.
//      If the agent flipped it to html, run one targeted correction
//      that replaces the reporter line only — not a full re-run.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AgentContractError,
  EscalationError,
  type EscalationDetail,
  type Phase,
  type PhaseResult,
  type QAOutputs,
  type RunContext,
  type SpecOutputs,
  type TaskCapabilities,
  type TestidAddition,
} from '../../types.js';
import { callAgent, extractLastFencedJson } from '../../lib/claude.js';
import { resolveClaudeAsset } from '../../lib/paths.js';

export const qaPhase: Phase<'qa'> = {
  name: 'qa',
  shouldRun(ctx: RunContext): boolean {
    if (!ctx.config.phases.e2e) return false;
    if (!ctx.capabilities) return false;
    return ctx.capabilities.hasUI || ctx.capabilities.isE2ETask;
  },

  async run(ctx: RunContext): Promise<PhaseResult<QAOutputs>> {
    const startedAt = Date.now();
    const caps = requireCapabilities(ctx);
    const spec = requireSpecOutputs(ctx);
    void caps;

    // Ensure the e2e dir exists so the emptiness check is meaningful.
    ensureDir(ctx.taskPaths.e2eDir);

    const prompt = buildQaPrompt(ctx, spec);
    const result = await callAgent({
      ctx,
      agent: 'qa.agent',
      phase: 'qa',
      attempt: 1,
      prompt,
      timeoutMs: ctx.config.timeouts.buildAgentMs,
    });

    if (result.exitCode !== 0) {
      throw escalate(
        'QA agent exited non-zero',
        `exit=${result.exitCode}\n${(result.stderr || result.stdout).slice(-800)}`,
      );
    }

    // 1. E2E dir non-empty (hard requirement — no retry).
    const e2eFiles = listE2eFiles(ctx.taskPaths.e2eDir);
    if (e2eFiles.length === 0) {
      throw escalate(
        'QA agent produced no E2E tests',
        `expected at least one file under ${ctx.taskPaths.e2eDir}`,
      );
    }

    // 2. JSON contract block.
    if (result.contract === null) {
      throw escalate(
        'QA agent did not produce a JSON contract block',
        result.stdout.slice(-500),
      );
    }
    let qa: QAOutputs;
    try {
      qa = assertQAContract(result.contract);
    } catch (err) {
      if (err instanceof AgentContractError) {
        throw escalate('QA agent contract invalid', err.message);
      }
      throw err;
    }

    // Cross-check testsWritten against files actually present. Mismatch is
    // a soft warning — what's on disk is authoritative.
    const onDiskRel = new Set(
      e2eFiles.map((abs) =>
        toProjectRelative(ctx.paths.repoRoot, abs),
      ),
    );
    for (const claimed of qa.testsWritten) {
      if (!onDiskRel.has(claimed) && !existsSync(resolve(ctx.paths.repoRoot, claimed))) {
        ctx.logger.warn(
          `qa: contract reports test '${claimed}' but it's not on disk`,
        );
      }
    }

    // 3. Playwright config reporter sanity.
    if (playwrightConfigHasHtmlReporter(ctx.paths.playwrightConfig)) {
      ctx.logger.warn(
        'qa: playwright.config.ts has html reporter — running targeted correction',
      );
      await correctPlaywrightReporter(ctx);
      if (playwrightConfigHasHtmlReporter(ctx.paths.playwrightConfig)) {
        throw escalate(
          'playwright.config.ts still has html reporter after correction',
          'the html reporter blocks the pipeline waiting on a report server',
        );
      }
    }

    ctx.logger.event('info', {
      kind: 'qa_summary',
      testsOnDisk: e2eFiles.length,
      testsReported: qa.testsWritten.length,
      testidFiles: qa.testidAdditions.length,
      testidCount: qa.testidAdditions.reduce((n, a) => n + a.ids.length, 0),
    });

    return {
      status: 'complete',
      durationMs: Date.now() - startedAt,
      attempts: 1,
      outputs: qa,
    };
  },
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildQaPrompt(ctx: RunContext, spec: SpecOutputs): string {
  const agentInstructions = readFile(
    resolveClaudeAsset(ctx.paths, 'agents/qa.agent.md'),
  );
  const specText = readFile(spec.specPath);
  const manifestText = readFile(spec.manifestPath);

  const designSpecPath = resolve(ctx.taskPaths.workspaceDir, 'design-spec.md');
  const designText = ctx.capabilities?.hasDesign ? readIfExists(designSpecPath) : null;

  const implSummary = spec.manifestEntries
    .filter((e) => (e.action === 'create' || e.action === 'modify') && e.kind !== 'test')
    .map((e) => {
      const abs = resolve(ctx.paths.repoRoot, e.path);
      let lineCount = 0;
      try {
        lineCount = readFileSync(abs, 'utf8').split(/\r?\n/).length;
      } catch {
        // skip
      }
      return `  - ${e.path}  (${lineCount} lines)`;
    })
    .join('\n');

  const parts: string[] = [
    '=== AGENT INSTRUCTIONS ===',
    agentInstructions.trim(),
    '',
    '=== SPEC ===',
    specText.trim(),
    '',
    '=== MANIFEST ===',
    manifestText.trim(),
    '',
  ];

  if (designText) {
    parts.push('=== DESIGN SPEC ===', designText.trim(), '');
  }

  parts.push(
    '=== IMPLEMENTATION FILES (summary) ===',
    implSummary || '(none)',
    '',
    '=== REQUIRED OUTPUT LOCATION ===',
    `E2E test directory (write .spec.ts files under this, and only here): ${ctx.taskPaths.e2eDir}`,
    `Playwright config (DO NOT modify the reporter field — it must remain reporter: [['list']]): ${ctx.paths.playwrightConfig}`,
    `App dev server baseURL: http://localhost:5173`,
    '',
    '=== YOUR TASK ===',
    'Write Playwright E2E tests covering the acceptance criteria. If you need a data-testid on any element in src/ that is not already present, add it directly to the source file — it is purely additive and explicitly allowed. Do not create testid-requirements.md; do not leave notes for a later pass. End your response with the required JSON contract block.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// QA contract
// ---------------------------------------------------------------------------

function assertQAContract(value: unknown): QAOutputs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentContractError('qa.agent', 'contract must be a JSON object');
  }
  const v = value as Record<string, unknown>;

  const testsWritten = asStringArray(v.testsWritten, 'testsWritten');
  const additionsRaw = v.testidAdditions;
  if (!Array.isArray(additionsRaw)) {
    throw new AgentContractError('qa.agent', 'testidAdditions must be an array');
  }
  const additions: TestidAddition[] = [];
  for (let i = 0; i < additionsRaw.length; i += 1) {
    const entry = additionsRaw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AgentContractError(
        'qa.agent',
        `testidAdditions[${i}] must be an object`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.file !== 'string') {
      throw new AgentContractError(
        'qa.agent',
        `testidAdditions[${i}].file must be a string`,
      );
    }
    const ids = asStringArray(e.ids, `testidAdditions[${i}].ids`);
    additions.push({ file: e.file, ids });
  }
  return { testsWritten, testidAdditions: additions };
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new AgentContractError('qa.agent', `${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'string') {
      throw new AgentContractError(
        'qa.agent',
        `${field}[${i}] must be a string`,
      );
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Playwright config reporter check + targeted correction
// ---------------------------------------------------------------------------

function playwrightConfigHasHtmlReporter(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  const raw = readFileSync(configPath, 'utf8');
  // Look for the reporter field specifically — not just any occurrence of 'html'.
  const reporterMatch = /reporter\s*:\s*\[([\s\S]*?)\]/.exec(raw);
  if (!reporterMatch) return false;
  return /['"]html['"]/.test(reporterMatch[1] ?? '');
}

async function correctPlaywrightReporter(ctx: RunContext): Promise<void> {
  const raw = readFileSync(ctx.paths.playwrightConfig, 'utf8');
  const fixed = raw.replace(
    /reporter\s*:\s*\[[\s\S]*?\]/,
    "reporter: [['list']]",
  );
  if (fixed === raw) {
    // Nothing to replace; fall through and let the post-check fail loudly.
    return;
  }
  writeFileSync(ctx.paths.playwrightConfig, fixed, 'utf8');
  ctx.logger.info('qa: playwright.config.ts reporter field reset to [[\'list\']]');
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

function listE2eFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
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
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && /\.(spec|test)\.[tj]sx?$/.test(entry)) {
          out.push(full);
        }
      } catch {
        // skip unreadable
      }
    }
  };
  walk(dir);
  return out;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(path, { recursive: true });
  }
}

function toProjectRelative(repoRoot: string, abs: string): string {
  if (!abs.startsWith(repoRoot)) return abs;
  return abs.slice(repoRoot.length + 1);
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return `(could not read ${path}: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function requireCapabilities(ctx: RunContext): TaskCapabilities {
  if (!ctx.capabilities) {
    throw new Error('qa phase invoked without TaskCapabilities — spec must run first');
  }
  return ctx.capabilities;
}

function requireSpecOutputs(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error('qa phase invoked without SpecOutputs — spec must run first');
  }
  return spec;
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'qa',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/qa-attempt-*.txt and the QA agent instructions; adjust and re-run with --from qa.',
  };
  return new EscalationError(detail);
}

void extractLastFencedJson;
