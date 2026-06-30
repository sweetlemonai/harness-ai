import { readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import {
  createLocalAttestation,
  createProtocolAttestationWithZk,
  verifyProtocolAttestation,
} from '../lib/proof/local.js';
import {
  createExternalZkDescriptor,
  externalZkConfigFromHarness,
  type ExternalZkProverConfig,
} from '../lib/proof/externalZk.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import type { ProtocolAttestation } from '../lib/protocol/types.js';

export interface ProofAttestCommandArgs {
  readonly statement: string;
  readonly publicInputs: string;
  readonly mockZk?: boolean;
  readonly json?: boolean;
}

export interface ProofVerifyCommandArgs {
  readonly file: string;
  readonly json?: boolean;
}

export interface ProofExplainCommandArgs {
  readonly file: string;
  readonly json?: boolean;
}

export interface ProofExternalCommandArgs {
  readonly statement: string;
  readonly publicInputs: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxLatencyMs?: number;
  readonly circuitId?: string;
  readonly circuitVersion?: string;
  readonly verifierRef?: string;
  readonly setupHash?: string;
  readonly failurePolicy?: ExternalZkProverConfig['failurePolicy'];
  readonly json?: boolean;
}

export async function proofAttestCommand(args: ProofAttestCommandArgs): Promise<number> {
  const attestation = createLocalAttestation({
    statement: args.statement,
    publicInputs: parseJsonOrText(args.publicInputs),
    includeMockZk: args.mockZk === true,
  });
  writeOutput(attestation, args.json === true);
  return 0;
}

export async function proofVerifyCommand(args: ProofVerifyCommandArgs): Promise<number> {
  const attestation = readAttestation(args.file);
  const report = verifyProtocolAttestation(attestation);
  writeOutput(report, args.json === true);
  return report.ok ? 0 : 1;
}

export async function proofExplainCommand(args: ProofExplainCommandArgs): Promise<number> {
  const attestation = readAttestation(args.file);
  const report = verifyProtocolAttestation(attestation);
  const payload = {
    attestationId: attestation.attestationId,
    statement: attestation.statement,
    signature: {
      status: attestation.signature.status,
      algorithm: attestation.signature.algorithm ?? null,
      trustLevel: attestation.signature.trustLevel ?? 'unknown',
      identityBound: attestation.signature.trustLevel === 'registry_verified'
        || attestation.signature.trustLevel === 'operator_bound',
    },
    zkSnark: {
      status: attestation.zkSnark.status,
      mode: attestation.zkSnark.mode,
      backend: attestation.zkSnark.backend,
      publicInputsHash: attestation.zkSnark.publicInputsHash ?? attestation.publicInputsHash,
      proofHash: attestation.zkSnark.proofHash ?? null,
      realSnarkVerified: attestation.zkSnark.mode === 'external_snark'
        && attestation.zkSnark.status === 'proved'
        && report.ok,
      alphaIntegrityOnly: attestation.zkSnark.mode === 'mock_transcript',
    },
    report,
  };
  writeOutput(payload, args.json === true);
  return report.ok ? 0 : 1;
}

export async function proofExternalCommand(args: ProofExternalCommandArgs): Promise<number> {
  const publicInputs = parseJsonOrText(args.publicInputs);
  const config = externalZkConfigFromArgs(args);
  const zkSnark = createExternalZkDescriptor({
    statement: args.statement,
    publicInputs,
    config,
  });
  const attestation = createProtocolAttestationWithZk({
    statement: args.statement,
    publicInputs,
    zkSnark,
  });
  const report = verifyProtocolAttestation(attestation);
  writeOutput({
    attestation,
    report,
  }, args.json === true);
  return report.ok ? 0 : 1;
}

function externalZkConfigFromArgs(args: ProofExternalCommandArgs): ExternalZkProverConfig {
  const configuredZk = loadConfig(resolveHarnessPaths()).proofs.zkSnarks;
  const configured = configuredZk.command === undefined
    ? undefined
    : externalZkConfigFromHarness(configuredZk);
  const command = args.command ?? configured?.command;
  const timeoutMs = args.timeoutMs ?? configured?.timeoutMs;
  const maxOutputBytes = args.maxOutputBytes ?? configured?.maxOutputBytes;
  const maxLatencyMs = args.maxLatencyMs ?? configured?.maxLatencyMs;
  const failurePolicy = args.failurePolicy ?? configured?.failurePolicy ?? configuredZk.failurePolicy;
  if (command === undefined || command.trim() === '') {
    throw new Error('external ZK proving requires --command or proofs.zkSnarks.command');
  }
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs < 100) {
    throw new Error('external ZK proving requires --timeout-ms or proofs.zkSnarks.timeoutMs >= 100');
  }
  if (maxOutputBytes === undefined || !Number.isFinite(maxOutputBytes) || maxOutputBytes < 1024) {
    throw new Error('external ZK proving requires --max-output-bytes or proofs.zkSnarks.maxOutputBytes >= 1024');
  }
  if (maxLatencyMs === undefined || !Number.isFinite(maxLatencyMs) || maxLatencyMs < 1) {
    throw new Error('external ZK proving requires --max-latency-ms or proofs.zkSnarks.maxLatencyMs >= 1');
  }
  if (
    failurePolicy !== 'fail_closed'
    && failurePolicy !== 'manual_hold'
    && failurePolicy !== 'degrade_to_signature_only_alpha'
  ) {
    throw new Error('external ZK proving requires --failure-policy or proofs.zkSnarks.failurePolicy');
  }
  const merged: ExternalZkProverConfig = {
    command,
    timeoutMs,
    maxOutputBytes,
    maxLatencyMs,
    failurePolicy,
  };
  const proverArgs = args.args ?? configured?.args;
  const circuitId = args.circuitId ?? configured?.circuitId;
  const circuitVersion = args.circuitVersion ?? configured?.circuitVersion;
  const verifierRef = args.verifierRef ?? configured?.verifierRef;
  const setupHash = args.setupHash ?? configured?.setupHash;
  return {
    ...merged,
    ...(proverArgs !== undefined ? { args: proverArgs } : {}),
    ...(circuitId !== undefined ? { circuitId } : {}),
    ...(circuitVersion !== undefined ? { circuitVersion } : {}),
    ...(verifierRef !== undefined ? { verifierRef } : {}),
    ...(setupHash !== undefined ? { setupHash } : {}),
  };
}

function readAttestation(file: string): ProtocolAttestation {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (isProtocolAttestation(parsed)) return parsed;
  if (
    parsed !== null
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && isProtocolAttestation((parsed as { readonly attestation?: unknown }).attestation)
  ) {
    return (parsed as { readonly attestation: ProtocolAttestation }).attestation;
  }
  throw new Error(`file does not contain a protocol attestation: ${file}`);
}

function isProtocolAttestation(value: unknown): value is ProtocolAttestation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ProtocolAttestation>;
  return typeof candidate.attestationId === 'string'
    && typeof candidate.statement === 'string'
    && typeof candidate.publicInputsHash === 'string'
    && typeof candidate.issuedAt === 'string'
    && candidate.signature !== undefined
    && candidate.zkSnark !== undefined;
}

function parseJsonOrText(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
