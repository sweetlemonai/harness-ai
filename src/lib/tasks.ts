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
