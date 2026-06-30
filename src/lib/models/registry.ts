import type { RunContext } from '../../types.js';
import { createClaudeCliAdapter } from './adapters/claude-cli.js';
import { createFakeLocalAdapter } from './adapters/fake-local.js';
import { createOpenClawAgentAdapter } from './adapters/openclaw-agent.js';
import { createOpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelRegistryConfig,
} from './types.js';

const DEFAULT_ADAPTER_ID = 'claude-cli-v1';

const DEFAULT_REGISTRY_CONFIG: ModelRegistryConfig = {
  defaultAdapter: DEFAULT_ADAPTER_ID,
  adapters: [
    {
      id: DEFAULT_ADAPTER_ID,
      kind: 'claude-cli',
    },
  ],
};

export class ModelRegistry {
  private readonly adapters: ReadonlyMap<string, ModelAdapter>;
  private readonly defaultAdapterId: string;

  constructor(config: ModelRegistryConfig = DEFAULT_REGISTRY_CONFIG) {
    this.defaultAdapterId = config.defaultAdapter;
    this.adapters = new Map(
      config.adapters.map((adapterConfig) => [
        adapterConfig.id,
        createAdapter(adapterConfig),
      ]),
    );
  }

  get(id: string): ModelAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  defaultAdapter(): ModelAdapter {
    const adapter = this.get(this.defaultAdapterId);
    if (adapter !== null) return adapter;
    const fallback = this.get(DEFAULT_ADAPTER_ID);
    if (fallback !== null) return fallback;
    return createAdapter(DEFAULT_REGISTRY_CONFIG.adapters[0]!);
  }
}

export function modelRegistryForRun(ctx: RunContext): ModelRegistry {
  const models = (ctx.config as { readonly models?: ModelRegistryConfig }).models;
  if (!isModelRegistryConfig(models)) {
    return new ModelRegistry();
  }
  return new ModelRegistry(withDefaultClaudeAdapter(models));
}

function withDefaultClaudeAdapter(config: ModelRegistryConfig): ModelRegistryConfig {
  if (config.adapters.some((adapter) => adapter.id === DEFAULT_ADAPTER_ID)) {
    return config;
  }
  return {
    defaultAdapter: config.defaultAdapter,
    adapters: [
      ...config.adapters,
      DEFAULT_REGISTRY_CONFIG.adapters[0]!,
    ],
  };
}

function createAdapter(config: ModelAdapterConfig): ModelAdapter {
  switch (config.kind) {
    case 'claude-cli':
      return createClaudeCliAdapter(config);
    case 'fake-local':
      return createFakeLocalAdapter(config);
    case 'openclaw-agent':
      return createOpenClawAgentAdapter(config);
    case 'openai-compatible':
      return createOpenAiCompatibleAdapter(config);
    case 'external':
      return createUnavailableAdapter(config);
  }
}

function createUnavailableAdapter(config: ModelAdapterConfig): ModelAdapter {
  return {
    id: config.id,
    kind: config.kind,
    async invoke(): Promise<never> {
      throw new Error(`model adapter '${config.id}' uses unsupported kind '${config.kind}'`);
    },
  };
}

function isModelRegistryConfig(value: unknown): value is ModelRegistryConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    readonly defaultAdapter?: unknown;
    readonly adapters?: unknown;
  };
  return (
    typeof candidate.defaultAdapter === 'string' &&
    Array.isArray(candidate.adapters)
  );
}
