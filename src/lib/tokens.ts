// Token estimation + budget enforcement for context bundles.
//
// The only models we have access to are Claude's API costs, so token
// estimates are rough — ~4 chars per token. That's close enough to make
// budget decisions; the authoritative count comes back from the agent's
// JSON contract block when present, and is logged alongside the estimate.
//
// When a bundle must be trimmed to fit, sections are dropped in reverse
// priority order (lowest priority first). If a single section is partially
// kept, it is truncated at the last word boundary before the byte limit,
// never mid-character and never mid-JSON. Each drop is reported via the
// caller's logger.

import type { Logger } from '../types.js';

// Rough token estimator. Good enough for budget decisions; not for billing.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Word-boundary truncation
// ---------------------------------------------------------------------------

export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly droppedBytes: number;
}

/**
 * Trim `text` so it is at most `maxChars` bytes long. The cut is made at
 * the last whitespace boundary (space, tab, newline) at or before the
 * limit so no word is sliced in half. Never cuts in the middle of a UTF-8
 * sequence (the input is assumed to be a JS string, which is UTF-16 —
 * Buffer.byteLength is not the right metric; we operate on string length).
 */
export function truncateAtWordBoundary(
  text: string,
  maxChars: number,
): TruncationResult {
  if (maxChars < 0) {
    throw new Error('truncateAtWordBoundary: maxChars must be >= 0');
  }
  if (text.length <= maxChars) {
    return { text, truncated: false, droppedBytes: 0 };
  }
  if (maxChars === 0) {
    return { text: '', truncated: true, droppedBytes: text.length };
  }

  const slice = text.slice(0, maxChars);
  const boundary = lastWhitespaceIndex(slice);
  const cut = boundary > 0 ? boundary : slice.length;
  const out = text.slice(0, cut).replace(/[\s]+$/, '');
  const droppedBytes = text.length - out.length;
  return { text: out, truncated: true, droppedBytes };
}

function lastWhitespaceIndex(s: string): number {
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const ch = s.charCodeAt(i);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Section budget
// ---------------------------------------------------------------------------

export interface ContextSection {
  /** Human-readable name logged on drop (e.g. "manifest-file:src/App.tsx"). */
  readonly name: string;
  /** Higher priority = retained longer. Dropped in ascending order. */
  readonly priority: number;
  readonly content: string;
}

export type DropReason = 'fully-dropped' | 'truncated';

export interface DroppedSection {
  readonly name: string;
  readonly sizeBytes: number;
  readonly reason: DropReason;
}

export interface BudgetResult {
  readonly included: readonly ContextSection[];
  readonly dropped: readonly DroppedSection[];
  readonly finalTokens: number;
}

/**
 * Fit `sections` under `maxTokens`. Strategy:
 *   1. Sort by priority descending. Try to include each in order.
 *   2. If a section fits, include it whole.
 *   3. If it doesn't fit and there is *some* room left, truncate its
 *      content at a word boundary.
 *   4. If truncated content wouldn't contain anything useful, drop it.
 *   5. Continue through the list; each drop/truncate is reported.
 *
 * `logger` is optional so tests can call this without a RunContext.
 */
export function enforceBudget(
  sections: readonly ContextSection[],
  maxTokens: number,
  logger?: Logger,
): BudgetResult {
  const sorted = [...sections].sort((a, b) => b.priority - a.priority);
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const included: ContextSection[] = [];
  const dropped: DroppedSection[] = [];
  let usedChars = 0;

  for (const section of sorted) {
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      dropped.push({
        name: section.name,
        sizeBytes: section.content.length,
        reason: 'fully-dropped',
      });
      logger?.event('token_cap_applied', {
        section: section.name,
        sizeBytes: section.content.length,
        reason: 'fully-dropped',
      });
      continue;
    }
    if (section.content.length <= remaining) {
      included.push(section);
      usedChars += section.content.length;
      continue;
    }
    // Partial fit — truncate at word boundary.
    const trunc = truncateAtWordBoundary(section.content, remaining);
    if (trunc.text.length < 64) {
      // Keeping fewer than ~64 chars is noise, not context. Drop.
      dropped.push({
        name: section.name,
        sizeBytes: section.content.length,
        reason: 'fully-dropped',
      });
      logger?.event('token_cap_applied', {
        section: section.name,
        sizeBytes: section.content.length,
        reason: 'fully-dropped',
      });
      continue;
    }
    included.push({ ...section, content: trunc.text });
    usedChars += trunc.text.length;
    dropped.push({
      name: section.name,
      sizeBytes: trunc.droppedBytes,
      reason: 'truncated',
    });
    logger?.event('token_cap_applied', {
      section: section.name,
      sizeBytes: trunc.droppedBytes,
      reason: 'truncated',
    });
  }

  const finalTokens = Math.ceil(usedChars / CHARS_PER_TOKEN);
  return { included, dropped, finalTokens };
}

// ---------------------------------------------------------------------------
// Priority constants — shared vocabulary for context.ts and retry.ts
// ---------------------------------------------------------------------------

export const PRIORITY = {
  manifestFile: 1000,
  siblingFile: 500,
  coreLibraryDoc: 300,
  standards: 100,
  versionManifest: 50,
} as const;
