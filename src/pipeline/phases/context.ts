// Phase 3 — Context.
//
// The context agent receives a ranked file bundle (manifest files first,
// siblings next, core library docs third, standards fourth, and a
// one-line version manifest for all other packages) and writes
// context.md to the task workspace.
//
// Core library docs and the version manifest are visually separated so
// the agent knows which libraries are exhaustively documented vs. merely
// pinned. After the agent runs, context.md must be present and at least
// a minimum size — a sub-200-byte context file is almost certainly a
// failed call.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  AgentContractError,
  EscalationError,
  type CoreLibraryEntry,
  type ContextOutputs,
  type EscalationDetail,
  type Phase,
  type PhaseResult,
  type RunContext,
  type SpecOutputs,
} from '../../types.js';
import { callAgent, extractLastFencedJson } from '../../lib/claude.js';
import { listClaudeAssets, resolveClaudeAsset } from '../../lib/paths.js';
import {
  PRIORITY,
  enforceBudget,
  type ContextSection,
} from '../../lib/tokens.js';

const MIN_CONTEXT_BYTES = 200;
const MAX_SIBLINGS_PER_DIR = 5;

export const contextPhase: Phase<'context'> = {
  name: 'context',
  shouldRun(ctx: RunContext): boolean {
    return ctx.capabilities !== null && !ctx.capabilities.isE2ETask;
  },
  async run(ctx: RunContext): Promise<PhaseResult<ContextOutputs>> {
    const startedAt = Date.now();
    const spec = requireSpecOutputs(ctx);
    const contextPath = resolve(ctx.taskPaths.workspaceDir, 'context.md');
    const maxAttempts = ctx.config.retries.agent + 1;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const { prompt, includedSectionCount, droppedSections } = buildContextPrompt(
        ctx,
        spec,
        contextPath,
        lastError,
      );

      const result = await callAgent({
        ctx,
        agent: 'context.agent',
        phase: 'context',
        attempt,
        prompt,
        timeoutMs: ctx.config.timeouts.otherAgentMs,
      });

      if (result.exitCode !== 0) {
        const tail = (result.stderr || result.stdout).slice(-500);
        if (attempt < maxAttempts) {
          lastError = `previous attempt exited ${result.exitCode}: ${tail}`;
          ctx.logger.warn(`context: attempt ${attempt} non-zero exit — retrying`);
          continue;
        }
        throw escalate(
          'context agent exited non-zero on every attempt',
          tail,
        );
      }

      if (!existsSync(contextPath)) {
        if (attempt < maxAttempts) {
          lastError = `previous attempt did not produce ${contextPath}`;
          ctx.logger.warn(`context: attempt ${attempt} missing context.md — retrying`);
          continue;
        }
        throw escalate(
          'context agent did not produce context.md',
          `expected ${contextPath}`,
        );
      }

      const sizeBytes = statSync(contextPath).size;
      if (sizeBytes < MIN_CONTEXT_BYTES) {
        if (attempt < maxAttempts) {
          lastError = `context.md is too small (${sizeBytes} bytes < ${MIN_CONTEXT_BYTES}). The agent must actually gather context, not write a stub.`;
          ctx.logger.warn(`context: attempt ${attempt} context too small — retrying`);
          continue;
        }
        throw escalate(
          'context.md below minimum size',
          `${sizeBytes} bytes < ${MIN_CONTEXT_BYTES}`,
        );
      }

      // Best-effort contract read — the context agent may include one,
      // but we don't require it. Missing is fine.
      let _contractLog: unknown = null;
      try {
        _contractLog = extractLastFencedJson(result.stdout);
      } catch {
        _contractLog = null;
      }
      void _contractLog;

      const outputs: ContextOutputs = {
        contextPath,
        filesIncluded: [`(included ${includedSectionCount} sections)`],
        filesDropped: droppedSections.map((d) => ({ path: d.name, sizeBytes: d.sizeBytes })),
      };

      return {
        status: 'complete',
        durationMs: Date.now() - startedAt,
        attempts: attempt,
        outputs,
      };
    }

    throw escalate('context phase exhausted retries', lastError ?? 'unknown');
  },
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

interface BuildPromptResult {
  readonly prompt: string;
  readonly includedSectionCount: number;
  readonly droppedSections: readonly { name: string; sizeBytes: number }[];
}

function buildContextPrompt(
  ctx: RunContext,
  spec: SpecOutputs,
  contextPath: string,
  previousError: string | null,
): BuildPromptResult {
  const agentInstructions = readFileSync(
    resolveClaudeAsset(ctx.paths, 'agents/context.agent.md'),
    'utf8',
  );
  const specText = readFileSafe(spec.specPath);
  const manifestText = readFileSafe(spec.manifestPath);

  const manifestSections = collectManifestFileSections(ctx, spec);
  const siblingSections = collectSiblingSections(ctx, spec, new Set(manifestSections.map((s) => s.path)));
  const coreLibSections = collectCoreLibDocs(ctx.config.coreLibraries);
  const standardsSections = collectStandardsSections(ctx);
  const versionManifestText = buildVersionManifestLine(ctx.paths.repoRoot);

  const sections: ContextSection[] = [
    ...manifestSections.map((m) => ({
      name: `manifest-file:${m.path}`,
      priority: PRIORITY.manifestFile,
      content: `--- ${m.path} ---\n${m.content}`,
    })),
    ...siblingSections.map((s) => ({
      name: `sibling:${s.path}`,
      priority: PRIORITY.siblingFile,
      content: `--- ${s.path} ---\n${s.content}`,
    })),
    ...coreLibSections.map((lib) => ({
      name: `core-lib:${lib.name}`,
      priority: PRIORITY.coreLibraryDoc,
      content: `--- core library: ${lib.name} (${lib.docs}) ---\n${lib.content}`,
    })),
    ...standardsSections.map((s) => ({
      name: `standard:${s.name}`,
      priority: PRIORITY.standards,
      content: `--- standard: ${s.name} ---\n${s.content}`,
    })),
  ];

  const budget = enforceBudget(sections, ctx.config.context.maxTokens, ctx.logger);

  const coreLibBlock = budget.included
    .filter((s) => s.name.startsWith('core-lib:'))
    .map((s) => s.content)
    .join('\n\n');

  const manifestBlock = budget.included
    .filter((s) => s.name.startsWith('manifest-file:'))
    .map((s) => s.content)
    .join('\n\n');

  const siblingBlock = budget.included
    .filter((s) => s.name.startsWith('sibling:'))
    .map((s) => s.content)
    .join('\n\n');

  const standardsBlock = budget.included
    .filter((s) => s.name.startsWith('standard:'))
    .map((s) => s.content)
    .join('\n\n');

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
    '=== CORE LIBRARIES (exhaustive docs below — treat as authoritative) ===',
    coreLibBlock || '(no core libraries configured — skip this section)',
    '',
    '=== VERSION MANIFEST (pinned versions only — consult docs externally if needed) ===',
    versionManifestText,
    '',
    '=== MANIFEST FILES (current content — empty for new creates) ===',
    manifestBlock || '(none)',
    '',
    '=== SIBLING FILES IN SAME DIRECTORIES ===',
    siblingBlock || '(none)',
    '',
    '=== PROJECT STANDARDS ===',
    standardsBlock || '(none)',
    '',
    '=== REQUIRED OUTPUT ===',
    `Write context.md to: ${contextPath}`,
    `Minimum size: ${MIN_CONTEXT_BYTES} bytes.`,
    '',
  ];

  if (previousError) {
    pieces.push(
      '=== PREVIOUS ATTEMPT ERRORS ===',
      previousError,
      '',
      'Fix the above before producing new output.',
      '',
    );
  }

  pieces.push(
    '=== YOUR TASK ===',
    'Produce context.md per your instructions using the bundled context above.',
  );

  return {
    prompt: pieces.join('\n'),
    includedSectionCount: budget.included.length,
    droppedSections: budget.dropped.map((d) => ({
      name: d.name,
      sizeBytes: d.sizeBytes,
    })),
  };
}

// ---------------------------------------------------------------------------
// Section collectors
// ---------------------------------------------------------------------------

interface FileSection {
  readonly path: string;
  readonly content: string;
}

function collectManifestFileSections(
  ctx: RunContext,
  spec: SpecOutputs,
): FileSection[] {
  const out: FileSection[] = [];
  for (const entry of spec.manifestEntries) {
    const abs = resolve(ctx.paths.repoRoot, entry.path);
    if (!existsSync(abs)) {
      out.push({ path: entry.path, content: '(file does not exist yet — will be created)' });
      continue;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      out.push({ path: entry.path, content: readFileSync(abs, 'utf8') });
    } catch {
      // ignore unreadable
    }
  }
  return out;
}

function collectSiblingSections(
  ctx: RunContext,
  spec: SpecOutputs,
  alreadyIncluded: ReadonlySet<string>,
): FileSection[] {
  const dirs = new Set<string>();
  for (const entry of spec.manifestEntries) {
    dirs.add(dirname(entry.path));
  }
  const out: FileSection[] = [];
  for (const dir of dirs) {
    const abs = resolve(ctx.paths.repoRoot, dir);
    if (!existsSync(abs)) continue;
    let siblings: string[];
    try {
      siblings = readdirSync(abs);
    } catch {
      continue;
    }
    const candidates: Array<{ rel: string; size: number }> = [];
    for (const name of siblings) {
      const rel = `${dir === '.' ? '' : dir + '/'}${name}`;
      if (alreadyIncluded.has(rel)) continue;
      const full = resolve(abs, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        candidates.push({ rel, size: st.size });
      } catch {
        continue;
      }
    }
    candidates.sort((a, b) => a.size - b.size);
    for (const c of candidates.slice(0, MAX_SIBLINGS_PER_DIR)) {
      try {
        out.push({ path: c.rel, content: readFileSync(resolve(ctx.paths.repoRoot, c.rel), 'utf8') });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

interface CoreLibSection {
  readonly name: string;
  readonly docs: string;
  readonly content: string;
}

function collectCoreLibDocs(entries: readonly CoreLibraryEntry[]): CoreLibSection[] {
  const out: CoreLibSection[] = [];
  for (const lib of entries) {
    // Docs URL-based fetching is Step 4+ scope; for now we include the
    // pointer so the agent can read it via its own WebFetch tool. When
    // lib/claude.ts gains a doc cache (future step), hydrate here.
    out.push({
      name: lib.name,
      docs: lib.docs,
      content: `(docs at ${lib.docs} — fetch with WebFetch if needed)`,
    });
  }
  return out;
}

interface StandardSection {
  readonly name: string;
  readonly content: string;
}

function collectStandardsSections(ctx: RunContext): StandardSection[] {
  const out: StandardSection[] = [];
  for (const { name, path } of listClaudeAssets(ctx.paths, 'standards')) {
    try {
      out.push({ name: `standards/${name}`, content: readFileSync(path, 'utf8') });
    } catch {
      // ignore unreadable
    }
  }
  for (const { name, path } of listClaudeAssets(ctx.paths, 'context')) {
    try {
      out.push({ name: `context/${name}`, content: readFileSync(path, 'utf8') });
    } catch {
      // ignore unreadable
    }
  }
  return out;
}

function buildVersionManifestLine(repoRoot: string): string {
  const pkgPath = resolve(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return '(no package.json at repo root)';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const combined: Record<string, string> = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const line = Object.entries(combined)
      .map(([n, v]) => `${n}@${String(v).replace(/^[\^~]/, '')}`)
      .join(', ');
    return line || '(no dependencies)';
  } catch (err) {
    return `(could not parse package.json: ${err instanceof Error ? err.message : String(err)})`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireSpecOutputs(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error(
      'context phase invoked before spec phase — SpecOutputs missing from ctx.outputs',
    );
  }
  return spec;
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    return `(could not read ${path}: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'context',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/context-attempt-*.txt and context.md (if produced); fix the spec or agent instructions, then re-run with --from context.',
  };
  return new EscalationError(detail);
}

// Keep relative helper visible for future re-use across phases.
void relative;
