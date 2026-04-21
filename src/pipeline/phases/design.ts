// Phase 1 — Design.
//
// Runs before spec for tasks that have design inputs on disk. The design
// agent's job is to describe exactly what the design shows (dimensions,
// tokens, state tables, accessibility requirements) so the spec agent
// and coding agent downstream make zero visual decisions.
//
// Design files are resolved from two locations, workspace first, project
// tasks folder as fallback:
//   1. harness/workspace/<project>/<task>/   ← task-specific override
//   2. harness/tasks/<project>/              ← project-level fallback
// Either location is sufficient to satisfy hasDesign.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EscalationError,
  type DesignOutputs,
  type EscalationDetail,
  type Phase,
  type PhaseResult,
  type RunContext,
} from '../../types.js';
import { callAgent } from '../../lib/claude.js';
import { formatBytes, resolveClaudeAsset } from '../../lib/paths.js';

const MIN_DESIGN_SPEC_BYTES = 200;

export interface ResolvedDesignFiles {
  readonly designPng: string | null;
  readonly designSystem: string | null;
}

/**
 * Locate design.png and design-system.md. Checks workspaceDir first, then
 * falls back to the project-level tasks dir. Returns null for either file
 * that cannot be found in either location.
 */
export function resolveDesignFiles(ctx: RunContext): ResolvedDesignFiles {
  const projectTaskDir = resolve(ctx.paths.tasksDir, ctx.task.project);
  const locations = [ctx.taskPaths.workspaceDir, projectTaskDir];

  let designPng: string | null = null;
  let designSystem: string | null = null;

  for (const dir of locations) {
    if (designPng === null) {
      const candidate = resolve(dir, 'design.png');
      if (existsSync(candidate)) designPng = candidate;
    }
    if (designSystem === null) {
      const candidate = resolve(dir, 'design-system.md');
      if (existsSync(candidate)) designSystem = candidate;
    }
    if (designPng !== null && designSystem !== null) break;
  }

  return { designPng, designSystem };
}

export const designPhase: Phase<'design'> = {
  name: 'design',
  shouldRun(ctx: RunContext): boolean {
    const { designPng, designSystem } = resolveDesignFiles(ctx);
    return designPng !== null || designSystem !== null;
  },

  async run(ctx: RunContext): Promise<PhaseResult<DesignOutputs>> {
    const startedAt = Date.now();
    const files = resolveDesignFiles(ctx);
    if (files.designPng === null && files.designSystem === null) {
      // Shouldn't happen given shouldRun, but be defensive.
      return {
        status: 'skipped',
        durationMs: Date.now() - startedAt,
        attempts: 0,
        outputs: { designSpecPath: '' },
      };
    }

    mkdirSync(ctx.taskPaths.workspaceDir, { recursive: true });
    const designSpecPath = resolve(ctx.taskPaths.workspaceDir, 'design-spec.md');

    const prompt = buildDesignPrompt(ctx, files, designSpecPath);
    const result = await callAgent({
      ctx,
      agent: 'designer.agent',
      phase: 'design',
      attempt: 1,
      prompt,
      timeoutMs: ctx.config.timeouts.otherAgentMs,
    });

    if (result.exitCode !== 0) {
      throw escalate(
        'designer agent exited non-zero',
        `exit=${result.exitCode}\n${(result.stderr || result.stdout).slice(-500)}`,
      );
    }

    if (!existsSync(designSpecPath)) {
      throw escalate(
        'designer agent did not produce design-spec.md',
        `expected at ${designSpecPath}`,
      );
    }

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(designSpecPath).size;
    } catch {
      // fall through to size check
    }
    if (sizeBytes < MIN_DESIGN_SPEC_BYTES) {
      throw escalate(
        'design-spec.md below minimum size',
        `${sizeBytes} bytes < ${MIN_DESIGN_SPEC_BYTES}`,
      );
    }

    ctx.logger.info(`design: design-spec.md written (${formatBytes(sizeBytes)})`);

    return {
      status: 'complete',
      durationMs: Date.now() - startedAt,
      attempts: 1,
      outputs: { designSpecPath },
    };
  },
};

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildDesignPrompt(
  ctx: RunContext,
  files: ResolvedDesignFiles,
  outputPath: string,
): string {
  const agentInstructions = readAgentIfResolvable(ctx, 'designer.agent.md');
  const taskContent = readIfExists(ctx.taskPaths.taskFile) ?? '(task file missing)';
  const designSystem = files.designSystem
    ? readIfExists(files.designSystem)
    : null;

  const parts: string[] = [
    '=== AGENT INSTRUCTIONS ===',
    agentInstructions.trim(),
    '',
    '=== TASK TICKET ===',
    taskContent.trim(),
    '',
  ];

  if (files.designPng) {
    parts.push(
      '=== DESIGN IMAGE (absolute path — read via your Read tool) ===',
      files.designPng,
      '',
    );
  }

  if (designSystem) {
    parts.push('=== DESIGN SYSTEM ===', designSystem.trim(), '');
  } else {
    parts.push('=== DESIGN SYSTEM ===', '(not provided)', '');
  }

  parts.push(
    '=== REQUIRED OUTPUT ===',
    `Write design-spec.md to: ${outputPath}`,
    `Minimum size: ${MIN_DESIGN_SPEC_BYTES} bytes.`,
    '',
    '=== YOUR TASK ===',
    'Produce design-spec.md per your instructions using the inputs above. The downstream coding agent makes no visual decisions — describe everything that matters.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readAgentIfResolvable(ctx: RunContext, name: string): string {
  try {
    const p = resolveClaudeAsset(ctx.paths, `agents/${name}`);
    return readFileSync(p, 'utf8');
  } catch {
    return `(${name} missing)`;
  }
}

function escalate(reason: string, details: string): EscalationError {
  const detail: EscalationDetail = {
    phase: 'design',
    reason,
    details,
    humanAction:
      'inspect runs/<id>/prompts/design-attempt-*.txt and the designer agent output; re-run with --from design.',
  };
  return new EscalationError(detail);
}
