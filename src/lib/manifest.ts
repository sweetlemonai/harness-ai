// Manifest parsing + three-layer validation.
//
// The manifest is the harness's contract with every agent downstream. It
// declares exactly which files are in scope, what may happen to them, and
// what kind (impl/test/story) each one is. The three validation layers are
// called from three different phases and must stay independent:
//
//   Layer 1 — structural, runs immediately after spec writes manifest.json
//   Layer 2 — semantic, runs at the start of build
//   Layer 3 — post-build, after the coding/test agents finish
//
// None of the validators throw. Each returns a ManifestValidationResult so
// the calling phase chooses whether to escalate, prompt, or continue.

import { isAbsolute, posix } from 'node:path';
import {
  MANIFEST_ACTIONS,
  MANIFEST_KINDS,
  type ManifestAction,
  type ManifestEntry,
  type ManifestKind,
  type NoTouchViolation,
  type ParsedManifest,
} from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManifestValidationResult {
  readonly layer: 1 | 2 | 3;
  readonly valid: boolean;
  readonly violations: readonly string[];
}

export interface Layer2Context {
  readonly hasUI: boolean;
}

export interface PostBuildProbe {
  exists(path: string): boolean;
  isNonEmpty(path: string): boolean;
  /** true if the file has a tracked diff (vs HEAD or workspace snapshot). */
  hasAnyDiff(path: string): boolean;
  /** true if the file has any diff that is NOT purely `data-testid` additions. */
  hasLogicDiff(path: string): boolean;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse raw manifest.json bytes into a ParsedManifest. Throws on malformed
 * JSON — caller should catch and run Layer 1 with a synthesised violation.
 */
export function parseManifest(raw: string): ParsedManifest {
  const value = JSON.parse(raw) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest root must be a JSON object');
  }
  const entriesRaw = (value as Record<string, unknown>).manifest;
  if (!Array.isArray(entriesRaw)) {
    throw new Error("manifest JSON must have a 'manifest' array property");
  }
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < entriesRaw.length; i += 1) {
    const entry = entriesRaw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`manifest[${i}] must be an object`);
    }
    entries.push(coerceEntry(entry as Record<string, unknown>, i));
  }
  return { entries };
}

function coerceEntry(
  raw: Record<string, unknown>,
  idx: number,
): ManifestEntry {
  const path = raw.path;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`manifest[${idx}].path must be a non-empty string`);
  }
  const action = raw.action;
  if (typeof action !== 'string') {
    throw new Error(`manifest[${idx}].action must be a string`);
  }
  const kind = raw.kind;
  if (typeof kind !== 'string') {
    throw new Error(`manifest[${idx}].kind must be a string`);
  }
  const read = raw.read;
  if (read !== undefined && typeof read !== 'boolean') {
    throw new Error(`manifest[${idx}].read must be a boolean when present`);
  }
  const entry: ManifestEntry = {
    path,
    action: action as ManifestAction,
    kind: kind as ManifestKind,
    ...(read !== undefined ? { read } : {}),
  };
  return entry;
}

// ---------------------------------------------------------------------------
// Layer 1 — Structural
// ---------------------------------------------------------------------------

export function validateLayer1(
  manifest: ParsedManifest,
): ManifestValidationResult {
  const violations: string[] = [];
  const seenPaths = new Set<string>();

  for (let i = 0; i < manifest.entries.length; i += 1) {
    const entry = manifest.entries[i]!;
    const tag = `manifest[${i}] (${entry.path})`;

    if (!isValidRelativePath(entry.path)) {
      violations.push(
        `${tag}: path must be relative, POSIX-style, and must not contain '..' or start with '/'`,
      );
    }

    if (seenPaths.has(entry.path)) {
      violations.push(`${tag}: duplicate path`);
    } else {
      seenPaths.add(entry.path);
    }

    if (!isValidAction(entry.action)) {
      violations.push(
        `${tag}: action '${entry.action}' is not one of ${MANIFEST_ACTIONS.join('/')}`,
      );
    }

    if (!isValidKind(entry.kind)) {
      violations.push(
        `${tag}: kind '${entry.kind}' is not one of ${MANIFEST_KINDS.join('/')}`,
      );
    }

    if (entry.read === false && entry.action !== 'no-touch') {
      violations.push(
        `${tag}: 'read: false' is only meaningful with action: no-touch`,
      );
    }
  }

  return { layer: 1, valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Layer 2 — Semantic
// ---------------------------------------------------------------------------

export function validateLayer2(
  manifest: ParsedManifest,
  ctx: Layer2Context,
): ManifestValidationResult {
  const violations: string[] = [];

  if (manifest.entries.length === 0) {
    violations.push('manifest is empty — spec produced nothing to build');
    return { layer: 2, valid: false, violations };
  }

  const allNoTouch = manifest.entries.every((e) => e.action === 'no-touch');
  if (allNoTouch) {
    violations.push(
      'manifest contains only no-touch entries — nothing to build, nothing to test',
    );
  }

  if (ctx.hasUI) {
    const hasStory = manifest.entries.some((e) => e.kind === 'story');
    if (!hasStory) {
      violations.push(
        'UI task requires at least one kind: story entry in the manifest',
      );
    }
  }

  return { layer: 2, valid: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Layer 3 — Post-build
// ---------------------------------------------------------------------------

export function validateLayer3(
  manifest: ParsedManifest,
  probe: PostBuildProbe,
): ManifestValidationResult {
  const violations: string[] = [];

  for (const entry of manifest.entries) {
    if (entry.action === 'create') {
      if (!probe.exists(entry.path)) {
        violations.push(`create file missing after build: ${entry.path}`);
        continue;
      }
      if (!probe.isNonEmpty(entry.path)) {
        violations.push(`create file is empty after build: ${entry.path}`);
      }
    } else if (entry.action === 'modify') {
      if (!probe.exists(entry.path)) {
        violations.push(`modify target does not exist: ${entry.path}`);
        continue;
      }
      if (!probe.hasAnyDiff(entry.path)) {
        violations.push(
          `modify target has no diff after build: ${entry.path}`,
        );
      }
    } else if (entry.action === 'no-touch') {
      if (probe.hasLogicDiff(entry.path)) {
        violations.push(
          `no-touch file has logic changes: ${entry.path}`,
        );
      }
    }
  }

  return { layer: 3, valid: violations.length === 0, violations };
}

/**
 * Convenience: enumerate every no-touch file that received logic-level edits.
 * Used by phase_git to decide what to restore before staging.
 */
export function noTouchLogicViolations(
  manifest: ParsedManifest,
  probe: PostBuildProbe,
): NoTouchViolation[] {
  const out: NoTouchViolation[] = [];
  for (const entry of manifest.entries) {
    if (entry.action !== 'no-touch') continue;
    if (!probe.exists(entry.path)) continue;
    if (probe.hasLogicDiff(entry.path)) {
      out.push({
        path: entry.path,
        kind: 'logic',
        description: 'diff includes changes other than data-testid additions',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry queries
// ---------------------------------------------------------------------------

export function entriesByAction(
  manifest: ParsedManifest,
  action: ManifestAction,
): readonly ManifestEntry[] {
  return manifest.entries.filter((e) => e.action === action);
}

export function entriesByKind(
  manifest: ParsedManifest,
  kind: ManifestKind,
): readonly ManifestEntry[] {
  return manifest.entries.filter((e) => e.kind === kind);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidAction(value: string): value is ManifestAction {
  return (MANIFEST_ACTIONS as readonly string[]).includes(value);
}

function isValidKind(value: string): value is ManifestKind {
  return (MANIFEST_KINDS as readonly string[]).includes(value);
}

function isValidRelativePath(raw: string): boolean {
  if (raw.length === 0) return false;
  if (isAbsolute(raw)) return false;
  if (raw.startsWith('/')) return false;
  if (raw.includes('\\')) return false;
  const normalized = posix.normalize(raw);
  if (normalized.startsWith('..')) return false;
  if (normalized.split('/').some((seg) => seg === '..')) return false;
  return true;
}
