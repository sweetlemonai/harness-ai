// Task-slug resolution.
//
// The CLI accepts three forms for a task reference:
//   tick                   → project mode (no slash). Returned as-is;
//                            commands/run.ts dispatches on the absence
//                            of a slash.
//   tick/1-types           → full name. Exists on disk → returned as-is.
//   tick/1                 → numeric shorthand. Expanded to the single
//                            `<n>-<name>.md` file under harness/tasks/tick/.
//
// Invalid or ambiguous lookups throw with an actionable message. Callers
// catch and print the error + exit 64 (usage error).

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHASE_IDS, type PhaseId } from '../types.js';
import { resolveHarnessPaths } from './paths.js';

/**
 * Resolve a CLI task reference to a canonical slug the commands can use.
 * Project-mode refs (no slash) pass through unchanged. Full-name refs
 * that match an existing file pass through unchanged. Numeric refs are
 * expanded to the single matching `<n>-*.md` file.
 */
export function resolveTaskRef(slug: string): string {
  if (!slug.includes('/')) {
    // Project mode — commands/run.ts handles this case.
    return slug;
  }

  const firstSlash = slug.indexOf('/');
  const project = slug.slice(0, firstSlash);
  const task = slug.slice(firstSlash + 1);
  if (!project || !task || task.includes('/')) {
    throw new Error(
      `Invalid task reference '${slug}'. Expected '<project>' or '<project>/<task>'.`,
    );
  }

  const paths = resolveHarnessPaths();
  const projectDir = resolve(paths.tasksDir, project);
  if (!existsSync(projectDir)) {
    throw new Error(
      `Project not found: ${project} — no directory at ${projectDir}`,
    );
  }

  // 1. Full name already on disk → pass through.
  const directPath = resolve(projectDir, `${task}.md`);
  if (existsSync(directPath)) {
    return `${project}/${task}`;
  }

  // 2. Not numeric → clear error, don't guess.
  if (!/^\d+$/.test(task)) {
    throw new Error(
      `Task not found: ${slug} — no file at ${directPath}`,
    );
  }

  // 3. Numeric → look for `<n>-*.md` in the project dir.
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch (err) {
    throw new Error(
      `Task not found: ${slug} — could not read ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const matches = entries.filter(
    (f) => f.endsWith('.md') && new RegExp(`^${task}-.+\\.md$`).test(f),
  );
  if (matches.length === 0) {
    throw new Error(
      `Task not found: ${slug} — no file matching ${task}-*.md in ${projectDir}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous task: ${slug} matches ${matches.join(', ')}`,
    );
  }
  const resolved = matches[0]!.replace(/\.md$/, '');
  return `${project}/${resolved}`;
}

// ---------------------------------------------------------------------------
// --from target parsing
// ---------------------------------------------------------------------------

/**
 * Tagged union returned by `parseFromTarget`. The caller (ship/run
 * command modules) enforces mode-specific validation — this parser has
 * no knowledge of which project the user is in, so it cannot verify
 * that a task slug exists on disk.
 */
export type FromTarget =
  | { readonly kind: 'phase'; readonly phase: PhaseId }
  | { readonly kind: 'task'; readonly task: string }
  | { readonly kind: 'task-phase'; readonly task: string; readonly phase: PhaseId };

/**
 * Parse a `--from` CLI value into a tagged union. Accepts:
 *   - `<phase>`        → { kind: 'phase' }
 *   - `<task>`         → { kind: 'task' } (existence validated later)
 *   - `<task>/<phase>` → { kind: 'task-phase' }
 *
 * Throws when the value is structurally invalid (empty halves, or a
 * phase part that isn't a known PhaseId). A plain bogus value with no
 * slash is returned as a task slug; the command module resolves it
 * against the filesystem.
 */
export function parseFromTarget(value: string): FromTarget {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `Invalid --from value ''. Expected '<phase>', '<task>', or '<task>/<phase>'.`,
    );
  }
  if (trimmed.includes('/')) {
    const firstSlash = trimmed.indexOf('/');
    const task = trimmed.slice(0, firstSlash);
    const phase = trimmed.slice(firstSlash + 1);
    if (!task || !phase || phase.includes('/')) {
      throw new Error(
        `Invalid --from value '${value}'. Expected '<phase>', '<task>', or '<task>/<phase>'.`,
      );
    }
    if (!(PHASE_IDS as readonly string[]).includes(phase)) {
      throw new Error(
        `Invalid phase '${phase}' in --from. Expected one of: ${PHASE_IDS.join(', ')}`,
      );
    }
    return { kind: 'task-phase', task, phase: phase as PhaseId };
  }
  if ((PHASE_IDS as readonly string[]).includes(trimmed)) {
    return { kind: 'phase', phase: trimmed as PhaseId };
  }
  return { kind: 'task', task: trimmed };
}

// ---------------------------------------------------------------------------
// Project-scoped task name resolution
// ---------------------------------------------------------------------------

export interface ProjectTaskResolution {
  readonly ok: true;
  readonly task: string;
}

export interface ProjectTaskResolutionError {
  readonly ok: false;
  readonly message: string;
}

/**
 * Resolve a task reference (numeric shorthand `2` or full name
 * `2-foo`) to its canonical task basename within a project. Returns a
 * typed result so callers can decide how to surface the error.
 */
export function resolveProjectTaskName(
  project: string,
  taskArg: string,
): ProjectTaskResolution | ProjectTaskResolutionError {
  const paths = resolveHarnessPaths();
  const projectDir = resolve(paths.tasksDir, project);
  if (!existsSync(projectDir)) {
    return { ok: false, message: `project not found: ${project}` };
  }
  let entries: string[];
  try {
    entries = readdirSync(projectDir).filter((n) => n.endsWith('.md'));
  } catch (err) {
    return {
      ok: false,
      message: `could not read ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const escaped = taskArg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = entries.filter((n) => {
    const base = n.replace(/\.md$/, '');
    return base === taskArg || new RegExp(`^${escaped}-`).test(base);
  });
  if (candidates.length === 0) {
    return { ok: false, message: `task not found in ${project}: ${taskArg}` };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      message: `ambiguous task '${taskArg}' in ${project}: ${candidates.join(', ')}`,
    };
  }
  return { ok: true, task: candidates[0]!.replace(/\.md$/, '') };
}
