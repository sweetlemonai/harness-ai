// Run state and run-metadata read/write. Both files are versioned via
// schemaVersion. A mismatch is a hard error — the runner must not silently
// overwrite an older state with a newer schema. Writes are atomic
// (temp-file + rename) so a crash mid-write never corrupts the artifact.
//
// State is only written after a phase returns complete; this module does
// not enforce that — runner.ts does. Here we just round-trip bytes.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  PHASE_IDS,
  RUN_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  SchemaVersionError,
  type PhaseId,
  type RunFlags,
  type RunMetadata,
  type RunState,
  type RunStatus,
  type TaskRef,
} from '../types.js';

const VALID_STATUSES: readonly RunStatus[] = [
  'running',
  'complete',
  'escalated',
  'interrupted',
  'failed',
  'skipped-by-human',
];

const PHASE_SET = new Set<PhaseId>(PHASE_IDS);

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

export function readState(path: string): RunState {
  const parsed = readJsonFile(path, 'state.json');
  return parseState(parsed, path);
}

export function readStateIfExists(path: string): RunState | null {
  if (!fileExists(path)) return null;
  return readState(path);
}

export function writeState(path: string, state: RunState): void {
  assertStateShape(state, path);
  atomicWriteJson(path, state);
}

export function createInitialState(startedAt: string = new Date().toISOString()): RunState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: 'running',
    currentPhase: null,
    completedPhases: [],
    skippedPhases: [],
    startedAt,
    updatedAt: startedAt,
  };
}

export function markPhaseComplete(state: RunState, phase: PhaseId): RunState {
  if (!PHASE_SET.has(phase)) {
    throw new Error(`Unknown phase id '${phase}'`);
  }
  const completed = state.completedPhases.includes(phase)
    ? state.completedPhases
    : [...state.completedPhases, phase];
  return {
    ...state,
    currentPhase: phase,
    completedPhases: completed,
    updatedAt: new Date().toISOString(),
  };
}

export function markPhaseSkipped(state: RunState, phase: PhaseId): RunState {
  if (!PHASE_SET.has(phase)) {
    throw new Error(`Unknown phase id '${phase}'`);
  }
  const skipped = state.skippedPhases.includes(phase)
    ? state.skippedPhases
    : [...state.skippedPhases, phase];
  return {
    ...state,
    currentPhase: phase,
    skippedPhases: skipped,
    updatedAt: new Date().toISOString(),
  };
}

export function markStatus(state: RunState, status: RunStatus): RunState {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Unknown run status '${status}'`);
  }
  return {
    ...state,
    status,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------

export function readRunMeta(path: string): RunMetadata {
  const parsed = readJsonFile(path, 'run.json');
  return parseRunMeta(parsed, path);
}

export function writeRunMeta(path: string, meta: RunMetadata): void {
  assertRunMetaShape(meta, path);
  atomicWriteJson(path, meta);
}

export function createRunMeta(args: {
  runId: string;
  task: TaskRef;
  branch: string;
  flags: RunFlags;
  startedAt?: string;
}): RunMetadata {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: args.runId,
    project: args.task.project,
    task: args.task.task,
    branch: args.branch,
    startedAt: args.startedAt ?? new Date().toISOString(),
    flags: args.flags,
  };
}

// ---------------------------------------------------------------------------
// Parsing + validation
// ---------------------------------------------------------------------------

function parseState(value: unknown, path: string): RunState {
  if (value === null || typeof value !== 'object') {
    throw new SchemaVersionError(path, STATE_SCHEMA_VERSION, -1);
  }
  const v = value as Record<string, unknown>;

  const version = v.schemaVersion;
  if (typeof version !== 'number') {
    throw new SchemaVersionError(path, STATE_SCHEMA_VERSION, -1);
  }
  if (version !== STATE_SCHEMA_VERSION) {
    throw new SchemaVersionError(path, STATE_SCHEMA_VERSION, version);
  }

  const status = v.status;
  if (typeof status !== 'string' || !isRunStatus(status)) {
    throw new Error(`Invalid state.json at ${path}: status is not a valid RunStatus`);
  }

  const currentPhase =
    v.currentPhase === null || v.currentPhase === undefined
      ? null
      : (v.currentPhase as PhaseId);
  if (currentPhase !== null && !PHASE_SET.has(currentPhase)) {
    throw new Error(
      `Invalid state.json at ${path}: currentPhase '${String(currentPhase)}' is not a known PhaseId`,
    );
  }

  const completed = v.completedPhases;
  if (!Array.isArray(completed)) {
    throw new Error(`Invalid state.json at ${path}: completedPhases must be an array`);
  }
  const completedPhases: PhaseId[] = [];
  for (const entry of completed) {
    if (typeof entry !== 'string' || !PHASE_SET.has(entry as PhaseId)) {
      throw new Error(
        `Invalid state.json at ${path}: completedPhases contains non-phase '${String(entry)}'`,
      );
    }
    completedPhases.push(entry as PhaseId);
  }

  const skipped = v.skippedPhases;
  const skippedPhases: PhaseId[] = [];
  if (Array.isArray(skipped)) {
    for (const entry of skipped) {
      if (typeof entry !== 'string' || !PHASE_SET.has(entry as PhaseId)) {
        throw new Error(
          `Invalid state.json at ${path}: skippedPhases contains non-phase '${String(entry)}'`,
        );
      }
      skippedPhases.push(entry as PhaseId);
    }
  }

  const startedAt = v.startedAt;
  const updatedAt = v.updatedAt;
  if (typeof startedAt !== 'string' || typeof updatedAt !== 'string') {
    throw new Error(`Invalid state.json at ${path}: startedAt/updatedAt must be ISO strings`);
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    status,
    currentPhase,
    completedPhases,
    skippedPhases,
    startedAt,
    updatedAt,
  };
}

function parseRunMeta(value: unknown, path: string): RunMetadata {
  if (value === null || typeof value !== 'object') {
    throw new SchemaVersionError(path, RUN_SCHEMA_VERSION, -1);
  }
  const v = value as Record<string, unknown>;

  const version = v.schemaVersion;
  if (typeof version !== 'number') {
    throw new SchemaVersionError(path, RUN_SCHEMA_VERSION, -1);
  }
  if (version !== RUN_SCHEMA_VERSION) {
    throw new SchemaVersionError(path, RUN_SCHEMA_VERSION, version);
  }

  const mustString = (key: string): string => {
    const x = v[key];
    if (typeof x !== 'string') {
      throw new Error(`Invalid run.json at ${path}: '${key}' must be a string`);
    }
    return x;
  };

  const flagsRaw = v.flags;
  if (flagsRaw === null || typeof flagsRaw !== 'object') {
    throw new Error(`Invalid run.json at ${path}: 'flags' must be an object`);
  }
  const flags = parseRunFlags(flagsRaw as Record<string, unknown>, path);

  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: mustString('runId'),
    project: mustString('project'),
    task: mustString('task'),
    branch: mustString('branch'),
    startedAt: mustString('startedAt'),
    flags,
  };
}

function parseRunFlags(v: Record<string, unknown>, path: string): RunFlags {
  const boolField = (key: string, required: boolean): boolean => {
    const x = v[key];
    if (typeof x === 'boolean') return x;
    if (required) {
      throw new Error(`Invalid run.json at ${path}: flags.${key} must be a boolean`);
    }
    return false;
  };
  const patchParent = v.patchParent;
  let parent: TaskRef | null = null;
  if (patchParent !== null && patchParent !== undefined) {
    if (typeof patchParent !== 'object') {
      throw new Error(`Invalid run.json at ${path}: flags.patchParent must be null or object`);
    }
    const p = patchParent as Record<string, unknown>;
    if (typeof p.project !== 'string' || typeof p.task !== 'string') {
      throw new Error(
        `Invalid run.json at ${path}: flags.patchParent.project and .task must be strings`,
      );
    }
    parent = { project: p.project, task: p.task };
  }
  const optionalPhase = (key: string): PhaseId | undefined => {
    const x = v[key];
    if (x === undefined) return undefined;
    if (typeof x !== 'string' || !PHASE_SET.has(x as PhaseId)) {
      throw new Error(`Invalid run.json at ${path}: flags.${key} must be a known PhaseId`);
    }
    return x as PhaseId;
  };
  const stopAfter = optionalPhase('stopAfter');
  const resumeFrom = optionalPhase('resumeFrom');
  const dryRunRaw = v.dryRun;
  const dryRun = dryRunRaw === undefined ? undefined : Boolean(dryRunRaw);

  const flags: RunFlags = {
    resume: boolField('resume', true),
    patchParent: parent,
    nonInteractive: boolField('nonInteractive', true),
    ...(stopAfter !== undefined ? { stopAfter } : {}),
    ...(resumeFrom !== undefined ? { resumeFrom } : {}),
    ...(dryRun !== undefined ? { dryRun } : {}),
  };
  return flags;
}

function isRunStatus(s: string): s is RunStatus {
  return (VALID_STATUSES as readonly string[]).includes(s);
}

function assertStateShape(state: RunState, path: string): void {
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new SchemaVersionError(path, STATE_SCHEMA_VERSION, state.schemaVersion);
  }
  if (!isRunStatus(state.status)) {
    throw new Error(`writeState: invalid status '${state.status}'`);
  }
  if (state.currentPhase !== null && !PHASE_SET.has(state.currentPhase)) {
    throw new Error(`writeState: invalid currentPhase '${state.currentPhase}'`);
  }
  for (const p of state.completedPhases) {
    if (!PHASE_SET.has(p)) {
      throw new Error(`writeState: invalid completedPhases entry '${p}'`);
    }
  }
}

function assertRunMetaShape(meta: RunMetadata, path: string): void {
  if (meta.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw new SchemaVersionError(path, RUN_SCHEMA_VERSION, meta.schemaVersion);
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readJsonFile(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to read ${label} at ${path}: ${reason}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON in ${label} at ${path}: ${reason}`);
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'w', 0o644);
    writeSync(fd, payload, null, 'utf8');
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Leave the tmp on failure for post-mortem; surface the original error.
    tryUnlink(tmp);
    throw err;
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
  }
}

// Keep writeFileSync imported for potential future use without importing again.
void writeFileSync;

// ---------------------------------------------------------------------------
// CLI entry point — `npx tsx src/lib/state.ts <command> ...`
//
// Used by Day 1 validation: round-trip write/read matches, schema mismatch exits.
// ---------------------------------------------------------------------------

function runCli(): void {
  const [, , command, path] = process.argv;
  if (!command) {
    process.stderr.write(
      'usage: tsx src/lib/state.ts <roundtrip|read|write-initial|corrupt-version> [path]\n',
    );
    process.exit(64);
  }

  try {
    switch (command) {
      case 'roundtrip': {
        const tmp = path ?? `/tmp/harness-state-${process.pid}.json`;
        const original = createInitialState();
        const phase1 = markPhaseComplete(original, 'preflight');
        const phase2 = markStatus(phase1, 'running');
        writeState(tmp, phase2);
        const read = readState(tmp);
        const matches = JSON.stringify(read) === JSON.stringify(phase2);
        process.stdout.write(matches ? 'roundtrip OK\n' : 'roundtrip MISMATCH\n');
        process.stdout.write(`${JSON.stringify(read, null, 2)}\n`);
        tryUnlink(tmp);
        process.exit(matches ? 0 : 1);
        break;
      }
      case 'read': {
        if (!path) throw new Error('path required');
        const state = readState(path);
        process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
        process.exit(0);
        break;
      }
      case 'write-initial': {
        if (!path) throw new Error('path required');
        writeState(path, createInitialState());
        process.stdout.write(`wrote initial state to ${path}\n`);
        process.exit(0);
        break;
      }
      case 'corrupt-version': {
        const tmp = path ?? `/tmp/harness-state-bad-${process.pid}.json`;
        mkdirSync(dirname(tmp), { recursive: true });
        writeFileSync(
          tmp,
          JSON.stringify(
            {
              schemaVersion: 99,
              status: 'running',
              currentPhase: null,
              completedPhases: [],
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          'utf8',
        );
        try {
          readState(tmp);
          process.stderr.write('expected SchemaVersionError — none thrown\n');
          tryUnlink(tmp);
          process.exit(1);
        } catch (err) {
          if (err instanceof SchemaVersionError) {
            process.stdout.write(`got expected SchemaVersionError: ${err.message}\n`);
            tryUnlink(tmp);
            process.exit(0);
          }
          throw err;
        }
        break;
      }
      default:
        process.stderr.write(`unknown command '${command}'\n`);
        process.exit(64);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}

if (import.meta.url.endsWith('/src/lib/state.ts')) {
  runCli();
}
