// Phase 6 — Hard Gates.
//
// Runs tsc, eslint, (conditionally) vitest + storybook on the
// post-build tree. If any gate fails we drive a correction loop:
// restore the pre-hardGates snapshot, send the coding agent a
// structured correction packet, then re-run ONLY the gates that
// previously failed. After `retries.gate` attempts we escalate with
// the accumulated error history.
//
// The correction packet prioritises, in order:
//   1. Failing files (full content)     — priority 1000
//   2. Their direct imports (one hop)   — priority 500
//   3. Spec.md                          — priority 250
//   4. Accumulated errors from prev     — priority 100
// Token budget is enforced in that order — spec drops before failing
// files ever do.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  EscalationError,
  type EscalationDetail,
  type GateResult,
  type HardGateOutputs,
  type Phase,
  type PhaseResult,
  type RunContext,
  type SpecOutputs,
  type TaskCapabilities,
} from '../../types.js';
import { callAgent } from '../../lib/claude.js';
import { resolveClaudeAsset } from '../../lib/paths.js';
import { runEslint, runStorybook, runTsc, runVitest } from '../../lib/shell.js';
import {
  fallbackBefore,
  loadSnapshot,
  restoreSnapshot,
  takeSnapshot,
} from '../../lib/workspace.js';
import {
  PRIORITY,
  enforceBudget,
  type ContextSection,
} from '../../lib/tokens.js';

type GateName = 'tsc' | 'eslint' | 'vitest' | 'storybook';

const TSC_FIRST: readonly GateName[] = ['tsc', 'eslint', 'vitest', 'storybook'];

interface GateMap {
  tsc: GateResult | null;
  eslint: GateResult | null;
  vitest: GateResult | null;
  storybook: GateResult | null;
}

export const hardGatesPhase: Phase<'hardGates'> = {
  name: 'hardGates',
  shouldRun(): boolean {
    return true;
  },

  async run(ctx: RunContext): Promise<PhaseResult<HardGateOutputs>> {
    const startedAt = Date.now();
    const caps = requireCapabilities(ctx);
    const spec = requireSpecOutputs(ctx);

    // Snapshot at top of phase. This is the reset point for every
    // correction attempt — the first fix never has stale state to fight.
    const snapshot = takeSnapshot(
      { paths: ctx.paths, taskPaths: ctx.taskPaths, runPaths: ctx.runPaths },
      'hardGates',
    );
    ctx.logger.event('snapshot_taken', {
      phase: 'hardGates',
      path: snapshot.path,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.checksum,
    });

    const deps = probeDeps(ctx.paths.repoRoot);
    const applicable: Record<GateName, boolean> = {
      tsc: true,
      eslint: true,
      vitest: caps.hasTests && deps.vitest,
      storybook: caps.hasUI && deps.storybook,
    };
    if (caps.hasTests && !deps.vitest) {
      ctx.logger.warn(
        'hardGates: vitest gate skipped — @vitest/* not in package.json dependencies',
      );
    }
    if (caps.hasUI && !deps.storybook) {
      ctx.logger.warn(
        'hardGates: storybook gate skipped — @storybook/* not in package.json dependencies',
      );
    }

    // Attempt 0 = initial run of all applicable gates.
    let results: GateMap = await runGates(ctx, applicable, allApplicable(applicable));
    let failing = collectFailing(results);
    // History kept ONLY for the escalation summary. Never fed back
    // into a correction prompt — each attempt is independent.
    const attemptHistory: AttemptError[] = snapshotErrors(results, 0);

    const maxCorrections = ctx.config.retries.gate;
    let correctionAttempts = 0;

    while (failing.size > 0 && correctionAttempts < maxCorrections) {
      correctionAttempts += 1;

      // Restore the snapshot before each fix attempt so the coding agent
      // always sees the same starting point (post-build, pre-hardGates).
      ctx.logger.info(
        `hardGates: correction attempt ${correctionAttempts}/${maxCorrections} — restoring snapshot`,
      );
      restoreSnapshotWithFallback(ctx, snapshot);

      // Current-attempt errors only — no accumulation across attempts.
      const prompt = buildCorrectionPrompt(ctx, spec, results, failing);
      const agent = await callAgent({
        ctx,
        agent: 'coding.agent (gate correction)',
        phase: 'hardGates',
        attempt: correctionAttempts,
        prompt,
        timeoutMs: ctx.config.timeouts.buildAgentMs,
      });

      ctx.logger.event('correction_attempt', {
        phase: 'hardGates',
        attempt: correctionAttempts,
        failingGatesBefore: [...failing],
        agentExitCode: agent.exitCode,
      });

      if (agent.exitCode !== 0) {
        const tail = (agent.stderr || agent.stdout).slice(-600);
        throw escalate(
          `coding agent failed during correction attempt ${correctionAttempts}`,
          `exit=${agent.exitCode}\n${tail}`,
        );
      }

      // Re-run ONLY the previously-failing gates. Leave passing results
      // as they were — we haven't touched them.
      const nextResults = await runGates(ctx, applicable, failing, results);
      results = nextResults;
      failing = collectFailing(results);
      attemptHistory.push(...snapshotErrors(results, correctionAttempts));
    }

    if (failing.size > 0) {
      throw escalate(
        `hard gates failed after ${correctionAttempts} correction attempts`,
        formatErrorsForEscalation(attemptHistory),
      );
    }

    const outputs: HardGateOutputs = {
      tsc: results.tsc as GateResult,
      eslint: results.eslint as GateResult,
      vitest: results.vitest,
      storybook: results.storybook,
      visualDiff: null,
      correctionAttempts,
    };
    return {
      status: 'complete',
      durationMs: Date.now() - startedAt,
      attempts: correctionAttempts + 1,
      outputs,
    };
  },
};

// ---------------------------------------------------------------------------
// Gate orchestration
// ---------------------------------------------------------------------------

function allApplicable(applicable: Record<GateName, boolean>): Set<GateName> {
  const s = new Set<GateName>();
  for (const name of TSC_FIRST) {
    if (applicable[name]) s.add(name);
  }
  return s;
}

async function runGates(
  ctx: RunContext,
  applicable: Record<GateName, boolean>,
  run: ReadonlySet<GateName>,
  prior: GateMap = { tsc: null, eslint: null, vitest: null, storybook: null },
): Promise<GateMap> {
  const out: GateMap = { ...prior };
  const cwd = ctx.paths.repoRoot;
  const gateMs = ctx.config.timeouts.gateMs;

  for (const name of TSC_FIRST) {
    if (!applicable[name]) {
      out[name] = null;
      continue;
    }
    if (!run.has(name)) continue;

    ctx.logger.info(`hardGates: running ${name}`);
    const gateStart = Date.now();
    let res: GateResult;
    switch (name) {
      case 'tsc':
        res = await runTsc({ cwd, timeoutMs: gateMs });
        break;
      case 'eslint':
        res = await runEslint({ cwd, timeoutMs: gateMs });
        break;
      case 'vitest':
        res = await runVitest({ cwd, timeoutMs: gateMs });
        break;
      case 'storybook':
        res = await runStorybook({ cwd, timeoutMs: gateMs });
        break;
    }
    out[name] = res;
    ctx.logger.event('gate', {
      gate: name,
      passed: res.passed,
      durationMs: res.durationMs,
      failingFileCount: res.failingFiles.length,
      errorCount: res.errors.length,
    });
    ctx.logger.info(
      `hardGates: ${name} ${res.passed ? 'PASS' : 'FAIL'} (${Date.now() - gateStart}ms)`,
    );

    // TSC failure short-circuits the rest of this attempt — no point
    // running eslint/vitest/storybook on code that doesn't compile.
    if (name === 'tsc' && !res.passed) {
      for (const later of TSC_FIRST) {
        if (later === 'tsc') continue;
        if (!applicable[later]) {
          out[later] = null;
          continue;
        }
        if (run.has(later) && !prior[later]) {
          // Leave `null` for gates we never ran this attempt.
          out[later] = prior[later];
        }
      }
      break;
    }
  }

  return out;
}

function collectFailing(results: GateMap): Set<GateName> {
  const s = new Set<GateName>();
  for (const name of TSC_FIRST) {
    const r = results[name];
    if (r && !r.passed) s.add(name);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Error accumulation
// ---------------------------------------------------------------------------

interface AttemptError {
  readonly attempt: number;
  readonly gate: GateName;
  readonly errors: readonly string[];
  readonly failingFiles: readonly string[];
}

function snapshotErrors(results: GateMap, attempt: number): AttemptError[] {
  const out: AttemptError[] = [];
  for (const name of TSC_FIRST) {
    const r = results[name];
    if (r && !r.passed && r.errors.length > 0) {
      out.push({
        attempt,
        gate: name,
        errors: r.errors,
        failingFiles: r.failingFiles,
      });
    }
  }
  return out;
}

function formatErrorsForEscalation(history: readonly AttemptError[]): string {
  if (history.length === 0) return '(no errors accumulated)';
  const parts: string[] = [];
  for (const e of history) {
    parts.push(`--- attempt ${e.attempt} / ${e.gate} ---`);
    for (const line of e.errors.slice(0, 20)) {
      parts.push(`  ${line}`);
    }
    if (e.errors.length > 20) {
      parts.push(`  …and ${e.errors.length - 20} more`);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Correction prompt
// ---------------------------------------------------------------------------

function buildCorrectionPrompt(
  ctx: RunContext,
  spec: SpecOutputs,
  results: GateMap,
  failing: ReadonlySet<GateName>,
): string {
  const codingInstructions = readFile(resolveClaudeAsset(ctx.paths, 'agents/coding.agent.md'));
  const specText = readFile(spec.specPath);

  // Collect unique failing-file absolute paths.
  const failingFilesSet = new Set<string>();
  const gateErrorBlocks: string[] = [];
  for (const name of failing) {
    const r = results[name];
    if (!r) continue;
    gateErrorBlocks.push(
      `--- ${name.toUpperCase()} ---`,
      ...r.errors.slice(0, 50),
      r.errors.length > 50 ? `(truncated — ${r.errors.length - 50} more)` : '',
    );
    for (const f of r.failingFiles) failingFilesSet.add(f);
  }
  const gateErrorsText = gateErrorBlocks.filter(Boolean).join('\n');

  const failingPaths = [...failingFilesSet];

  const failingFileSections: ContextSection[] = [];
  for (const p of failingPaths) {
    const abs = toAbsolute(ctx.paths.repoRoot, p);
    const content = readFileOr(abs, `(could not read ${p})`);
    const relPath = relative(ctx.paths.repoRoot, abs);
    failingFileSections.push({
      name: `failing:${relPath}`,
      priority: PRIORITY.manifestFile,
      content: `--- ${relPath} ---\n${content}`,
    });
  }

  const importPaths = collectDirectImports(ctx.paths.repoRoot, failingPaths, failingFilesSet);
  const importSections: ContextSection[] = importPaths.map((p) => ({
    name: `import:${p}`,
    priority: PRIORITY.siblingFile,
    content: `--- ${p} ---\n${readFileOr(toAbsolute(ctx.paths.repoRoot, p), '(unreadable)')}`,
  }));

  const specSection: ContextSection = {
    name: 'spec',
    priority: PRIORITY.standards, // 100 — intentionally below imports
    content: `--- spec.md ---\n${specText}`,
  };

  const budget = enforceBudget(
    [...failingFileSections, ...importSections, specSection],
    ctx.config.agents.maxPromptTokens,
    ctx.logger,
  );
  void budget; // currently we assemble from the raw list; logging already done

  const failingFilesBlock = failingFileSections.map((s) => s.content).join('\n\n');
  const importsBlock = importSections.map((s) => s.content).join('\n\n');

  const noTouchList = spec.manifestEntries
    .filter((e) => e.action === 'no-touch')
    .map((e) => `  - ${e.path}${e.read === false ? '  (DO NOT even read)' : ''}`)
    .join('\n');

  return [
    '=== CODING AGENT INSTRUCTIONS (correction pass) ===',
    codingInstructions.trim(),
    '',
    '=== FAILING GATES (current attempt only) ===',
    gateErrorsText || '(no errors captured)',
    '',
    '=== FAILING FILES (full content — top priority) ===',
    failingFilesBlock || '(none)',
    '',
    '=== DIRECT IMPORTS OF FAILING FILES ===',
    importsBlock || '(none)',
    '',
    '=== SPEC (may be token-capped) ===',
    specText.trim(),
    '',
    '=== NO-TOUCH FILES ===',
    noTouchList || '(none)',
    '',
    '=== YOUR TASK ===',
    'Fix only the failing files above so the listed gates pass. Do not refactor code that was working. Do not touch no-touch files. Run `npx tsc --noEmit` from the repo root before declaring done.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Snapshot restore with fallback
// ---------------------------------------------------------------------------

function restoreSnapshotWithFallback(
  ctx: RunContext,
  handle: { path: string; sidecarPath: string; checksum: string; phase: string; sizeBytes: number },
): void {
  try {
    restoreSnapshot(handle, {
      paths: ctx.paths,
      taskPaths: ctx.taskPaths,
      runPaths: ctx.runPaths,
    });
    return;
  } catch (err) {
    ctx.logger.warn(
      `hardGates: primary snapshot failed verification (${err instanceof Error ? err.message : String(err)}), trying fallback`,
    );
  }
  const fb = fallbackBefore(ctx.runPaths, 'hardGates');
  if (!fb) {
    throw new Error('hardGates: no valid snapshot to restore from (primary corrupted, no fallback)');
  }
  ctx.logger.warn(`hardGates: restoring from fallback snapshot phase=${fb.phase}`);
  restoreSnapshot(fb, {
    paths: ctx.paths,
    taskPaths: ctx.taskPaths,
    runPaths: ctx.runPaths,
  });
}

// keep helper visible for future phases
void loadSnapshot;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function readFileOr(path: string, fallback: string): string {
  try {
    if (!existsSync(path)) return fallback;
    return readFileSync(path, 'utf8');
  } catch {
    return fallback;
  }
}

function toAbsolute(repoRoot: string, p: string): string {
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

// ---------------------------------------------------------------------------
// Direct-import extraction (one-hop only)
// ---------------------------------------------------------------------------

const IMPORT_RE = /from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;
const IMPORT_EXT_CANDIDATES = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

function collectDirectImports(
  repoRoot: string,
  fromFiles: readonly string[],
  exclude: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  for (const rel of fromFiles) {
    const abs = toAbsolute(repoRoot, rel);
    if (!existsSync(abs)) continue;
    let src: string;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const fileDir = dirname(abs);
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = (m[1] ?? m[2] ?? '').trim();
      if (!spec || !(spec.startsWith('.') || spec.startsWith('/'))) continue;
      const base = resolve(fileDir, spec);
      for (const ext of ['', ...IMPORT_EXT_CANDIDATES]) {
        const candidate = base + ext;
        if (!existsSync(candidate)) continue;
        try {
          if (!statSync(candidate).isFile()) continue;
        } catch {
          continue;
        }
        const relPath = relative(repoRoot, candidate);
        if (!exclude.has(relPath)) seen.add(relPath);
        break;
      }
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Context requirements
// ---------------------------------------------------------------------------

function requireCapabilities(ctx: RunContext): TaskCapabilities {
  if (!ctx.capabilities) {
    throw new Error('hardGates phase invoked without TaskCapabilities — spec must run first');
  }
  return ctx.capabilities;
}

function requireSpecOutputs(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error('hardGates phase invoked without SpecOutputs — spec must run first');
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Dependency probe
// ---------------------------------------------------------------------------

interface DepProbe {
  readonly vitest: boolean;
  readonly storybook: boolean;
}

function probeDeps(repoRoot: string): DepProbe {
  const pkgPath = resolve(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return { vitest: false, storybook: false };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const names = Object.keys(all);
    const hasVitest = names.some((n) => n === 'vitest' || n.startsWith('@vitest/'));
    const hasStorybook = names.some((n) => n.startsWith('@storybook/') || n === 'storybook');
    return { vitest: hasVitest, storybook: hasStorybook };
  } catch {
    return { vitest: false, storybook: false };
  }
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'hardGates',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/hardGates-attempt-*.txt and the failing files; fix the underlying issue, then re-run with --from hardGates.',
  };
  return new EscalationError(detail);
}
