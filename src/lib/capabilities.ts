// Derive TaskCapabilities from a parsed manifest + workspace design files.
// Capabilities drive phase-skip logic in pipeline/phases/*.ts (hasUI →
// design / soft gates / storybook; hasTests → reconcile / vitest;
// isE2ETask → skip build; hasDesign → design phase; etc.).
//
// Empty manifest is explicitly NOT an E2E task. That case is a Layer 2
// manifest error — inferring it as E2E here would mask the real problem
// and cause the runner to skip build silently.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type ManifestEntry,
  type ParsedManifest,
  type TaskCapabilities,
  type TaskFrontmatter,
} from '../types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function inferCapabilities(
  manifest: ParsedManifest,
  hasDesignFiles: boolean,
  frontmatter?: TaskFrontmatter,
): TaskCapabilities {
  const entries = manifest.entries;
  // Design phase is only meaningful for visual tasks. `type: logic` and
  // `type: data` tasks ignore design inputs even when a stray design.png
  // sits in the project folder — otherwise they'd run the design phase
  // for no reason.
  const designEligible =
    !frontmatter ||
    frontmatter.type === 'ui' ||
    frontmatter.type === 'e2e';
  const hasDesign = designEligible && hasDesignFiles;

  if (entries.length === 0) {
    // Empty manifest: treat everything as false. Layer 2 will reject the
    // manifest itself — callers shouldn't be asking this question.
    return {
      hasUI: false,
      hasTests: false,
      hasStories: false,
      hasDesign,
      isE2ETask: false,
    };
  }

  let hasUI = entries.some(isUiImplEntry);
  const hasTests = entries.some((e) => e.kind === 'test');
  const hasStories = entries.some((e) => e.kind === 'story');
  let isE2ETask = entries.every(isTestOrStoryEntry);

  // Frontmatter override.
  //
  // The frontmatter `type` is the human's authoritative declaration of
  // what kind of task this is. If the human said `type: logic` or
  // `type: data`, we force-disable the UI-flagged capabilities even
  // when the spec agent overreached and added .tsx impl entries. This
  // keeps pure-logic tasks from triggering the qa + e2e + softGates
  // phases they don't need. Likewise `type: e2e` forces isE2ETask even
  // if a careless spec agent slipped in a non-test entry.
  if (frontmatter) {
    if (frontmatter.type === 'logic' || frontmatter.type === 'data') {
      hasUI = false;
      isE2ETask = false;
    } else if (frontmatter.type === 'e2e') {
      isE2ETask = true;
    }
  }

  return {
    hasUI,
    hasTests,
    hasStories,
    hasDesign,
    isE2ETask,
  };
}

export interface FrontmatterCheckResult {
  readonly matches: boolean;
  readonly mismatches: readonly string[];
}

/**
 * Cross-check inferred capabilities against the task frontmatter. Never
 * throws — the caller decides whether to warn+continue (non-interactive)
 * or warn+prompt (interactive).
 */
export function checkAgainstFrontmatter(
  caps: TaskCapabilities,
  frontmatter: TaskFrontmatter,
): FrontmatterCheckResult {
  const mismatches: string[] = [];

  switch (frontmatter.type) {
    case 'ui':
      if (!caps.hasUI) {
        mismatches.push(
          "frontmatter type: ui, but manifest has no kind: impl with .tsx/.jsx extension",
        );
      }
      break;
    case 'logic':
      if (caps.hasUI) {
        mismatches.push(
          'frontmatter type: logic, but manifest has UI (kind: impl with .tsx/.jsx) entries',
        );
      }
      break;
    case 'e2e':
      if (!caps.isE2ETask) {
        mismatches.push(
          'frontmatter type: e2e, but manifest contains entries other than kind: test / kind: story',
        );
      }
      break;
    case 'data':
      if (caps.hasUI) {
        mismatches.push(
          'frontmatter type: data, but manifest has UI (kind: impl with .tsx/.jsx) entries',
        );
      }
      break;
  }

  if (frontmatter.hasDesign !== caps.hasDesign) {
    mismatches.push(
      `frontmatter hasDesign=${frontmatter.hasDesign} but design files ${caps.hasDesign ? 'found' : 'absent'} in workspace`,
    );
  }

  return { matches: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

/**
 * Does the task have design inputs (design.png or design-system.md)
 * resolvable from either location? Task-workspace files take precedence
 * over project-level files but either is sufficient. Result feeds
 * `hasDesign` in TaskCapabilities.
 *
 * - `workspaceDir` = `harness/workspace/<project>/<task>/`
 *   (task-specific override — created if a spec wants its own design)
 * - `taskDir`      = `harness/tasks/<project>/`
 *   (project-level fallback shared across tasks in the same project)
 */
export function hasDesignInputs(workspaceDir: string, taskDir: string): boolean {
  const inWorkspace =
    existsSync(resolve(workspaceDir, 'design.png')) ||
    existsSync(resolve(workspaceDir, 'design-system.md'));
  const inTaskDir =
    existsSync(resolve(taskDir, 'design.png')) ||
    existsSync(resolve(taskDir, 'design-system.md'));
  return inWorkspace || inTaskDir;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isUiImplEntry(entry: ManifestEntry): boolean {
  if (entry.kind !== 'impl') return false;
  return entry.path.endsWith('.tsx') || entry.path.endsWith('.jsx');
}

function isTestOrStoryEntry(entry: ManifestEntry): boolean {
  return entry.kind === 'test' || entry.kind === 'story';
}
