import { generateKeyPairSync, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { HarnessConfig } from '../../types.js';
import { loadConfig } from '../config.js';
import type { EvidenceReceipt } from '../evidence/types.js';
import { resolveHarnessPaths } from '../paths.js';
import {
  evidenceReceiptSigningPayload,
  protocolMessageSigningPayload,
  protocolReceiptSigningPayload,
} from '../protocol/signingPayloads.js';
import type {
  ProtocolMessage,
  ProtocolReceipt,
  SignatureDescriptor,
} from '../protocol/types.js';
import { createEd25519SignatureDescriptor } from './local.js';

export type SigningProviderKind =
  | 'disabled'
  | 'local_ephemeral_ed25519'
  | 'local_operator_file_ed25519'
  | 'external';

export interface SigningProviderConfig {
  readonly enabled: boolean;
  readonly provider: SigningProviderKind;
  readonly trustLevel: NonNullable<SignatureDescriptor['trustLevel']>;
  readonly privateKeyFile?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly fallbackSigners?: readonly {
    readonly command: string;
    readonly args?: readonly string[];
    readonly timeoutMs: number;
    readonly keyId?: string;
  }[];
  readonly failurePolicy?: 'halt' | 'degrade_to_unavailable';
  readonly keyId?: string;
  readonly expiresAt?: string;
  readonly revocationListRef?: string;
  readonly revokedKeyIds?: readonly string[];
}

export interface SidecarSigner {
  readonly provider: Exclude<SigningProviderKind, 'disabled'>;
  readonly trustLevel: NonNullable<SignatureDescriptor['trustLevel']>;
  readonly keyId?: string;
  readonly expiresAt?: string;
  readonly revocationListRef?: string;
  readonly sign: (payload: unknown, reason: string) => SignatureDescriptor;
}

export function createSidecarSigner(
  config: HarnessConfig['proofs']['signing'],
): SidecarSigner | undefined {
  if (!config.enabled || config.provider === 'disabled') return undefined;
  if (config.provider === 'external') {
    validateSigningLifecycle(config);
    return externalCommandSigner(config);
  }
  validateSigningLifecycle(config);
  if (config.provider === 'local_ephemeral_ed25519') {
    const keyPair = generateKeyPairSync('ed25519');
    return signerFromPrivateKey({
      provider: config.provider,
      privateKey: keyPair.privateKey,
      trustLevel: config.trustLevel,
      ...(config.keyId !== undefined ? { keyId: config.keyId } : {}),
      ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
      ...(config.revocationListRef !== undefined ? { revocationListRef: config.revocationListRef } : {}),
      reasonPrefix: 'local ephemeral Ed25519 signer',
    });
  }
  if (config.provider === 'local_operator_file_ed25519') {
    if (config.privateKeyFile === undefined || config.privateKeyFile.trim() === '') {
      throw new Error('local_operator_file_ed25519 signing requires proofs.signing.privateKeyFile');
    }
    const privateKey = createPrivateKey(readFileSync(config.privateKeyFile, 'utf8'));
    return signerFromPrivateKey({
      provider: config.provider,
      privateKey,
      trustLevel: config.trustLevel,
      ...(config.keyId !== undefined ? { keyId: config.keyId } : {}),
      ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
      ...(config.revocationListRef !== undefined ? { revocationListRef: config.revocationListRef } : {}),
      reasonPrefix: `operator Ed25519 key file ${config.privateKeyFile}`,
    });
  }
  const _exhaustive: never = config.provider;
  return _exhaustive;
}

export function loadConfiguredSidecarSigner(): SidecarSigner | undefined {
  const paths = resolveHarnessPaths();
  const config = loadConfig(paths);
  return createSidecarSigner(config.proofs.signing);
}

export function signProtocolMessage(
  message: ProtocolMessage,
  signer: SidecarSigner | undefined,
): ProtocolMessage {
  if (signer === undefined) return message;
  return {
    ...message,
    signature: signer.sign(
      protocolMessageSigningPayload(message),
      `protocol message ${message.kind}`,
    ),
  };
}

export function signProtocolReceipt(
  receipt: ProtocolReceipt,
  signer: SidecarSigner | undefined,
): ProtocolReceipt {
  if (signer === undefined) return receipt;
  return {
    ...receipt,
    signature: signer.sign(
      protocolReceiptSigningPayload(receipt),
      `protocol receipt ${receipt.receiptType}`,
    ),
  };
}

export function signEvidenceReceipt(
  evidence: EvidenceReceipt,
  signer: SidecarSigner | undefined,
): EvidenceReceipt {
  if (signer === undefined) return evidence;
  return {
    ...evidence,
    signature: signer.sign(
      evidenceReceiptSigningPayload(evidence),
      `evidence receipt ${evidence.kind}`,
    ),
  };
}

function signerFromPrivateKey(args: {
  readonly provider: Exclude<SidecarSigner['provider'], 'external'>;
  readonly privateKey: KeyObject;
  readonly trustLevel: SidecarSigner['trustLevel'];
  readonly keyId?: string;
  readonly expiresAt?: string;
  readonly revocationListRef?: string;
  readonly reasonPrefix: string;
}): SidecarSigner {
  return {
    provider: args.provider,
    trustLevel: args.trustLevel,
    ...(args.keyId !== undefined ? { keyId: args.keyId } : {}),
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
    ...(args.revocationListRef !== undefined ? { revocationListRef: args.revocationListRef } : {}),
    sign: (payload, reason) => createEd25519SignatureDescriptor(payload, {
      privateKey: args.privateKey,
      trustLevel: args.trustLevel,
      ...(args.keyId !== undefined ? { keyId: args.keyId } : {}),
      issuedAt: new Date().toISOString(),
      ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
      ...(args.revocationListRef !== undefined ? { revocationListRef: args.revocationListRef } : {}),
      reason: `${args.reasonPrefix}: ${reason}`,
    }),
  };
}

function externalCommandSigner(config: HarnessConfig['proofs']['signing']): SidecarSigner {
  if (config.command === undefined || config.command.trim() === '') {
    throw new Error('external signing requires proofs.signing.command');
  }
  if (config.timeoutMs === undefined || !Number.isFinite(config.timeoutMs) || config.timeoutMs < 100) {
    throw new Error('external signing requires proofs.signing.timeoutMs >= 100');
  }
  for (const fallback of config.fallbackSigners ?? []) {
    if (fallback.command.trim() === '') {
      throw new Error('external signing fallback requires command');
    }
    if (!Number.isFinite(fallback.timeoutMs) || fallback.timeoutMs < 100) {
      throw new Error('external signing fallback requires timeoutMs >= 100');
    }
  }
  return {
    provider: 'external',
    trustLevel: config.trustLevel,
    ...(config.keyId !== undefined ? { keyId: config.keyId } : {}),
    ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
    ...(config.revocationListRef !== undefined ? { revocationListRef: config.revocationListRef } : {}),
    sign: (payload, reason) => {
      const request = {
        schemaVersion: 'superharness.external_sign_request.v2',
        reason,
        payload,
        trustLevel: config.trustLevel,
        keyId: config.keyId ?? null,
        expiresAt: config.expiresAt ?? null,
        revocationListRef: config.revocationListRef ?? null,
      };
      const attempts = [
        {
          command: config.command!,
          args: config.args ?? [],
          timeoutMs: config.timeoutMs!,
          keyId: config.keyId,
        },
        ...(config.fallbackSigners ?? []),
      ];
      const failures: string[] = [];
      for (const attempt of attempts) {
        try {
          const parsed = invokeExternalSigner(attempt, request);
          if (parsed.status !== 'signed') {
            failures.push(`${attempt.command} returned ${parsed.status}`);
            continue;
          }
          const keyId = parsed.keyId ?? attempt.keyId ?? config.keyId;
          return {
            ...parsed,
            ...(keyId !== undefined ? { keyId } : {}),
          };
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if ((config.failurePolicy ?? 'halt') === 'degrade_to_unavailable') {
        return {
          status: 'unavailable',
          trustLevel: config.trustLevel,
          ...(config.keyId !== undefined ? { keyId: config.keyId } : {}),
          ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
          ...(config.revocationListRef !== undefined ? { revocationListRef: config.revocationListRef } : {}),
          reason: `external signer cascade unavailable: ${failures.join(' | ')}`,
        };
      }
      throw new Error(`external signer cascade failed: ${failures.join(' | ')}`);
    },
  };
}

function invokeExternalSigner(
  attempt: {
    readonly command: string;
    readonly args?: readonly string[];
    readonly timeoutMs: number;
  },
  request: Record<string, unknown>,
): SignatureDescriptor {
  const child = spawnSync(attempt.command, attempt.args ?? [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: attempt.timeoutMs,
  });
  if (child.error !== undefined) {
    throw new Error(`${attempt.command} failed: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(`${attempt.command} exited ${child.status}: ${child.stderr.trim()}`);
  }
  return JSON.parse(child.stdout) as SignatureDescriptor;
}

function validateSigningLifecycle(config: HarnessConfig['proofs']['signing']): void {
  const lifecycleRequired = config.trustLevel === 'operator_bound'
    || config.trustLevel === 'registry_verified';
  if (lifecycleRequired) {
    if (config.keyId === undefined || config.keyId.trim() === '') {
      throw new Error(`${config.trustLevel} signing requires proofs.signing.keyId`);
    }
    if (config.expiresAt === undefined || Number.isNaN(Date.parse(config.expiresAt))) {
      throw new Error(`${config.trustLevel} signing requires proofs.signing.expiresAt`);
    }
    if (Date.parse(config.expiresAt) <= Date.now()) {
      throw new Error(`signing key ${config.keyId} is expired`);
    }
    if (config.revocationListRef === undefined || config.revocationListRef.trim() === '') {
      throw new Error(`${config.trustLevel} signing requires proofs.signing.revocationListRef`);
    }
  }
  if (
    config.keyId !== undefined
    && config.revokedKeyIds?.includes(config.keyId) === true
  ) {
    throw new Error(`signing key ${config.keyId} is revoked by proofs.signing.revokedKeyIds`);
  }
}
