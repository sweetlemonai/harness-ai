// Phase 9 — Soft Gates (advisory).
//
// One claude call that fans out to four analyses — standards,
// accessibility, performance, security — via Claude's native Task tool.
// Each sub-agent appends its own JSON contract block labelled with the
// agent's name; we parse the four blocks back out of the combined
// stdout.
//
// Non-negotiable semantics:
//   - NEVER blocks the pipeline. Returns status: 'complete' regardless
//     of how many findings were reported.
//   - Findings are counted by severity using Array.filter — not grep.
//     The Bash harness's `grep -c` multiline bug does not exist here.
//   - A missing per-agent JSON block is logged at warn level and that
//     agent's entry in SoftGateOutputs becomes null. Not an escalation.
//   - Full per-agent markdown reports are persisted to
//     runs/<id>/reports/<agentName>.md for the PR description phase.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Phase,
  type PhaseResult,
  type RunContext,
  type Severity,
  type SoftGateFinding,
  type SoftGateOutputs,
  type SoftGateReport,
  type SoftGateStatus,
  type SpecOutputs,
} from '../../types.js';
import { callAgent } from '../../lib/claude.js';
import { resolveClaudeAsset } from '../../lib/paths.js';

type AgentName = 'standards' | 'accessibility' | 'performance' | 'security';

const AGENT_ORDER: readonly AgentName[] = [
  'standards',
  'accessibility',
  'performance',
  'security',
];

export const softGatesPhase: Phase<'softGates'> = {
  name: 'softGates',
  shouldRun(ctx: RunContext): boolean {
    return ctx.capabilities?.hasUI === true;
  },

  async run(ctx: RunContext): Promise<PhaseResult<SoftGateOutputs>> {
    const startedAt = Date.now();
    const spec = requireSpecOutputs(ctx);

    const prompt = buildSoftGatePrompt(ctx, spec);
    const result = await callAgent({
      ctx,
      agent: 'soft-gates (standards+a11y+perf+security)',
      phase: 'softGates',
      attempt: 1,
      prompt,
      timeoutMs: ctx.config.timeouts.buildAgentMs,
    });

    if (result.exitCode !== 0) {
      ctx.logger.warn(
        `softGates: coordinator exited ${result.exitCode} — attempting parse anyway`,
      );
    }

    // Extract per-agent blocks. The coordinator prompt instructs each
    // subagent to wrap its JSON block with a marker line. Blocks without
    // a matching marker still parse — we fall back to positional assignment
    // so a well-behaved run doesn't require extra prose discipline.
    const parsed = extractPerAgentBlocks(result.stdout);
    ctx.logger.event('info', {
      kind: 'soft_gate_parse',
      found: Object.keys(parsed).filter((k) => parsed[k as AgentName] !== null),
      missing: AGENT_ORDER.filter((a) => parsed[a] === null),
    });

    mkdirSync(ctx.runPaths.reportsDir, { recursive: true });

    const reports: Partial<Record<AgentName, SoftGateReport | null>> = {};
    for (const agent of AGENT_ORDER) {
      const block = parsed[agent];
      if (block === null) {
        ctx.logger.warn(
          `softGates: no JSON block for ${agent} — marking output null (advisory, not fatal)`,
        );
        reports[agent] = null;
        continue;
      }
      try {
        const report = coerceReport(block, agent);
        reports[agent] = report;
        writeReportMd(ctx, agent, report);
      } catch (err) {
        ctx.logger.warn(
          `softGates: ${agent} block malformed (${err instanceof Error ? err.message : String(err)}) — marking null`,
        );
        reports[agent] = null;
      }
    }

    // Counts via filter(), never grep.
    for (const agent of AGENT_ORDER) {
      const r = reports[agent];
      if (!r) continue;
      const counts = countBySeverity(r.findings);
      ctx.logger.event('info', {
        kind: 'soft_gate_summary',
        agent,
        status: r.status,
        high: counts.high,
        medium: counts.medium,
        low: counts.low,
      });
    }

    const outputs: SoftGateOutputs = {
      standards: reports.standards ?? null,
      accessibility: reports.accessibility ?? null,
      performance: reports.performance ?? null,
      security: reports.security ?? null,
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

function buildSoftGatePrompt(ctx: RunContext, spec: SpecOutputs): string {
  const agents = AGENT_ORDER.map((name) => ({
    name,
    instructions: resolveAgentOr(ctx, `${name}.agent.md`, '(agent file missing)'),
  }));

  const manifestFiles = spec.manifestEntries
    .filter((e) => (e.action === 'create' || e.action === 'modify') && e.kind !== 'test')
    .map((e) => e.path)
    .join(', ');

  const specText = readFileOr(spec.specPath, '(spec unreadable)');
  const manifestText = readFileOr(spec.manifestPath, '(manifest unreadable)');

  const parts: string[] = [
    '=== SOFT GATES COORDINATOR PROMPT ===',
    'You are coordinating four advisory code reviews. Use the Task tool to run each of the four reviews in parallel, passing the subagent a general-purpose context and the prompt body listed for that agent below. Wait for all four to complete, then collate their outputs. DO NOT run the reviews sequentially.',
    '',
    'Each reviewer produces exactly one fenced ```json ...``` block as its final output. You MUST include each block verbatim in YOUR final response, with a marker line immediately before it in this format:',
    '',
    '  @agent:<agentName>',
    '',
    "for example:",
    '',
    '  @agent:standards',
    '  ```json',
    '  {...}',
    '  ```',
    '',
    'Order the four blocks in your response as: standards, accessibility, performance, security. After the four blocks, stop — no additional prose.',
    '',
    '=== SPEC (shared context for all four reviewers) ===',
    specText.trim(),
    '',
    '=== MANIFEST ===',
    manifestText.trim(),
    '',
    `=== FILES IN SCOPE (review only these): ${manifestFiles || '(none)'} ===`,
    '',
  ];

  for (const agent of agents) {
    parts.push(
      `=== @${agent.name} AGENT PROMPT BODY ===`,
      agent.instructions.trim(),
      '',
    );
  }

  parts.push(
    '=== REMINDERS ===',
    '- All four reviews run in parallel (Task tool).',
    '- Each must produce its own JSON contract block as described in its agent prompt.',
    '- This is advisory. Do not block the pipeline regardless of findings.',
    '',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Per-agent block extraction
// ---------------------------------------------------------------------------

type ParsedBlocks = Record<AgentName, unknown | null>;

const MARKER_RE = /@agent:(standards|accessibility|performance|security)\s*\r?\n\s*```json\s*\r?\n([\s\S]*?)\r?\n```/gi;

function extractPerAgentBlocks(stdout: string): ParsedBlocks {
  const out: ParsedBlocks = {
    standards: null,
    accessibility: null,
    performance: null,
    security: null,
  };

  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(stdout)) !== null) {
    const name = (m[1] ?? '').toLowerCase() as AgentName;
    const body = m[2] ?? '';
    try {
      out[name] = JSON.parse(body);
    } catch {
      out[name] = null;
    }
  }

  // Fallback: if no markers matched, try positional assignment — pull every
  // ```json block from stdout in order and map to AGENT_ORDER.
  const missingAll = AGENT_ORDER.every((a) => out[a] === null);
  if (missingAll) {
    const blocks = allFencedJsonBlocks(stdout);
    for (let i = 0; i < AGENT_ORDER.length && i < blocks.length; i += 1) {
      out[AGENT_ORDER[i]!] = blocks[i];
    }
  }

  return out;
}

function allFencedJsonBlocks(stdout: string): unknown[] {
  const re = /```json\s*\r?\n([\s\S]*?)\r?\n```/g;
  const out: unknown[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    try {
      out.push(JSON.parse(m[1] ?? ''));
    } catch {
      // skip unparseable
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contract coercion
// ---------------------------------------------------------------------------

function coerceReport(raw: unknown, agent: AgentName): SoftGateReport {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${agent} block is not a JSON object`);
  }
  const v = raw as Record<string, unknown>;
  const status = v.status;
  if (status !== 'PASS' && status !== 'WARN') {
    throw new Error(`${agent}.status must be 'PASS' or 'WARN' (got ${String(status)})`);
  }
  const findingsRaw = v.findings;
  if (!Array.isArray(findingsRaw)) {
    throw new Error(`${agent}.findings must be an array`);
  }
  const findings: SoftGateFinding[] = [];
  for (let i = 0; i < findingsRaw.length; i += 1) {
    const entry = findingsRaw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${agent}.findings[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const severity = e.severity;
    if (severity !== 'high' && severity !== 'medium' && severity !== 'low') {
      throw new Error(`${agent}.findings[${i}].severity invalid: ${String(severity)}`);
    }
    const file = typeof e.file === 'string' ? e.file : '(unknown)';
    const message = typeof e.message === 'string' ? e.message : '';
    const line = typeof e.line === 'number' ? e.line : undefined;
    findings.push({
      severity: severity as Severity,
      file,
      message,
      ...(line !== undefined ? { line } : {}),
    });
  }
  return { status: status as SoftGateStatus, findings };
}

function countBySeverity(findings: readonly SoftGateFinding[]): {
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

// ---------------------------------------------------------------------------
// Report persistence — runs/<id>/reports/<agent>.md
// ---------------------------------------------------------------------------

function writeReportMd(
  ctx: RunContext,
  agent: AgentName,
  report: SoftGateReport,
): void {
  const path = resolve(ctx.runPaths.reportsDir, `${agent}.md`);
  const counts = countBySeverity(report.findings);
  const lines: string[] = [
    `# ${agent} — advisory report`,
    '',
    `status: **${report.status}**`,
    `findings: high=${counts.high}, medium=${counts.medium}, low=${counts.low}`,
    '',
  ];
  if (report.findings.length === 0) {
    lines.push('_no findings_');
  } else {
    lines.push('## Findings');
    for (const f of report.findings) {
      const where = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
      lines.push(`- **${f.severity}** ${where} — ${f.message}`);
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireSpecOutputs(ctx: RunContext): SpecOutputs {
  const spec = ctx.outputs.spec;
  if (!spec) {
    throw new Error('softGates phase invoked without SpecOutputs — spec must run first');
  }
  return spec;
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
