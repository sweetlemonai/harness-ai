// Workspace snapshots.
//
// Before every write-capable phase (build / hardGates / qa / e2e) the
// runner tars exactly three directories into runs/<id>/snapshots/
// before-<phase>.tar, along with a .sha256 sidecar. On retry the caller
// restores by extracting the tar back over the repo root.
//
// Snapshot scope — exact, not "everything":
//   1. <repoRoot>/src
//   2. <harnessRoot>/e2e/<project>/<task>
//   3. <harnessRoot>/workspace/<project>/<task>
//
// Checksum is SHA-256 of the tar contents. On restore the tar is re-hashed
// and compared to the sidecar; mismatch falls back to the most recent
// earlier snapshot in the same snapshots/ dir that still verifies.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import {
  PHASE_IDS,
  type HarnessPaths,
  type PhaseId,
  type RunPaths,
  type TaskPaths,
} from '../types.js';
import { snapshotFileFor } from './paths.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SnapshotTargets {
  readonly paths: HarnessPaths;
  readonly taskPaths: TaskPaths;
  readonly runPaths: RunPaths;
}

export interface SnapshotHandle {
  readonly path: string;
  readonly sidecarPath: string;
  readonly checksum: string;
  readonly phase: string;
  readonly sizeBytes: number;
}

export function takeSnapshot(
  targets: SnapshotTargets,
  phase: PhaseId | string,
): SnapshotHandle {
  mkdirSync(targets.runPaths.snapshotsDir, { recursive: true });
  const tarPath = snapshotFileFor(targets.runPaths, String(phase));
  const sidecarPath = `${tarPath}.sha256`;

  // Ensure all scoped dirs exist before tar — tar errors on missing paths.
  const rels = scopedTargetsRelative(targets);
  for (const rel of rels) {
    const abs = resolve(targets.paths.repoRoot, rel);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }

  const args = [
    '-cf',
    tarPath,
    '-C',
    targets.paths.repoRoot,
    ...rels,
  ];
  const res = spawnSync('tar', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(
      `tar create failed (status ${res.status}): ${res.stderr.trim()}`,
    );
  }

  const buf = readFileSync(tarPath);
  const checksum = sha256(buf);
  const sizeBytes = buf.length;
  writeFileSync(sidecarPath, `${checksum}\n`, 'utf8');

  return {
    path: tarPath,
    sidecarPath,
    checksum,
    phase: String(phase),
    sizeBytes,
  };
}

export function restoreSnapshot(
  handle: SnapshotHandle,
  targets: SnapshotTargets,
): void {
  if (!verifyChecksum(handle)) {
    throw new Error(
      `snapshot checksum mismatch at ${handle.path}; use fallbackRestore() or investigate`,
    );
  }
  const res = spawnSync(
    'tar',
    ['-xf', handle.path, '-C', targets.paths.repoRoot],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(
      `tar extract failed (status ${res.status}): ${res.stderr.trim()}`,
    );
  }
}

/**
 * Find a snapshot whose phase is the given `phase`. Returns null if none
 * exists or the one that exists fails checksum verification (caller can
 * then use `fallbackBefore` to step back).
 */
export function loadSnapshot(
  runPaths: RunPaths,
  phase: PhaseId | string,
): SnapshotHandle | null {
  const tarPath = snapshotFileFor(runPaths, String(phase));
  if (!existsSync(tarPath)) return null;
  const sidecarPath = `${tarPath}.sha256`;
  const expected = readSidecarChecksum(sidecarPath);
  if (!expected) return null;
  const sizeBytes = statSync(tarPath).size;
  const handle: SnapshotHandle = {
    path: tarPath,
    sidecarPath,
    checksum: expected,
    phase: String(phase),
    sizeBytes,
  };
  if (!verifyChecksum(handle)) return null;
  return handle;
}

/**
 * Most recent valid snapshot whose phase precedes `phase` in PHASE_IDS.
 * Used when the expected snapshot for `phase` is missing or corrupted.
 */
export function fallbackBefore(
  runPaths: RunPaths,
  phase: PhaseId,
): SnapshotHandle | null {
  if (!existsSync(runPaths.snapshotsDir)) return null;
  const cutoff = PHASE_IDS.indexOf(phase);
  if (cutoff === -1) return null;
  const entries = readdirSync(runPaths.snapshotsDir)
    .filter((n) => n.startsWith('before-') && n.endsWith('.tar'))
    .map((n) => ({
      name: n,
      phase: n.slice('before-'.length, -'.tar'.length),
    }));

  // Candidates strictly before the requested phase, ordered by pipeline index.
  const candidates = entries
    .map((e) => ({
      name: e.name,
      phase: e.phase,
      index: PHASE_IDS.indexOf(e.phase as PhaseId),
    }))
    .filter((e) => e.index !== -1 && e.index < cutoff)
    .sort((a, b) => b.index - a.index);

  for (const c of candidates) {
    const handle = loadSnapshot(runPaths, c.phase);
    if (handle) return handle;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scopedTargetsRelative(targets: SnapshotTargets): string[] {
  // Use RunPaths/TaskPaths/HarnessPaths rather than rebuilding anything.
  const { paths, taskPaths } = targets;
  return [
    relative(paths.repoRoot, paths.srcDir),
    relative(paths.repoRoot, taskPaths.e2eDir),
    relative(paths.repoRoot, taskPaths.workspaceDir),
  ];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function verifyChecksum(handle: SnapshotHandle): boolean {
  try {
    const raw = readFileSync(handle.path);
    return sha256(raw) === handle.checksum;
  } catch {
    return false;
  }
}

function readSidecarChecksum(sidecarPath: string): string | null {
  try {
    const raw = readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
    if (!raw || raw.length !== 64) return null;
    return raw;
  } catch {
    return null;
  }
}

// Re-export for symmetry with the rest of lib/: lets callers render a
// snapshot handle's filename without reaching into node:path.
export function snapshotName(handle: SnapshotHandle): string {
  return basename(handle.path);
}
