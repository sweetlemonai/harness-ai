import { spawnSync } from 'node:child_process';
import type { HarnessConfig } from '../../types.js';
import { sha256Hex, stableStringify } from '../protocol/hash.js';
import type {
  ZkFailurePolicy,
  ZkFailureState,
  ZkSnarkDescriptor,
} from '../protocol/types.js';

export interface ExternalZkProverConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly circuitId?: string;
  readonly circuitVersion?: string;
  readonly verifierRef?: string;
  readonly setupHash?: string;
  readonly maxLatencyMs: number;
  readonly failurePolicy: ZkFailurePolicy;
}

export interface ExternalZkProveInput {
  readonly statement: string;
  readonly publicInputs: unknown;
  readonly config: ExternalZkProverConfig;
  readonly now?: Date;
}

export function externalZkConfigFromHarness(
  config: HarnessConfig['proofs']['zkSnarks'],
): ExternalZkProverConfig {
  if (config.command === undefined || config.command.trim() === '') {
    throw new Error('external ZK proving requires proofs.zkSnarks.command');
  }
  if (config.timeoutMs === undefined || !Number.isFinite(config.timeoutMs) || config.timeoutMs < 100) {
    throw new Error('external ZK proving requires proofs.zkSnarks.timeoutMs >= 100');
  }
  if (config.maxOutputBytes === undefined || !Number.isFinite(config.maxOutputBytes) || config.maxOutputBytes < 1024) {
    throw new Error('external ZK proving requires proofs.zkSnarks.maxOutputBytes >= 1024');
  }
  if (config.maxLatencyMs === undefined || !Number.isFinite(config.maxLatencyMs) || config.maxLatencyMs < 1) {
    throw new Error('external ZK proving requires proofs.zkSnarks.maxLatencyMs >= 1');
  }
  if (!isFailurePolicy(config.failurePolicy)) {
    throw new Error('external ZK proving requires proofs.zkSnarks.failurePolicy');
  }
  return {
    command: config.command,
    ...(config.args !== undefined ? { args: config.args } : {}),
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    ...(config.circuitId !== undefined ? { circuitId: config.circuitId } : {}),
    ...(config.circuitVersion !== undefined ? { circuitVersion: config.circuitVersion } : {}),
    ...(config.verifierRef !== undefined ? { verifierRef: config.verifierRef } : {}),
    ...(config.setupHash !== undefined ? { setupHash: config.setupHash } : {}),
    maxLatencyMs: config.maxLatencyMs,
    failurePolicy: config.failurePolicy,
  };
}

export function createExternalZkDescriptor(input: ExternalZkProveInput): ZkSnarkDescriptor {
  const publicInputsHash = sha256Hex(stableStringify(input.publicInputs));
  const startedAt = Date.now();
  const request = {
    schemaVersion: 'superharness.external_zk_request.v2',
    statement: input.statement,
    publicInputs: input.publicInputs,
    publicInputsHash,
    circuitId: input.config.circuitId ?? null,
    circuitVersion: input.config.circuitVersion ?? null,
    verifierRef: input.config.verifierRef ?? null,
    setupHash: input.config.setupHash ?? null,
    maxLatencyMs: input.config.maxLatencyMs,
    failurePolicy: input.config.failurePolicy,
  };
  const child = spawnSync(input.config.command, input.config.args ?? [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: input.config.timeoutMs,
    maxBuffer: input.config.maxOutputBytes,
  });
  const latencyMs = Date.now() - startedAt;
  if (child.error !== undefined) {
    return failedDescriptor(input, publicInputsHash, latencyMs, child.error.message);
  }
  if (child.status !== 0) {
    return failedDescriptor(input, publicInputsHash, latencyMs, `external ZK prover exited ${child.status}: ${child.stderr.trim()}`);
  }
  let parsed: ZkSnarkDescriptor;
  try {
    parsed = JSON.parse(child.stdout) as ZkSnarkDescriptor;
  } catch (error) {
    return failedDescriptor(input, publicInputsHash, latencyMs, error instanceof Error ? error.message : String(error));
  }
  if (parsed.status === 'proved' && parsed.publicInputsHash !== publicInputsHash) {
    return failedDescriptor(input, publicInputsHash, latencyMs, 'external ZK prover returned a publicInputsHash mismatch');
  }
  if (parsed.status === 'proved') {
    return {
      ...parsed,
      mode: 'external_snark',
      backend: 'external',
      publicInputsHash,
      ...(input.config.circuitId !== undefined ? { circuitId: parsed.circuitId ?? input.config.circuitId } : {}),
      ...(input.config.circuitVersion !== undefined ? { circuitVersion: parsed.circuitVersion ?? input.config.circuitVersion } : {}),
      ...(input.config.verifierRef !== undefined ? { verifierRef: parsed.verifierRef ?? input.config.verifierRef } : {}),
      ...(input.config.setupHash !== undefined ? { setupHash: parsed.setupHash ?? input.config.setupHash } : {}),
      latencyMs: parsed.latencyMs ?? latencyMs,
      maxLatencyMs: parsed.maxLatencyMs ?? input.config.maxLatencyMs,
      failurePolicy: parsed.failurePolicy ?? input.config.failurePolicy,
      failureState: parsed.failureState ?? 'none',
    };
  }
  return {
    ...parsed,
    mode: 'external_snark',
    backend: 'external',
    publicInputsHash: parsed.publicInputsHash ?? publicInputsHash,
    latencyMs: parsed.latencyMs ?? latencyMs,
    maxLatencyMs: parsed.maxLatencyMs ?? input.config.maxLatencyMs,
    failurePolicy: parsed.failurePolicy ?? input.config.failurePolicy,
    failureState: parsed.failureState ?? failureStateForPolicy(input.config.failurePolicy),
    reason: parsed.reason ?? 'external ZK prover did not return a proved descriptor',
  };
}

function failedDescriptor(
  input: ExternalZkProveInput,
  publicInputsHash: string,
  latencyMs: number,
  reason: string,
): ZkSnarkDescriptor {
  return {
    status: 'failed',
    mode: 'external_snark',
    backend: 'external',
    ...(input.config.circuitId !== undefined ? { circuitId: input.config.circuitId } : {}),
    ...(input.config.circuitVersion !== undefined ? { circuitVersion: input.config.circuitVersion } : {}),
    publicInputsHash,
    ...(input.config.verifierRef !== undefined ? { verifierRef: input.config.verifierRef } : {}),
    latencyMs,
    maxLatencyMs: input.config.maxLatencyMs,
    ...(input.config.setupHash !== undefined ? { setupHash: input.config.setupHash } : {}),
    failurePolicy: input.config.failurePolicy,
    failureState: failureStateForPolicy(input.config.failurePolicy),
    reason,
  };
}

function failureStateForPolicy(policy: ZkFailurePolicy): ZkFailureState {
  if (policy === 'manual_hold') return 'manual_hold';
  if (policy === 'degrade_to_signature_only_alpha') return 'degraded_signature_only_alpha';
  return 'rejected_fail_closed';
}

function isFailurePolicy(value: unknown): value is ZkFailurePolicy {
  return value === 'fail_closed'
    || value === 'manual_hold'
    || value === 'degrade_to_signature_only_alpha';
}
