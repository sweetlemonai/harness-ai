import { spawnSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import type { HarnessConfig } from '../types.js';

export interface ModelsListCommandArgs {
  readonly json?: boolean;
}

export interface ModelsProbeCommandArgs {
  readonly target?: string;
  readonly timeoutMs?: number;
  readonly json?: boolean;
}

type AdapterConfig = HarnessConfig['models']['adapters'][number];

export async function modelsListCommand(
  args: ModelsListCommandArgs,
): Promise<number> {
  const config = loadConfig(resolveHarnessPaths());
  const payload = {
    defaultAdapter: config.models.defaultAdapter,
    adapters: config.models.adapters.map((adapter) => ({
      id: adapter.id,
      kind: adapter.kind,
      default: adapter.id === config.models.defaultAdapter,
      privacyZone: adapter.privacyZone ?? null,
      configured: adapterConfigured(adapter),
    })),
  };
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`default adapter: ${payload.defaultAdapter}\n`);
  for (const adapter of payload.adapters) {
    process.stdout.write(
      `${adapter.default ? '* ' : '  '}${adapter.id} (${adapter.kind}) configured=${adapter.configured}\n`,
    );
  }
  return 0;
}

export async function modelsProbeCommand(
  args: ModelsProbeCommandArgs,
): Promise<number> {
  const config = loadConfig(resolveHarnessPaths());
  const target = args.target ?? config.models.defaultAdapter;
  const adapter = config.models.adapters.find((entry) => entry.id === target)
    ?? config.models.adapters.find((entry) => entry.model === target)
    ?? null;
  if (adapter === null) {
    const payload = {
      target,
      ok: false,
      status: 'not_found',
      reason: `no configured adapter or model matches '${target}'`,
    };
    writeOutput(payload, args.json === true);
    return 1;
  }
  const result = await probeAdapter(adapter, args.timeoutMs ?? 5000);
  const payload = {
    target,
    adapterId: adapter.id,
    kind: adapter.kind,
    ...result,
  };
  writeOutput(payload, args.json === true);
  return result.ok ? 0 : 1;
}

function adapterConfigured(adapter: AdapterConfig): boolean {
  switch (adapter.kind) {
    case 'claude-cli':
    case 'openclaw-agent':
    case 'fake-local':
      return true;
    case 'openai-compatible':
      return resolveConfigValue(adapter.baseUrl, adapter.baseUrlEnv) !== null
        && resolveConfigValue(adapter.model, adapter.modelEnv) !== null;
    case 'external':
      return (adapter.command ?? '').trim().length > 0;
  }
}

async function probeAdapter(
  adapter: AdapterConfig,
  timeoutMs: number,
): Promise<{
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly details?: unknown;
}> {
  switch (adapter.kind) {
    case 'fake-local':
      return { ok: true, status: 'available', details: { mode: 'deterministic-local' } };
    case 'claude-cli':
    case 'openclaw-agent':
    case 'external':
      return probeCommand(adapter, timeoutMs);
    case 'openai-compatible':
      return probeOpenAiCompatible(adapter, timeoutMs);
  }
}

function probeCommand(
  adapter: AdapterConfig,
  timeoutMs: number,
): {
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly details?: unknown;
} {
  const command = adapter.command ?? (adapter.kind === 'claude-cli' ? 'claude' : '');
  if (command.trim().length === 0) {
    return { ok: false, status: 'unconfigured', reason: 'adapter command is not configured' };
  }
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error !== undefined) {
    return {
      ok: false,
      status: 'unavailable',
      reason: result.error.message,
    };
  }
  return {
    ok: result.status === 0,
    status: result.status === 0 ? 'available' : 'failed',
    ...(result.status === 0 ? {} : { reason: result.stderr.trim() || `exit ${result.status}` }),
    details: {
      command,
      exitCode: result.status,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    },
  };
}

async function probeOpenAiCompatible(
  adapter: AdapterConfig,
  timeoutMs: number,
): Promise<{
  readonly ok: boolean;
  readonly status: string;
  readonly reason?: string;
  readonly details?: unknown;
}> {
  const baseUrl = resolveConfigValue(adapter.baseUrl, adapter.baseUrlEnv);
  const model = resolveConfigValue(adapter.model, adapter.modelEnv);
  if (baseUrl === null || model === null) {
    return {
      ok: false,
      status: 'unconfigured',
      reason: 'openai-compatible adapter requires baseUrl/baseUrlEnv and model/modelEnv',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: headersFor(adapter),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: 'failed',
        reason: `HTTP ${response.status}`,
        details: { body: text.slice(0, 500) },
      };
    }
    const ids = modelIdsFromResponse(text);
    return {
      ok: ids.has(model),
      status: ids.has(model) ? 'available' : 'model_missing',
      ...(ids.has(model) ? {} : { reason: `model '${model}' was not advertised by /models` }),
      details: {
        baseUrl,
        model,
        advertisedModels: [...ids].sort(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'unavailable',
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function headersFor(adapter: AdapterConfig): Record<string, string> {
  const apiKey = resolveConfigValue(adapter.apiKey, adapter.apiKeyEnv);
  return apiKey === null ? {} : { authorization: `Bearer ${apiKey}` };
}

function modelIdsFromResponse(raw: string): Set<string> {
  const ids = new Set<string>();
  try {
    const parsed = JSON.parse(raw) as {
      readonly data?: readonly unknown[];
      readonly models?: readonly unknown[];
    };
    for (const record of [...(parsed.data ?? []), ...(parsed.models ?? [])]) {
      if (record === null || typeof record !== 'object') continue;
      const candidate = record as {
        readonly id?: unknown;
        readonly model?: unknown;
        readonly name?: unknown;
        readonly aliases?: readonly unknown[];
      };
      for (const value of [candidate.id, candidate.model, candidate.name]) {
        if (typeof value === 'string' && value.trim().length > 0) {
          ids.add(value);
        }
      }
      for (const alias of candidate.aliases ?? []) {
        if (typeof alias === 'string' && alias.trim().length > 0) {
          ids.add(alias);
        }
      }
    }
  } catch {
    // malformed provider output is handled as a model-missing probe
  }
  return ids;
}

function resolveConfigValue(value: string | undefined, envName: string | undefined): string | null {
  if (value !== undefined && value.trim().length > 0) return value;
  if (envName !== undefined && envName.trim().length > 0) {
    const envValue = process.env[envName];
    if (envValue !== undefined && envValue.trim().length > 0) return envValue;
  }
  return null;
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
