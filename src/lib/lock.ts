// Per-task lockfile. Prevents two harness processes from running on the
// same <project>/<task> simultaneously. Atomic create (O_EXCL), detects
// stale locks via PID liveness check, and releases on explicit handle call.

import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { LockError, type LockFile } from '../types.js';

const LOCK_WRITE_FLAGS = 'wx'; // create exclusively; fail if exists
const MAX_ACQUIRE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LockHandle {
  readonly path: string;
  readonly pid: number;
  readonly runId: string;
  release(): void;
}

export interface AcquireLockResult {
  readonly handle: LockHandle;
  readonly staleCleared: { readonly pid: number; readonly runId: string } | null;
}

export interface AcquireLockOptions {
  readonly path: string;
  readonly runId: string;
}

export function acquireLock(opts: AcquireLockOptions): AcquireLockResult {
  mkdirSync(dirname(opts.path), { recursive: true });

  let staleCleared: { pid: number; runId: string } | null = null;

  for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const existing = readLockIfExists(opts.path);
    if (existing) {
      if (isPidAlive(existing.pid)) {
        throw new LockError(existing.pid, existing.runId);
      }
      staleCleared = { pid: existing.pid, runId: existing.runId };
      tryUnlink(opts.path);
    }

    const payload: LockFile = {
      pid: process.pid,
      runId: opts.runId,
      startedAt: new Date().toISOString(),
    };

    try {
      writeFileSync(opts.path, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        flag: LOCK_WRITE_FLAGS,
      });
    } catch (err) {
      if (isEexistError(err) && attempt < MAX_ACQUIRE_ATTEMPTS) {
        continue;
      }
      throw err;
    }

    return {
      handle: makeHandle(opts.path, process.pid, opts.runId),
      staleCleared,
    };
  }

  // Exhausted attempts — read once more and report whoever holds it.
  const final = readLockIfExists(opts.path);
  if (final) {
    throw new LockError(final.pid, final.runId);
  }
  throw new LockError(-1, '<unknown>');
}

export function readLockIfExists(path: string): LockFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isEnoentError(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed lockfile — treat as absent so the caller can recover.
    return null;
  }
  if (!isLockShape(parsed)) return null;
  return parsed;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // no such process
    if (code === 'EPERM') return true; // exists but we can't signal it
    return false;
  }
}

export function lockFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    if (isEnoentError(err)) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeHandle(path: string, pid: number, runId: string): LockHandle {
  let released = false;
  return {
    path,
    pid,
    runId,
    release(): void {
      if (released) return;
      released = true;
      const current = readLockIfExists(path);
      if (current && current.pid === pid && current.runId === runId) {
        tryUnlink(path);
      }
    },
  };
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (isEnoentError(err)) return;
    throw err;
  }
}

function isEnoentError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isEexistError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}

function isLockShape(value: unknown): value is LockFile {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    typeof v.runId === 'string' &&
    typeof v.startedAt === 'string'
  );
}

// ---------------------------------------------------------------------------
// CLI entry point — `npx tsx src/lib/lock.ts <acquire|hold|read|release> <path>`
//
// acquire: attempt acquire, exit 0 on success, 1 on LockError, 2 on other
// hold:    acquire then sleep until killed (used to simulate a live run)
// read:    print lock contents + liveness
// ---------------------------------------------------------------------------

async function runCli(): Promise<void> {
  const [, , command, path, runIdArg] = process.argv;
  if (!command || !path) {
    process.stderr.write(
      'usage: tsx src/lib/lock.ts <acquire|hold|read> <path> [runId]\n',
    );
    process.exit(64);
  }
  const runId = runIdArg ?? `cli_${process.pid.toString(36).padEnd(6, '0')}`;

  switch (command) {
    case 'acquire': {
      try {
        const res = acquireLock({ path, runId });
        if (res.staleCleared) {
          process.stdout.write(
            `cleared stale lock (pid ${res.staleCleared.pid})\n`,
          );
        }
        process.stdout.write(`acquired pid=${process.pid} runId=${runId}\n`);
        res.handle.release();
        process.stdout.write('released\n');
        process.exit(0);
      } catch (err) {
        if (err instanceof LockError) {
          process.stderr.write(
            `LOCKED pid=${err.existingPid} runId=${err.existingRunId}\n`,
          );
          process.exit(1);
        }
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
        process.exit(2);
      }
      break;
    }
    case 'hold': {
      try {
        const res = acquireLock({ path, runId });
        process.stdout.write(
          `acquired pid=${process.pid} runId=${runId} — holding, Ctrl+C to release\n`,
        );
        const release = (): void => {
          res.handle.release();
          process.exit(0);
        };
        process.on('SIGINT', release);
        process.on('SIGTERM', release);
        // Block forever until signalled.
        await new Promise<void>(() => {});
      } catch (err) {
        if (err instanceof LockError) {
          process.stderr.write(
            `LOCKED pid=${err.existingPid} runId=${err.existingRunId}\n`,
          );
          process.exit(1);
        }
        throw err;
      }
      break;
    }
    case 'read': {
      const existing = readLockIfExists(path);
      if (!existing) {
        process.stdout.write('no lockfile\n');
        process.exit(0);
      }
      const alive = isPidAlive(existing.pid);
      process.stdout.write(
        `pid=${existing.pid} runId=${existing.runId} startedAt=${existing.startedAt} alive=${alive}\n`,
      );
      process.exit(0);
      break;
    }
    default:
      process.stderr.write(`unknown command '${command}'\n`);
      process.exit(64);
  }
}

if (import.meta.url.endsWith('/src/lib/lock.ts')) {
  void runCli();
}
