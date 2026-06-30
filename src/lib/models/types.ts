import type { PhaseId, PrivacyZone, RunContext } from '../../types.js';

export type ModelAdapterKind =
  | 'claude-cli'
  | 'fake-local'
  | 'openclaw-agent'
  | 'openai-compatible'
  | 'external';

export interface ModelAdapterConfig {
  readonly id: string;
  readonly kind: ModelAdapterKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly agentId?: string;
  readonly baseUrl?: string;
  readonly baseUrlEnv?: string;
  readonly model?: string;
  readonly modelEnv?: string;
  readonly maxTokens?: number;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly privacyZone?: PrivacyZone;
}

export interface ModelRegistryConfig {
  readonly defaultAdapter: string;
  readonly adapters: readonly ModelAdapterConfig[];
}

export interface ModelInvocationArgs {
  readonly ctx: RunContext;
  /** Human-readable agent identifier (e.g. "spec.agent", "coding.agent"). */
  readonly agent: string;
  /** Phase name - used for prompts/<phase>-attempt-<n>.txt. */
  readonly phase: PhaseId | string;
  /** 1-indexed attempt number within the phase. */
  readonly attempt: number;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface ModelInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly estimatedTokens: number;
  readonly reportedTokens: number | null;
  readonly contract: unknown | null;
  readonly promptPath: string;
}

export interface RawModelInvocationArgs {
  readonly ctx: RunContext;
  readonly agent: string;
  readonly phase: PhaseId | string;
  readonly attempt: number;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly promptPath: string;
  readonly estimatedTokens: number;
}

export interface RawModelInvocationResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timedOut?: boolean;
}

export interface ModelAdapter {
  readonly id: string;
  readonly kind: ModelAdapterKind;
  invoke(args: RawModelInvocationArgs): Promise<RawModelInvocationResult>;
}
