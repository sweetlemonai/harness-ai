// Dual-stream logger.
//
// Every call writes to three destinations from one entry point:
//   1. stdout — colored, symbol-based human-readable output (the subject
//      of this rewrite).
//   2. harness.log — plain-text single-line-per-event record for grep.
//   3. events.jsonl — structured, schemaVersion-tagged JSON record for
//      machines. Unchanged by this rewrite.
//
// Writes are synchronous so a SIGKILL from a timeout can't orphan
// buffered bytes. A pipeline runs at human speed; sync I/O is fine.
//
// Terminal formatting rules live in this module only — call sites in
// pipeline/phases keep passing plain strings. We pattern-match a couple
// of common shapes (`agent <name>: invoking …`, `<phase>: <gate> PASS|
// FAIL (<ms>ms)`) and fall back to a generic `<ts> <symbol> <phase>
// <message>` layout otherwise.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EVENT_SCHEMA_VERSION,
  type EventType,
  type LogEvent,
  type Logger,
  type PhaseId,
  type RunStatus,
} from '../types.js';

// ---------------------------------------------------------------------------
// Colors + symbols
// ---------------------------------------------------------------------------

/**
 * ANSI color palette. Exported so other CLI surfaces (project summary,
 * status table) can match the logger's look without duplicating codes.
 */
export const C = {
  violet: '\x1b[38;5;135m',
  pink: '\x1b[38;5;213m',
  blue: '\x1b[38;2;27;161;226m',
  green: '\x1b[38;5;120m',
  amber: '\x1b[38;5;214m',
  red: '\x1b[38;5;196m',
  white: '\x1b[97m',
  dimGray: '\x1b[38;5;240m',
  dimCyan: '\x1b[38;5;80m',
  dimWhite: '\x1b[38;5;250m',
  // Subtle dark background, used to tint the `[ phase ]` banner so it
  // reads as a structural divider even in busy terminals. Paired with
  // violet + bold foreground on the phase name.
  bgDim: '\x1b[48;5;236m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

type Level = 'info' | 'warn' | 'error' | 'success';

const SYMBOL: Record<Level, string> = {
  info: '→',
  success: '✓',
  warn: '⚠',
  error: '✗',
};

const SYMBOL_COLOR: Record<Level, string> = {
  info: C.blue,
  success: C.green,
  warn: C.amber,
  error: C.red,
};

const PHASE_NAME_WIDTH = 14; // column width for the <phase>/<agent> segment

// Per-phase color, used only in the phase-name column of normal log
// lines (not for agent lines — agents keep their own pink color). Each
// phase gets a distinct shade so scrolling through a task's output
// lets the reader see at a glance which phase they're looking at.
const PHASE_COLOR: Record<string, string> = {
  preflight: C.dimWhite,
  design: C.pink,
  spec: C.violet,
  context: C.dimCyan,
  build: C.amber,
  reconcile: C.dimWhite,
  hardGates: C.blue,
  qa: C.pink,
  e2e: C.green,
  softGates: C.dimCyan,
  softgates: C.dimCyan,
  prAssembly: C.amber,
  prassembly: C.amber,
  git: C.green,
  pipeline: C.violet,
  runner: C.dimWhite,
};

function phaseColor(name: string): string {
  return PHASE_COLOR[name] ?? C.violet;
}

// ---------------------------------------------------------------------------
// LoggerOptions
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  readonly runId: string;
  readonly project: string;
  readonly task: string;
  readonly eventsFile: string;
  readonly logFile: string;
  readonly terminal?: boolean;
  readonly color?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLogger(opts: LoggerOptions): Logger {
  ensureParentDir(opts.eventsFile);
  ensureParentDir(opts.logFile);

  const terminal = opts.terminal ?? true;
  const useColor = opts.color ?? shouldUseColor();
  const baseFields = {
    runId: opts.runId,
    project: opts.project,
    task: opts.task,
  };

  const writeEventLine = (event: LogEvent): void => {
    appendFileSync(opts.eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
  };

  const writeLogLine = (line: string): void => {
    appendFileSync(opts.logFile, `${line}\n`, 'utf8');
  };

  const writeTerminal = (line: string): void => {
    if (!terminal) return;
    process.stdout.write(`${line}\n`);
  };

  const emitLevel = (
    level: Level,
    rawMessage: string,
    extra?: Record<string, unknown>,
  ): void => {
    const now = new Date();
    const iso = now.toISOString();
    const type: EventType =
      level === 'success' ? 'info' : (level as EventType);
    // Strip the project-root prefix from the message string before ANY
    // human-facing surface sees it. Structured event payloads (extra)
    // are machine-consumable and stay untouched.
    const message = relativize(rawMessage);
    const event: LogEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      ts: iso,
      ...baseFields,
      type,
      level,
      message,
      ...(extra ?? {}),
    };

    writeLogLine(`[${iso}] ${SYMBOL[level]} ${message}`);
    writeEventLine(event);

    if (!terminal) return;
    // Event lines live INSIDE the current phase's `[ phase ] ─────`
    // block, so every level call gets a two-space indent. The phase
    // header itself is printed by runner.ts via logPhaseHeader.
    const line = renderTerminalLine(level, message, shortTime(now), useColor, {
      project: opts.project,
      task: opts.task,
    });
    // The renderer may return a two-line string (escalation with path);
    // indent both.
    writeTerminal(line.split('\n').map((l) => `  ${l}`).join('\n'));
  };

  return {
    info(message, extra) {
      emitLevel('info', message, extra);
    },
    warn(message, extra) {
      emitLevel('warn', message, extra);
    },
    error(message, extra) {
      emitLevel('error', message, extra);
    },
    success(message, extra) {
      emitLevel('success', message, extra);
    },
    event(type, fields) {
      const now = new Date();
      const iso = now.toISOString();
      const event: LogEvent = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        ts: iso,
        ...baseFields,
        type,
        ...fields,
      };
      writeEventLine(event);
      const summary = summarizeEvent(type, fields);
      writeLogLine(`[${iso}] = ${type} ${summary}`);
      // No terminal output for events — the task header/footer
      // (logTaskStart / logTaskEnd) wrap the entire run. Per-phase
      // structure comes from the runner's blank-line separator plus
      // the level-based log lines above.
    },
    async close() {
      /* sync appends — nothing buffered */
    },
  };
}

// ---------------------------------------------------------------------------
// Terminal rendering — pattern-matched
// ---------------------------------------------------------------------------

const AGENT_INVOKING_RE =
  /^agent (\S+): invoking \(attempt (\d+), ~(\d+) tokens in\)$/;
const GATE_RESULT_RE = /^(\S+): (\S+) (PASS|FAIL)(?: \((\d+)ms\))?$/;
// Accepts `phase X: …` (from runner.ts skip messages) as well as the
// plain `X: …` prefix used by most call sites.
const PHASE_PREFIX_RE = /^(?:phase )?([A-Za-z][A-Za-z0-9]*): (.+)$/s;
const ESCALATION_RE = /^ESCALATION in phase (\S+): (.+)$/s;
const PIPELINE_COMPLETE_RE = /^pipeline complete$/;

// Column width for agent / gate name when that specific pattern renders.
// Phase name is NOT a column anymore — it's in the phase header above.
const NAME_COLUMN_WIDTH = 16;

function renderTerminalLine(
  level: Level,
  message: string,
  ts: string,
  useColor: boolean,
  ctx: { project: string; task: string },
): string {
  const symbol = tint(SYMBOL[level], SYMBOL_COLOR[level], useColor);
  const time = tint(`[${ts}]`, C.dimGray, useColor);

  // Agent invoking: "agent <name>: invoking (attempt N, ~T tokens in)"
  const agent = AGENT_INVOKING_RE.exec(message);
  if (agent) {
    const [, name, attempt, tokens] = agent;
    const agentCell = tint(padEnd(name!, NAME_COLUMN_WIDTH), C.pink, useColor);
    const invoking = tint('invoking', C.blue, useColor);
    const attemptStr = tint(`attempt ${attempt}`, C.dimWhite, useColor);
    const tokensStr = tint(
      `~${fmtNumber(Number(tokens))} tokens`,
      C.dimCyan,
      useColor,
    );
    return `${time}  ${symbol}  ${agentCell}  ${invoking}  ${attemptStr}  ${tokensStr}`;
  }

  // Gate result: "<phase>: <gate> PASS|FAIL (<ms>ms)"
  const gate = GATE_RESULT_RE.exec(message);
  if (gate && (gate[3] === 'PASS' || gate[3] === 'FAIL')) {
    const [, , gateName, status, ms] = gate;
    const passed = status === 'PASS';
    const gateCell = tint(padEnd(gateName!, NAME_COLUMN_WIDTH), C.white, useColor);
    const verb = tint(passed ? 'passed' : 'failed', passed ? C.green : C.red, useColor);
    const dur = ms
      ? tint(`(${fmtNumber(Number(ms))}ms)`, C.dimWhite, useColor)
      : '';
    const passSymbol = tint(passed ? '✓' : '✗', passed ? C.green : C.red, useColor);
    return `${time}  ${passSymbol}  ${gateCell}  ${verb}${dur ? ' ' + dur : ''}`;
  }

  // Escalation: "ESCALATION in phase <phase>: <reason>"
  // Render as a two-line block; second line carries the path. No phase
  // name column — the phase header above already shows which phase.
  const esc = ESCALATION_RE.exec(message);
  if (esc) {
    const [, , reason] = esc;
    const label = tint('ESCALATION', `${C.red}${C.bold}`, useColor);
    const reasonText = tint(reason!, C.white, useColor);
    const firstLine = `${time}  ${tint('✗', C.red, useColor)}  ${label} — ${reasonText}`;
    const escPath = `harness/tasks/${ctx.project}/${ctx.task}/runs/current/ESCALATION.md`;
    // Align the arrow with the message start: `[hh:mm:ss]` (10) + `  ` (2)
    // + emoji (counted as 2 wide) + `  ` (2) = 16.
    const indent = ' '.repeat(16);
    const secondLine = `${indent}${tint(`→ ${escPath}`, C.dimGray, useColor)}`;
    return `${firstLine}\n${secondLine}`;
  }

  // Pipeline complete — suppressed: the task footer already signals this.
  if (PIPELINE_COMPLETE_RE.test(message)) {
    return `${time}  ${tint('✓', C.green, useColor)}  ${tint('complete', `${C.green}${useColor ? C.bold : ''}`, useColor)}`;
  }

  // Generic: strip an optional `<phase>:` or `phase <phase>:` prefix
  // from the message (phase is shown in the header above), keep
  // everything after as the event's own message, and colorize keywords
  // + sizes + token counts inline.
  let body = message;
  const phasePrefix = PHASE_PREFIX_RE.exec(message);
  if (phasePrefix) body = phasePrefix[2] ?? message;
  return `${time}  ${symbol}  ${colorizeInline(body, useColor)}`;
}

// ---------------------------------------------------------------------------
// Task-level header / footer
//
// These wrap the entire run — logTaskStart at the top of runPipeline,
// logTaskEnd in its finally block. They are module-level so the runner
// can call them without holding a Logger instance (the logger instance
// hasn't been constructed yet at the very start of a task, and
// createLogger's destructor isn't the right place for closing output).
// ---------------------------------------------------------------------------

const BANNER_WIDTH = 80;
const PHASE_HEADER_WIDTH = 80;

// Per-task state for phase header spacing. Reset in logTaskStart so
// each new task starts clean.
let _firstPhaseEmitted = false;
let _lastPhaseWasSkipped = false;

export function logTaskStart(project: string, task: string): void {
  const useColor = shouldUseColor();
  const taskRef = `${project}/${task}`;
  const ts = shortTime(new Date());
  _firstPhaseEmitted = false;
  _lastPhaseWasSkipped = false;
  process.stdout.write(`${taskHeader(taskRef, ts, useColor)}\n\n`);
}

/**
 * Render a `[ phase ] ─────` banner to stdout. Called by runner.ts at
 * the top of every active phase iteration (skipped phases are handled
 * separately by logSkippedPhases).
 *
 * Styling:
 *   - `[ phase ]` prints in violet + bold on a dim background.
 *   - Fill `─` is dim gray to column 80.
 *   - No leading blank line before the first phase of a task.
 *   - One blank line between adjacent active-phase groups.
 *
 * NO_COLOR preserves brackets and fill chars — only ANSI codes strip.
 */
export function logPhaseHeader(phase: PhaseId): void {
  const useColor = shouldUseColor();
  if (_firstPhaseEmitted) process.stdout.write('\n');
  _firstPhaseEmitted = true;
  _lastPhaseWasSkipped = false;

  const bracket = `[ ${phase} ]`;
  const prefix = `${bracket} `;
  const fillCount = Math.max(3, PHASE_HEADER_WIDTH - visibleWidth(prefix));
  const fill = '─'.repeat(fillCount);

  if (!useColor) {
    process.stdout.write(`${prefix}${fill}\n`);
    return;
  }
  const bracketColored = `${C.bgDim}${C.violet}${C.bold}${bracket}${C.reset}`;
  const fillColored = `${C.dimGray}${fill}${C.reset}`;
  process.stdout.write(`${bracketColored} ${fillColored}\n`);
}

/**
 * Render a flush phase-completion line like `✓  preflight    complete (704ms)`.
 * Called by runner.ts after phase.run() returns status: complete.
 *
 * Sits outside the 2-space event indent — it's a summary, not an event.
 * Phase name is violet (matches the header bracket); duration is dim
 * cyan; checkmark is green.
 */
export function logPhaseComplete(
  phase: PhaseId,
  durationMs: number,
  summary?: string,
): void {
  const useColor = shouldUseColor();
  const name = padEnd(phase, 14);
  const dur = fmtDuration(durationMs);
  const text = summary ?? 'complete';
  if (!useColor) {
    process.stdout.write(`✓  ${name}  ${text} (${dur})\n`);
    return;
  }
  const check = tint('✓', C.green, useColor);
  const nameCol = tint(name, C.violet, useColor);
  const body = tint(text, C.green, useColor);
  const durCol = tint(`(${dur})`, C.dimCyan, useColor);
  process.stdout.write(`${check}  ${nameCol}  ${body} ${durCol}\n`);
}

/**
 * Emit a single collapsed line for a run of consecutive skipped phases:
 *
 *   —  reconcile · context · qa  skipped
 *
 * Indented 2 spaces to align with phase-event indent. Uses em-dash
 * symbol in dim gray. Called by runner.ts when a skipped-buffer flushes
 * before the next active phase or at task end. If the buffer is empty
 * it does nothing.
 */
export function logSkippedPhases(phases: readonly PhaseId[]): void {
  if (phases.length === 0) return;
  const useColor = shouldUseColor();
  if (_firstPhaseEmitted && !_lastPhaseWasSkipped) {
    process.stdout.write('\n');
  }
  _firstPhaseEmitted = true;
  _lastPhaseWasSkipped = true;

  const list = phases.join(' · ');
  if (!useColor) {
    process.stdout.write(`  —  ${list}  skipped\n`);
    return;
  }
  const dash = tint('—', C.dimGray, useColor);
  const listCol = tint(list, C.dimGray, useColor);
  const skipped = tint('skipped', C.dimGray, useColor);
  process.stdout.write(`  ${dash}  ${listCol}  ${skipped}\n`);
}

/**
 * Emit a phase-scoped event line to stdout only (no events.jsonl, no
 * harness.log). Use for runner-level messages that belong under the
 * current phase header but don't go through a Logger instance — e.g.
 * control-flow notices like `--stop-after` halting.
 *
 * Routed through the same renderer as Logger levels so the look matches,
 * and indented two spaces to sit under the phase header's bracket.
 */
export function logPhaseEvent(
  level: 'info' | 'success' | 'warn' | 'error',
  phase: PhaseId | null,
  message: string,
): void {
  const useColor = shouldUseColor();
  const now = new Date();
  const msg = phase !== null ? `${phase}: ${relativize(message)}` : relativize(message);
  const line = renderTerminalLine(level, msg, shortTime(now), useColor, {
    project: '',
    task: '',
  });
  const indented = line.split('\n').map((l) => `  ${l}`).join('\n');
  process.stdout.write(`${indented}\n`);
}

export function logTaskEnd(
  status: RunStatus,
  durationMs: number,
  totalTokens: number,
  escalationPath?: string,
): void {
  const useColor = shouldUseColor();
  // Leading blank line ensures separation from the last phase's output
  // regardless of which code path led here.
  process.stdout.write(`\n${taskFooter(status, durationMs, totalTokens, useColor)}\n`);
  if (status === 'escalated' && escalationPath) {
    const indent = '    ';
    const arrow = `→ ${escalationPath}`;
    const line = useColor ? `${indent}${C.dimGray}${arrow}${C.reset}` : `${indent}${arrow}`;
    process.stdout.write(`${line}\n`);
  }
}

// ---------------------------------------------------------------------------
// `harness ship` UX — escalation + shipped summary blocks.
//
// These sit outside the normal per-phase logger flow. They render a
// single bordered block to stdout summarising the outcome of the whole
// `ship` invocation, so the user sees one decision-making surface
// instead of scrolling for the escalation text.
// ---------------------------------------------------------------------------

export interface EscalationBlockInput {
  readonly project: string;
  readonly task: string;
  readonly phase: string;
  readonly reason: string;
  readonly whatHappened: string;
  readonly escalationFile: string;
  /** Task id without the leading `N-` prefix — used in resume hints. */
  readonly taskNumber: string;
}

const SHIP_BANNER_WIDTH = 80;

/**
 * Render the "STOPPED — human decision required" block shown by
 * `harness ship` when a task escalates.
 */
export function logShipEscalation(input: EscalationBlockInput): void {
  const useColor = shouldUseColor();
  const headerLeft = '━━━ STOPPED — human decision required ';
  const fill = '━'.repeat(
    Math.max(3, SHIP_BANNER_WIDTH - headerLeft.length),
  );
  const header = useColor
    ? `${C.red}${C.bold}${headerLeft}${C.reset}${C.red}${fill}${C.reset}`
    : `${headerLeft}${fill}`;

  const lines: string[] = [];
  lines.push('', header, '');
  lines.push(row('Task:', `${input.project}/${input.task}`, useColor));
  lines.push(row('Phase:', input.phase, useColor));
  lines.push(row('Reason:', input.reason, useColor));
  lines.push('');
  lines.push(indent('What happened:'));
  const trimmed = trimLines(stripAnsi(input.whatHappened), 20);
  for (const line of trimmed) {
    lines.push(`    ${line}`);
  }
  lines.push('');
  lines.push(indent('Your options:'));
  lines.push('');
  lines.push(
    optionBlock(
      '[1]',
      'Fix it yourself, then resume',
      [
        'Edit the failing files, then:',
        `harness ship ${input.project} --resume`,
      ],
      useColor,
    ),
  );
  lines.push('');
  lines.push(
    optionBlock(
      '[2]',
      'Skip this task and continue with the rest',
      [`harness ship ${input.project} --resume --skip ${input.taskNumber}`],
      useColor,
    ),
  );
  lines.push('');
  lines.push(
    optionBlock(
      '[3]',
      'See exactly what the agent tried',
      [
        `harness debug ${input.project}/${input.task} --phase ${input.phase}`,
      ],
      useColor,
    ),
  );
  lines.push('');
  lines.push(
    optionBlock(
      '[4]',
      'Re-run from a specific phase after fixing',
      [
        `harness ship ${input.project}/${input.task} --resume --from ${input.phase}`,
      ],
      useColor,
    ),
  );
  lines.push('');
  lines.push(
    optionBlock(
      '[5]',
      'Or resume via project mode from this task and phase',
      [
        `harness ship ${input.project} --resume --from ${input.task}/${input.phase}`,
      ],
      useColor,
    ),
  );
  lines.push('');
  lines.push(indent('Full details:'));
  const arrow = `→ ${input.escalationFile}`;
  lines.push(`    ${tint(arrow, C.dimGray, useColor)}`);
  lines.push('');
  const footerFill = '━'.repeat(SHIP_BANNER_WIDTH);
  lines.push(tint(footerFill, C.red, useColor));
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

export interface ShippedTaskSummary {
  readonly name: string;
  readonly durationMs: number;
  readonly skippedByHuman?: boolean;
}

export interface ShippedBlockInput {
  readonly project: string;
  readonly totalMs: number;
  readonly tasks: readonly ShippedTaskSummary[];
  readonly branch: string;
  readonly prUrl: string | null;
  readonly prTitle: string | null;
  readonly totalTokens: number;
}

/**
 * Render the "shipped" summary block after a successful `harness ship`
 * invocation. Mirrors the task-footer look but adds PR URL + per-task
 * breakdown.
 */
export function logShipSuccess(input: ShippedBlockInput): void {
  const useColor = shouldUseColor();
  const left = '━━━ shipped ';
  const right = `  +${fmtDuration(input.totalMs)}`;
  const fill = '━'.repeat(
    Math.max(
      3,
      SHIP_BANNER_WIDTH - visibleWidth(left) - visibleWidth(right),
    ),
  );
  const header = useColor
    ? `${C.green}${C.bold}${left}${C.reset}${C.green}${fill}${C.reset}${C.dimWhite}${right}${C.reset}`
    : `${left}${fill}${right}`;
  process.stdout.write(`\n${header}\n\n`);

  const col = Math.max(10, ...input.tasks.map((t) => t.name.length));
  for (const t of input.tasks) {
    if (t.skippedByHuman) {
      const sym = tint('⊘', C.amber, useColor);
      const name = tint(t.name.padEnd(col), C.violet, useColor);
      const label = tint('skipped'.padEnd(10), C.amber, useColor);
      process.stdout.write(`  ${sym}  ${name}  ${label}  (human)\n`);
      continue;
    }
    const sym = tint('✓', C.green, useColor);
    const name = tint(t.name.padEnd(col), C.violet, useColor);
    const label = tint('complete'.padEnd(10), C.green, useColor);
    const dur = tint(fmtDuration(t.durationMs), C.dimWhite, useColor);
    process.stdout.write(`  ${sym}  ${name}  ${label}  ${dur}\n`);
  }

  if (input.prUrl) {
    // PR: and Branch: share an 8-char label column so the values line up.
    const prLabel = tint('PR:'.padEnd(8), C.blue, useColor);
    process.stdout.write(`\n  ${prLabel}${input.prUrl}\n`);
    if (input.prTitle) {
      process.stdout.write(
        `          ${tint(`"${input.prTitle}"`, C.dimWhite, useColor)}\n`,
      );
    }
  }

  process.stdout.write(
    `\n  ${tint('Branch:'.padEnd(8), C.dimGray, useColor)}${tint(input.branch, C.dimGray, useColor)}\n`,
  );
  const doneCount = input.tasks.filter((t) => !t.skippedByHuman).length;
  const skipCount = input.tasks.filter((t) => t.skippedByHuman).length;
  const counts = [
    `${doneCount} task${doneCount === 1 ? '' : 's'}`,
    skipCount > 0 ? `${skipCount} skipped` : null,
    fmtDuration(input.totalMs),
    `${fmtNumber(input.totalTokens)} tokens`,
  ]
    .filter(Boolean)
    .join(' · ');
  process.stdout.write(`  ${tint(counts, C.dimWhite, useColor)}\n\n`);
}

// Helpers scoped to the ship blocks.
function row(label: string, value: string, useColor: boolean): string {
  const padded = label.padEnd(8);
  return `  ${tint(padded, C.dimWhite, useColor)} ${tint(value, C.white, useColor)}`;
}

function indent(text: string): string {
  return `  ${text}`;
}

function optionBlock(
  tag: string,
  title: string,
  body: readonly string[],
  useColor: boolean,
): string {
  const tagColored = tint(tag, C.amber, useColor);
  const titleColored = tint(title, C.amber, useColor);
  const out = [`    ${tagColored} ${titleColored}`];
  for (const line of body) {
    out.push(`        ${tint(line, C.white, useColor)}`);
  }
  return out.join('\n');
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function trimLines(text: string, max: number): readonly string[] {
  const all = text.split(/\r?\n/);
  if (all.length <= max) return all;
  return [...all.slice(0, max), `(truncated — ${all.length - max} more lines)`];
}

/**
 * Count the total prompt + completion tokens across every agent_call
 * event in a run's events.jsonl. Used by runner.ts to feed logTaskEnd
 * with the task-level total. Missing file → 0.
 */
export function sumTaskTokens(eventsFile: string): number {
  if (!existsSync(eventsFile)) return 0;
  let raw: string;
  try {
    raw = readFileSync(eventsFile, 'utf8');
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type !== 'agent_call') continue;
      total += numeric(ev.promptTokensActual ?? ev.promptTokensEstimated);
      total += numeric(ev.completionTokens);
    } catch {
      // skip malformed lines
    }
  }
  return total;
}

function taskHeader(taskRef: string, ts: string, useColor: boolean): string {
  const left = `━━━ ${taskRef} `;
  const right = ` ${ts}`;
  const fillCount = Math.max(3, BANNER_WIDTH - visibleWidth(left) - visibleWidth(right));
  const fill = '━'.repeat(fillCount);
  if (!useColor) return `${left}${fill}${right}`;
  const brandText = `${C.violet}${C.bold}${left}${C.reset}`;
  const fillPart = `${C.violet}${fill}${C.reset}`;
  const tsPart = `${C.dimGray}${right}${C.reset}`;
  return `${brandText}${fillPart}${tsPart}`;
}

function taskFooter(
  status: RunStatus,
  durationMs: number,
  tokens: number,
  useColor: boolean,
): string {
  const durationText = `+${fmtDuration(durationMs)}`;
  const tokensText = `${fmtNumber(tokens)} tokens`;
  const left = `━━━ ${status} `;
  const right = `  ${durationText}  ${tokensText}`;
  const fillCount = Math.max(3, BANNER_WIDTH - visibleWidth(left) - visibleWidth(right));
  const fill = '━'.repeat(fillCount);
  if (!useColor) return `${left}${fill}${right}`;
  const color = statusColor(status);
  const brandRule =
    `${color}${C.bold}━━━ ${status}${C.reset} ${color}${fill}${C.reset}`;
  const durPart = `  ${C.dimWhite}${durationText}${C.reset}`;
  const tokPart = `  ${C.dimCyan}${tokensText}${C.reset}`;
  return `${brandRule}${durPart}${tokPart}`;
}

function statusColor(status: RunStatus): string {
  switch (status) {
    case 'complete':
      return C.green;
    case 'escalated':
    case 'failed':
      return C.red;
    case 'interrupted':
      return C.amber;
    case 'running':
    default:
      return C.amber;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function shouldUseColor(): boolean {
  // Per https://no-color.org: any non-empty NO_COLOR disables color.
  // An empty string is ignored so colors stay on.
  const noColor = process.env.NO_COLOR;
  if (typeof noColor === 'string' && noColor.length > 0) return false;
  return process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// Project-root relative path rewriting
//
// Rule: absolute paths for code, relative paths for humans. Absolute
// filesystem paths in log message strings (from `logger.info/warn/error/
// success`) get the project-root prefix stripped before they reach any
// human-facing surface — terminal, `harness.log`, and the `message`
// field of events.jsonl. Structured event fields (payload keys on
// `logger.event`) are left alone so machine consumers keep their
// absolute paths.
//
// The runner calls `initLogger(ctx.paths.repoRoot)` before any log line
// is written.
// ---------------------------------------------------------------------------

let _projectRoot: string = process.cwd();

export function initLogger(projectRoot: string): void {
  _projectRoot = projectRoot;
}

export function relativize(msg: string): string {
  if (!_projectRoot) return msg;
  // Strip both `<root>/` and bare `<root>` (exact-match references).
  return msg.split(`${_projectRoot}/`).join('').split(_projectRoot).join('.');
}

function tint(text: string, color: string, enabled: boolean): string {
  if (!enabled || color.length === 0) return text;
  return `${color}${text}${C.reset}`;
}

// Inline keyword / size / token coloring for generic log lines. Applied
// AFTER the phase-prefix strip in renderTerminalLine so each line reads
// as "what happened" with visual emphasis on outcomes. Safe to stack:
// keyword patterns target distinct words, and numeric patterns target
// distinct shapes, so substitutions never overlap.
function colorizeInline(msg: string, useColor: boolean): string {
  if (!useColor) return msg;
  return msg
    .replace(/\b(passed|complete|ok|written|done)\b/g, `${C.green}$1${C.reset}`)
    .replace(/\b(invoking|running|starting)\b/g, `${C.blue}$1${C.reset}`)
    .replace(/\b(skipped)\b/g, `${C.amber}$1${C.reset}`)
    .replace(/\b(failed|ESCALATION)\b/g, `${C.red}$1${C.reset}`)
    .replace(
      /\b(\d+(?:\.\d+)?\s?(?:KB|MB|GB|bytes))\b/gi,
      `${C.dimCyan}$1${C.reset}`,
    )
    .replace(/\b(\d[\d,]*\s+tokens)\b/g, `${C.dimCyan}$1${C.reset}`)
    .replace(/\((\d+)ms\)/g, `(${C.dimWhite}$1ms${C.reset})`);
}

function padEnd(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function termWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === 'number' && cols >= 40) return Math.min(cols, 100);
  return 80;
}

// Strip ANSI escape sequences to measure visible width.
function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function ensureParentDir(absFile: string): void {
  mkdirSync(dirname(absFile), { recursive: true });
}

function shortTime(d: Date | string): string {
  if (typeof d === 'string') {
    const match = /T(\d{2}:\d{2}:\d{2})/.exec(d);
    return match ? match[1]! : d;
  }
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function summarizeEvent(
  type: EventType,
  fields: Record<string, unknown>,
): string {
  const keys = Object.keys(fields);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const key of keys) {
    const value = fields[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      parts.push(`${key}=<object>`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
    if (parts.length >= 6) break;
  }
  return parts.join(' ');
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// CLI entry point — `npx tsx src/lib/logger.ts`
// ---------------------------------------------------------------------------

function runCli(): void {
  const tmp = mkdtempSync(join(tmpdir(), 'harness-logger-'));
  const eventsFile = join(tmp, 'events.jsonl');
  const logFile = join(tmp, 'harness.log');

  const logger = createLogger({
    runId: '20260418120000_abc123',
    project: 'tick',
    task: '1-types',
    eventsFile,
    logFile,
  });

  logTaskStart('tick', '1-types');

  logPhaseHeader('preflight');
  logger.info('starting');
  logger.info('created branch harness/tick/1-types-20260418023036-a87eaj');
  logPhaseComplete('preflight', 704);

  logPhaseHeader('design');
  logger.info('agent designer.agent: invoking (attempt 1, ~5610 tokens in)');
  logger.success('design-spec.md written (6,326 bytes)');
  logPhaseComplete('design', 53_120);

  logPhaseHeader('spec');
  logger.info('agent spec.agent: invoking (attempt 1, ~6967 tokens in)');
  logger.event('agent_call', {
    agent: 'spec.agent',
    promptTokensEstimated: 6967,
    completionTokens: 3120,
  });
  logger.success('manifest.json written  16 entries');
  logPhaseComplete('spec', 48_120);

  logSkippedPhases(['context', 'reconcile']);

  logPhaseHeader('hardGates');
  logger.info('running tsc');
  logger.success('tsc PASS (2082ms)');
  logger.info('running eslint');
  logger.success('eslint PASS (2120ms)');
  logPhaseComplete('hardGates', 4_215);

  logTaskEnd('complete', 272_000, 10_087);

  process.stdout.write(`\nlogger test dir: ${tmp}\n`);
}

if (import.meta.url.endsWith('/src/lib/logger.ts')) {
  runCli();
}
