// Phase 4 — Build.
//
// The coding + test agents are driven through a single claude invocation
// that carries both agents' instructions and the manifest. Parallel
// execution via Claude's Task tool is a future refinement; Step 4 runs
// them together in one prompt. Either way, this phase's job is:
//
//   1. Snapshot the workspace BEFORE any agent runs — this is the reset
//      point for any later retry or for gate correction in Step 5.
//   2. Call the agent with a prompt that supplies the spec, manifest,
//      context bundle, design spec (if applicable), and an explicit
//      no-touch list (with read:false entries called out separately).
//   3. Run three post-agent checks IN ORDER, failing fast between types:
//         presence → export alignment → no-touch
//      All violations of a failing type are reported together, not just
//      the first one — so the human (or a future correction loop) sees
//      the full shape of the problem.
//
// There is no correction loop here — hardGates owns that in Step 5. If
// any post-check fails after this phase completes, we escalate.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EscalationError,
  type BuildOutputs,
  type EscalationDetail,
  type ManifestEntry,
  type NoTouchViolation,
  type Phase,
  type PhaseResult,
  type RunContext,
  type SpecOutputs,
} from '../../types.js';
import { callAgent } from '../../lib/claude.js';
import { formatBytes, resolveClaudeAsset, toRelative } from '../../lib/paths.js';
import { takeSnapshot } from '../../lib/workspace.js';

export const buildPhase: Phase<'build'> = {
  name: 'build',
  shouldRun(ctx: RunContext): boolean {
    if (!ctx.capabilities) return false;
    return !ctx.capabilities.isE2ETask;
  },

  async run(ctx: RunContext): Promise<PhaseResult<BuildOutputs>> {
    const startedAt = Date.now();
    const spec = requireSpecOutputs(ctx);

    // 1. Workspace snapshot — MUST happen before the claude call.
    const snapshot = takeSnapshot(
      { paths: ctx.paths, taskPaths: ctx.taskPaths, runPaths: ctx.runPaths },
      'build',
    );
    ctx.logger.event('snapshot_taken', {
      phase: 'build',
      path: snapshot.path,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.checksum,
    });
    ctx.logger.info(
      `build: snapshot saved (${formatBytes(snapshot.sizeBytes)}) → ${toRelative(snapshot.path, ctx.paths.repoRoot)}`,
    );

    // 2. Invoke the agent.
    const prompt = buildCombinedPrompt(ctx, spec);
    const result = await callAgent({
      ctx,
      agent: 'coding.agent+test.agent',
      phase: 'build',
      attempt: 1,
      prompt,
      timeoutMs: ctx.config.timeouts.buildAgentMs,
    });

    if (result.exitCode !== 0) {
      const tail = (result.stderr || result.stdout).slice(-600);
      throw escalate(
        'build agent exited non-zero',
        `exit=${result.exitCode} signal=${result.signal ?? 'null'}\n${tail}`,
      );
    }

    // 3. Post-agent checks. Fail at first violation TYPE; report all.
    const presenceViolations = checkPresence(ctx, spec.manifestEntries);
    if (presenceViolations.length > 0) {
      throw escalate(
        'presence check failed',
        presenceViolations.map((v) => `  - ${v}`).join('\n'),
      );
    }

    const exportViolations = checkExportAlignment(ctx, spec);
    if (exportViolations.length > 0) {
      throw escalate(
        'export alignment failed',
        exportViolations.map((v) => `  - ${v}`).join('\n'),
      );
    }

    const noTouchViolations = checkNoTouch(ctx, spec.manifestEntries);
    if (noTouchViolations.some((v) => v.kind === 'logic')) {
      const logicOnly = noTouchViolations
        .filter((v) => v.kind === 'logic')
        .map((v) => `  - ${v.path}: ${v.description}`)
        .join('\n');
      throw escalate('no-touch file(s) modified with logic changes', logicOnly);
    }

    const filesWritten = spec.manifestEntries
      .filter((e) => e.action === 'create' || e.action === 'modify')
      .map((e) => e.path);

    const outputs: BuildOutputs = {
      filesWritten,
      noTouchViolations,
      correctionAttempts: 0,
    };

    return {
      status: 'complete',
      durationMs: Date.now() - startedAt,
      attempts: 1,
      outputs,
    };
  },
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildCombinedPrompt(ctx: RunContext, spec: SpecOutputs): string {
  const codingInstructions = readAgent(ctx, 'coding.agent.md');
  const testInstructions = readAgent(ctx, 'test.agent.md');
  const specText = readFileSafe(spec.specPath);
  const manifestText = readFileSafe(spec.manifestPath);
  const contextPath = resolve(ctx.taskPaths.workspaceDir, 'context.md');
  const contextText = readFileSafe(contextPath);
  const designSpecPath = resolve(ctx.taskPaths.workspaceDir, 'design-spec.md');
  const designText = ctx.capabilities?.hasDesign ? readIfExists(designSpecPath) : null;

  const noTouchList = spec.manifestEntries.filter((e) => e.action === 'no-touch');
  const noTouchReadable = noTouchList
    .filter((e) => e.read !== false)
    .map((e) => `  - ${e.path}`)
    .join('\n');
  const noTouchSealed = noTouchList
    .filter((e) => e.read === false)
    .map((e) => `  - ${e.path}  (DO NOT even read)`)
    .join('\n');

  const createModify = spec.manifestEntries.filter(
    (e) => e.action === 'create' || e.action === 'modify',
  );
  const implList = createModify
    .filter((e) => e.kind !== 'test')
    .map((e) => `  - ${e.path}  (${e.action}, kind: ${e.kind})`)
    .join('\n');
  const testList = createModify
    .filter((e) => e.kind === 'test')
    .map((e) => `  - ${e.path}  (${e.action}, kind: test)`)
    .join('\n');

  const pieces: string[] = [
    '=== CODING AGENT INSTRUCTIONS ===',
    codingInstructions.trim(),
    '',
    '=== TEST AGENT INSTRUCTIONS ===',
    testInstructions.trim(),
    '',
    '=== SPEC ===',
    specText.trim(),
    '',
    '=== MANIFEST ===',
    manifestText.trim(),
    '',
    '=== CONTEXT ===',
    contextText.trim(),
    '',
  ];

  if (designText) {
    pieces.push('=== DESIGN SPEC ===', designText.trim(), '');
  }

  pieces.push(
    '=== FILES TO CREATE/MODIFY (implementation, not tests) ===',
    implList || '(none)',
    '',
    '=== TEST FILES TO CREATE ===',
    testList || '(none)',
    '',
    '=== NO-TOUCH FILES (agent may read these for reference) ===',
    noTouchReadable || '(none)',
    '',
    '=== NO-TOUCH + DO-NOT-READ FILES (agent must not open these) ===',
    noTouchSealed || '(none)',
    '',
    '=== STOP HOOK — REQUIRED BEFORE DECLARING DONE ===',
    'Run `npx tsc --noEmit` from the repository root. If it reports any errors, fix them and rerun. Do not declare done until tsc exits cleanly.',
    '',
    '=== YOUR TASK ===',
    'Implement the impl/modify files per the coding instructions and the test files per the test instructions. Write them at the exact paths above. Respect the no-touch list. Finish only after tsc --noEmit passes.',
  );

  return pieces.join('\n');
}

// ---------------------------------------------------------------------------
// Post-agent checks
// ---------------------------------------------------------------------------

function checkPresence(
  ctx: RunContext,
  entries: readonly ManifestEntry[],
): string[] {
  const violations: string[] = [];
  for (const entry of entries) {
    if (entry.action !== 'create' && entry.action !== 'modify') continue;
    const abs = resolve(ctx.paths.repoRoot, entry.path);
    if (!existsSync(abs)) {
      violations.push(`missing after build: ${entry.path}`);
      continue;
    }
    try {
      if (statSync(abs).size === 0) {
        violations.push(`empty after build: ${entry.path}`);
      }
    } catch {
      violations.push(`unreadable after build: ${entry.path}`);
    }
  }
  return violations;
}

function checkExportAlignment(ctx: RunContext, spec: SpecOutputs): string[] {
  const declarations = parsePublicApi(readFileSafe(spec.specPath));
  if (declarations.length === 0) return [];
  const violations: string[] = [];
  for (const decl of declarations) {
    const abs = resolve(ctx.paths.repoRoot, decl.file);
    if (!existsSync(abs)) {
      violations.push(`${decl.symbol}: target file does not exist: ${decl.file}`);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      violations.push(`${decl.symbol}: cannot read ${decl.file}`);
      continue;
    }
    if (!containsExport(content, decl.symbol)) {
      violations.push(
        `${decl.symbol} declared in spec Public API but no matching export found in ${decl.file}`,
      );
    }
  }
  return violations;
}

function checkNoTouch(
  ctx: RunContext,
  entries: readonly ManifestEntry[],
): NoTouchViolation[] {
  const out: NoTouchViolation[] = [];
  for (const entry of entries) {
    if (entry.action !== 'no-touch') continue;
    const diff = gitDiffOf(ctx.paths.repoRoot, entry.path);
    if (diff === null || diff.length === 0) continue;
    if (isDataTestidOnly(diff)) {
      out.push({
        path: entry.path,
        kind: 'read',
        description: 'only data-testid additions — allowed',
      });
      continue;
    }
    out.push({
      path: entry.path,
      kind: 'logic',
      description: 'diff includes changes beyond data-testid additions',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spec Public API parser
// ---------------------------------------------------------------------------

interface PublicApiDecl {
  readonly file: string;
  readonly symbol: string;
}

function parsePublicApi(specText: string): PublicApiDecl[] {
  const headerRe = /^#{1,3}\s+.*Public API[^\n]*\r?\n([\s\S]*?)(?=^#{1,3}\s|\Z)/m;
  const m = headerRe.exec(specText);
  if (!m) return [];
  const section = m[1] ?? '';
  const out: PublicApiDecl[] = [];
  let currentFile: string | null = null;

  const codeBlockRe = /```[^\n]*\r?\n([\s\S]*?)```/g;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = codeBlockRe.exec(section)) !== null) {
    const block = codeMatch[1] ?? '';
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('//')) {
        currentFile = line.replace(/^\/\/\s*/, '').trim();
        continue;
      }
      if (!currentFile) continue;
      const sym = matchExportedSymbol(line);
      if (sym) {
        out.push({ file: currentFile, symbol: sym });
      }
    }
  }
  return out;
}

function matchExportedSymbol(line: string): string | null {
  const re = /^export\s+(?:const|let|var|type|interface|function|class|enum|async\s+function)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const m = re.exec(line);
  return m ? (m[1] ?? null) : null;
}

function containsExport(fileContent: string, symbol: string): boolean {
  const re = new RegExp(
    `export\\s+(?:const|let|var|type|interface|function|class|enum|async\\s+function)\\s+${escapeRegex(symbol)}\\b`,
  );
  return re.test(fileContent);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Git diff helpers
// ---------------------------------------------------------------------------

function gitDiffOf(repoRoot: string, path: string): string | null {
  const res = spawnSync(
    'git',
    ['diff', '--unified=0', '--', path],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    },
  );
  if (res.status !== 0 && !res.stdout) return null;
  return (res.stdout ?? '').toString();
}

function isDataTestidOnly(diff: string): boolean {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  if (removed.some((l) => l.trim().length > 0)) return false;
  return added.every((l) => l.trim().length === 0 || l.includes('data-testid'));
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function requireSpecOutputs(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error(
      'build phase invoked before spec phase — SpecOutputs missing from ctx.outputs',
    );
  }
  return spec;
}

function readAgent(ctx: RunContext, filename: string): string {
  return readFileSync(resolveClaudeAsset(ctx.paths, `agents/${filename}`), 'utf8');
}

function readFileSafe(path: string): string {
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

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'build',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/build-attempt-1.txt and the workspace files; fix the manifest or agent instructions, then re-run with --from build.',
  };
  return new EscalationError(detail);
}
