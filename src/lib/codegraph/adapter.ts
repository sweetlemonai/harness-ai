import { realpathSync } from 'node:fs';
import { GitNexusCodeGraphAdapter } from './gitnexusAdapter.js';
import { FallbackSourceCodeGraphAdapter } from './fallbackSourceAdapter.js';
import { createScopeRef } from './receipts.js';
import type {
  CodeGraphAdapter,
  CodeGraphAdapterOptions,
  ScopeRef,
} from './types.js';

export type CodeGraphProviderSelection = 'auto' | 'gitnexus' | 'fallback';

export function createCodeGraphScope(options: {
  readonly repoRoot?: string;
  readonly project?: string;
  readonly task?: string;
  readonly tenantId?: string;
  readonly privacyZone?: string;
} = {}): ScopeRef {
  const repoRoot = realpathSync(options.repoRoot ?? process.cwd());
  return createScopeRef({
    repoRoot,
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.task !== undefined ? { task: options.task } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.privacyZone !== undefined ? { privacyZone: options.privacyZone } : {}),
  });
}

export function createCodeGraphAdapter(
  selection: CodeGraphProviderSelection = 'auto',
  options: CodeGraphAdapterOptions = {},
): CodeGraphAdapter {
  if (selection === 'fallback') {
    return new FallbackSourceCodeGraphAdapter(options);
  }
  return new GitNexusCodeGraphAdapter(options);
}

export async function createAvailableCodeGraphAdapter(
  selection: CodeGraphProviderSelection,
  scope: ScopeRef,
  options: CodeGraphAdapterOptions = {},
): Promise<CodeGraphAdapter> {
  if (selection === 'fallback') return new FallbackSourceCodeGraphAdapter(options);
  const gitnexus = new GitNexusCodeGraphAdapter(options);
  if (selection === 'gitnexus') return gitnexus;
  const probe = await gitnexus.probe(scope);
  if (probe.available) return gitnexus;
  return new FallbackSourceCodeGraphAdapter(options);
}

export {
  FallbackSourceCodeGraphAdapter,
  GitNexusCodeGraphAdapter,
};

export type * from './types.js';

