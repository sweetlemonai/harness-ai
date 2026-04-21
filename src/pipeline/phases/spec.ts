// Phase 2 — Spec.
//
// Invokes the spec agent, validates its output contract, parses the
// manifest it writes to the workspace, runs Layer 1 validation, and
// infers TaskCapabilities. Returns typed SpecOutputs so downstream phases
// (context, build) can read manifest + capabilities from ctx.
//
// Contract with the agent:
//   1. Agent writes spec.md + manifest.json to the absolute paths we supply.
//   2. Agent appends a fenced ```json ...``` block at the end of stdout
//      with the shape described in .claude/agents/spec.agent.md. Missing
//      or invalid → AgentContractError, retried up to retries.agent,
//      then escalated.
//   3. Manifest Layer 1 violations → retried the same way, then escalated.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AgentContractError,
  AgentTimeoutError,
  EscalationError,
  type EscalationDetail,
  type HarnessPaths,
  type Phase,
  type PhaseResult,
  type RunContext,
  type SpecOutputs,
} from '../../types.js';
import { callAgent, extractLastFencedJson } from '../../lib/claude.js';
import {
  hasDesignInputs,
  inferCapabilities,
  checkAgainstFrontmatter,
} from '../../lib/capabilities.js';
import { parseManifest, validateLayer1 } from '../../lib/manifest.js';
import { listClaudeAssets, resolveClaudeAsset } from '../../lib/paths.js';

// Re-export so existing imports (`spec.extractLastFencedJson`) keep working.
export { extractLastFencedJson } from '../../lib/claude.js';

export const specPhase: Phase<'spec'> = {
  name: 'spec',
  shouldRun(): boolean {
    return true;
  },

  async run(ctx: RunContext): Promise<PhaseResult<SpecOutputs>> {
    const startedAt = Date.now();
    const maxAttempts = ctx.config.retries.agent + 1;

    mkdirSync(ctx.taskPaths.workspaceDir, { recursive: true });
    mkdirSync(ctx.runPaths.promptsDir, { recursive: true });

    const specPath = resolve(ctx.taskPaths.workspaceDir, 'spec.md');
    const manifestPath = resolve(ctx.taskPaths.workspaceDir, 'manifest.json');

    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const prompt = buildSpecPrompt(ctx, specPath, manifestPath, lastError);

      let result;
      try {
        result = await callAgent({
          ctx,
          agent: 'spec.agent',
          phase: 'spec',
          attempt,
          prompt,
          timeoutMs: ctx.config.timeouts.otherAgentMs,
        });
      } catch (err) {
        if (err instanceof AgentTimeoutError) {
          if (attempt < maxAttempts) {
            lastError = `previous attempt timed out after ${err.timeoutMs}ms`;
            ctx.logger.warn(`spec: attempt ${attempt} timed out — retrying`);
            continue;
          }
          throw escalate('spec agent timed out on every attempt', err.message);
        }
        if (attempt < maxAttempts) {
          lastError = `previous attempt failed: ${err instanceof Error ? err.message : String(err)}`;
          ctx.logger.warn(`spec: attempt ${attempt} errored — retrying`);
          continue;
        }
        throw escalate(
          'spec agent failed to run',
          err instanceof Error ? err.message : String(err),
        );
      }

      // 1. Contract JSON — already extracted by callAgent; if it's null the
      //    agent didn't produce one.
      if (result.contract === null) {
        if (attempt < maxAttempts) {
          lastError = `previous attempt produced no \`\`\`json block. Stdout tail:\n${result.stdout.slice(-400)}`;
          ctx.logger.warn(`spec: attempt ${attempt} missing contract — retrying`);
          continue;
        }
        throw escalate(
          'spec agent did not produce a JSON contract block',
          result.stdout.slice(-400),
        );
      }
      try {
        assertSpecContractShape(result.contract);
      } catch (err) {
        if (err instanceof AgentContractError && attempt < maxAttempts) {
          lastError = `previous attempt violated contract: ${err.message}. Stdout tail:\n${result.stdout.slice(-400)}`;
          ctx.logger.warn(`spec: attempt ${attempt} contract shape invalid — retrying`);
          continue;
        }
        throw err instanceof AgentContractError
          ? escalate('spec agent violated output contract', err.message)
          : err;
      }

      // 2. File presence
      if (!existsSync(specPath) || !existsSync(manifestPath)) {
        if (attempt < maxAttempts) {
          lastError = `spec.md or manifest.json missing. Must be written to exactly:\n  ${specPath}\n  ${manifestPath}`;
          ctx.logger.warn(`spec: attempt ${attempt} missing files — retrying`);
          continue;
        }
        throw escalate(
          'spec agent did not produce required files',
          `expected:\n  ${specPath}\n  ${manifestPath}`,
        );
      }

      // 3. Parse + Layer 1
      let parsedManifest;
      try {
        parsedManifest = parseManifest(readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          lastError = `manifest.json parse error: ${msg}`;
          ctx.logger.warn(`spec: attempt ${attempt} manifest parse error — retrying`);
          continue;
        }
        throw escalate('manifest.json could not be parsed', msg);
      }

      const layer1 = validateLayer1(parsedManifest);
      ctx.logger.event('manifest_validated', {
        layer: 1,
        valid: layer1.valid,
        entries: parsedManifest.entries.length,
        violationCount: layer1.violations.length,
      });
      if (!layer1.valid) {
        const detail = layer1.violations.map((v) => `  - ${v}`).join('\n');
        if (attempt < maxAttempts) {
          lastError = `manifest Layer 1 failed:\n${detail}`;
          ctx.logger.warn(`spec: attempt ${attempt} Layer 1 violations — retrying`);
          continue;
        }
        throw escalate('manifest.json Layer 1 failed after max attempts', detail);
      }

      // 4. Capabilities + frontmatter cross-check (warn, don't fail)
      const capabilities = inferCapabilities(
        parsedManifest,
        hasDesignInputs(
          ctx.taskPaths.workspaceDir,
          resolve(ctx.paths.tasksDir, ctx.task.project),
        ),
        ctx.taskFrontmatter,
      );
      ctx.capabilities = capabilities;
      ctx.logger.event('capability_inferred', {
        hasUI: capabilities.hasUI,
        hasTests: capabilities.hasTests,
        hasStories: capabilities.hasStories,
        hasDesign: capabilities.hasDesign,
        isE2ETask: capabilities.isE2ETask,
      });

      const fmCheck = checkAgainstFrontmatter(capabilities, ctx.taskFrontmatter);
      if (!fmCheck.matches) {
        for (const msg of fmCheck.mismatches) {
          ctx.logger.warn(`frontmatter mismatch: ${msg}`);
        }
      }

      const outputs: SpecOutputs = {
        capabilities,
        manifestEntries: parsedManifest.entries,
        specPath,
        manifestPath,
      };

      return {
        status: 'complete',
        durationMs: Date.now() - startedAt,
        attempts: attempt,
        outputs,
      };
    }

    throw escalate('spec phase exhausted retries without succeeding', lastError ?? 'unknown');
  },
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildSpecPrompt(
  ctx: RunContext,
  specPath: string,
  manifestPath: string,
  previousError: string | null,
): string {
  const agentInstructions = readFileSync(
    resolveClaudeAsset(ctx.paths, 'agents/spec.agent.md'),
    'utf8',
  );
  const taskContent = readFileSync(ctx.taskPaths.taskFile, 'utf8');
  const standards = readStandards(ctx.paths);
  const designSpec = readIfExists(resolve(ctx.taskPaths.workspaceDir, 'design-spec.md'));

  const sections: string[] = [
    '=== AGENT INSTRUCTIONS ===',
    agentInstructions.trim(),
    '',
    '=== TASK TICKET ===',
    taskContent.trim(),
    '',
  ];

  if (designSpec) {
    sections.push('=== DESIGN SPEC (from workspace) ===', designSpec.trim(), '');
  }

  if (standards.length > 0) {
    sections.push('=== PROJECT STANDARDS ===');
    for (const s of standards) {
      sections.push(`--- ${s.name} ---`, s.content.trim(), '');
    }
  }

  sections.push(
    '=== REQUIRED OUTPUT FILES (absolute paths) ===',
    `spec.md:       ${specPath}`,
    `manifest.json: ${manifestPath}`,
    '',
    `Minimum acceptance criteria: ${ctx.config.gates.minAcceptanceCriteria}`,
    '',
  );

  if (previousError) {
    sections.push(
      '=== PREVIOUS ATTEMPT ERRORS ===',
      previousError,
      '',
      'Fix the above before producing new output. Do not repeat the same mistakes.',
      '',
    );
  }

  sections.push(
    '=== YOUR TASK ===',
    `Produce the spec and manifest per your instructions, then append the ` +
      `REQUIRED JSON contract block at the end of your response.`,
  );

  return sections.join('\n');
}

function readStandards(paths: HarnessPaths): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = [];
  for (const { name, path } of listClaudeAssets(paths, 'standards')) {
    try {
      out.push({ name, content: readFileSync(path, 'utf8') });
    } catch {
      // skip unreadable entries
    }
  }
  return out;
}

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contract shape assertion
// ---------------------------------------------------------------------------

function assertSpecContractShape(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentContractError(
      'spec.agent',
      'JSON contract block must be an object',
    );
  }
  const v = value as Record<string, unknown>;
  if (
    v.manifestSummary === undefined ||
    typeof v.publicApiCount !== 'number' ||
    typeof v.acceptanceCriteriaCount !== 'number'
  ) {
    throw new AgentContractError(
      'spec.agent',
      'contract must include manifestSummary, publicApiCount, acceptanceCriteriaCount',
    );
  }
  if (
    v.manifestSummary === null ||
    typeof v.manifestSummary !== 'object' ||
    Array.isArray(v.manifestSummary)
  ) {
    throw new AgentContractError(
      'spec.agent',
      'manifestSummary must be an object',
    );
  }
  const ms = v.manifestSummary as Record<string, unknown>;
  for (const key of ['impl', 'test', 'story', 'noTouch'] as const) {
    if (typeof ms[key] !== 'number') {
      throw new AgentContractError(
        'spec.agent',
        `manifestSummary.${key} must be a number`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Escalation helper
// ---------------------------------------------------------------------------

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'spec',
    reason,
    details,
    humanAction:
      'inspect the saved prompt/stdout in runs/<id>/prompts/, fix the task ticket or agent instructions, then re-run with --from spec.',
  };
  return new EscalationError(detail);
}
