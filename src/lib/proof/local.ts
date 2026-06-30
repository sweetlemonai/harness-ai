import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { createVerificationReport, issue } from '../protocol/verify.js';
import {
  sha256Hex,
  stableId,
  stableStringify,
} from '../protocol/hash.js';
import type {
  ProtocolAttestation,
  SignatureDescriptor,
  ZkSnarkDescriptor,
} from '../protocol/types.js';
import type {
  VerificationIssue,
  VerificationReport,
} from '../../types.js';

const SIGNATURE_DOMAIN = 'superharness.signature.v2';
const MOCK_ZK_DOMAIN = 'superharness.mock_zk_transcript.v2';
const ATTESTATION_DOMAIN = 'superharness.protocol_attestation.v2';
export const INLINE_ED25519_PREFIX = 'inline-spki-ed25519:';

export const ZK_NOT_REQUESTED: ZkSnarkDescriptor = {
  status: 'not_requested',
  mode: 'not_requested',
  backend: 'mock_local',
};

export function createSelfSignedSignature(
  payload: unknown,
  args: {
    readonly reason?: string;
  } = {},
): SignatureDescriptor {
  const keyPair = generateKeyPairSync('ed25519');
  return createEd25519SignatureDescriptor(payload, {
    privateKey: keyPair.privateKey,
    trustLevel: 'self_signed',
    reason: args.reason ?? 'alpha self-signed local integrity signature; not registry identity-bound',
  });
}

export function createEd25519SignatureDescriptor(
  payload: unknown,
  args: {
    readonly privateKey: KeyObject;
    readonly trustLevel: NonNullable<SignatureDescriptor['trustLevel']>;
    readonly keyId?: string;
    readonly issuedAt?: string;
    readonly expiresAt?: string;
    readonly revocationListRef?: string;
    readonly reason?: string;
  },
): SignatureDescriptor {
  const publicKey = createPublicKey(args.privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const signature = cryptoSign(null, signaturePayload(payload), args.privateKey);
  return {
    status: 'signed',
    algorithm: 'ed25519',
    signature: `base64:${signature.toString('base64')}`,
    publicKeyRef: `${INLINE_ED25519_PREFIX}${Buffer.from(publicDer).toString('base64')}`,
    trustLevel: args.trustLevel,
    ...(args.keyId !== undefined ? { keyId: args.keyId } : {}),
    ...(args.issuedAt !== undefined ? { issuedAt: args.issuedAt } : {}),
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
    ...(args.revocationListRef !== undefined ? { revocationListRef: args.revocationListRef } : {}),
    reason: args.reason ?? `${args.trustLevel} Ed25519 signature`,
  };
}

export function verifySignatureDescriptor(
  payload: unknown,
  signature: SignatureDescriptor,
  subjectId: string,
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (signature.status !== 'signed') {
    issues.push(issue('warning', 'signature.not_signed', 'object is not cryptographically signed', { subjectId }));
    return issues;
  }
  if (signature.algorithm !== 'ed25519') {
    issues.push(issue('error', 'signature.algorithm_unsupported', 'signature algorithm is not supported by local verifier', { subjectId }));
    return issues;
  }
  if (signature.signature === undefined || !signature.signature.startsWith('base64:')) {
    issues.push(issue('error', 'signature.value_invalid', 'signature must be a base64 descriptor', { subjectId }));
    return issues;
  }
  if (signature.publicKeyRef === undefined || !signature.publicKeyRef.startsWith(INLINE_ED25519_PREFIX)) {
    issues.push(issue('error', 'signature.public_key_ref_invalid', 'local verifier requires an inline Ed25519 public key ref', { subjectId }));
    return issues;
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(signature.publicKeyRef.slice(INLINE_ED25519_PREFIX.length), 'base64'),
      type: 'spki',
      format: 'der',
    });
    const ok = cryptoVerify(
      null,
      signaturePayload(payload),
      publicKey,
      Buffer.from(signature.signature.slice('base64:'.length), 'base64'),
    );
    if (!ok) {
      issues.push(issue('error', 'signature.verify_failed', 'signature verification failed', { subjectId }));
    }
  } catch {
    issues.push(issue('error', 'signature.verify_error', 'signature could not be parsed or verified', { subjectId }));
  }
  if (signature.trustLevel !== 'registry_verified' && signature.trustLevel !== 'operator_bound') {
    issues.push(issue('warning', 'signature.identity_not_registry_verified', 'signature is cryptographic but not bound to a verified identity registry', { subjectId }));
  }
  return issues;
}

export function createMockZkTranscript(args: {
  readonly statement: string;
  readonly publicInputsHash: string;
  readonly circuitId?: string;
}): ZkSnarkDescriptor {
  const circuitId = args.circuitId ?? 'mock-local-transcript-v1';
  return {
    status: 'unavailable',
    mode: 'mock_transcript',
    backend: 'mock_local',
    circuitId,
    publicInputsHash: args.publicInputsHash,
    proofHash: mockTranscriptHash({
      statement: args.statement,
      publicInputsHash: args.publicInputsHash,
      circuitId,
    }),
    reason: 'mock_local transcript is deterministic integrity evidence, not a SNARK proof',
  };
}

export function verifyZkDescriptor(
  zkSnark: ZkSnarkDescriptor,
  subjectId: string,
  args: {
    readonly statement?: string;
  } = {},
): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (zkSnark.mode === 'not_requested') {
    if (zkSnark.status !== 'not_requested') {
      issues.push(issue('error', 'zk.not_requested_status_invalid', 'not_requested ZK mode must use not_requested status', { subjectId }));
    }
    return issues;
  }
  if (zkSnark.mode === 'mock_transcript') {
    if (zkSnark.backend !== 'mock_local') {
      issues.push(issue('error', 'zk.mock_backend_invalid', 'mock transcript must use mock_local backend', { subjectId }));
    }
    if (zkSnark.status === 'proved') {
      issues.push(issue('error', 'zk.mock_transcript_claims_proved', 'mock transcript must not claim proved SNARK status', { subjectId }));
    }
    if (zkSnark.publicInputsHash === undefined || !isSha256Hex(zkSnark.publicInputsHash)) {
      issues.push(issue('error', 'zk.public_inputs_hash_invalid', 'ZK descriptor publicInputsHash must be sha256 hex', { subjectId }));
    }
    if (zkSnark.proofHash === undefined || !isSha256Hex(zkSnark.proofHash)) {
      issues.push(issue('error', 'zk.mock_proof_hash_invalid', 'mock transcript proofHash must be sha256 hex', { subjectId }));
    }
    if (
      args.statement !== undefined
      && zkSnark.publicInputsHash !== undefined
      && zkSnark.circuitId !== undefined
      && zkSnark.proofHash !== mockTranscriptHash({
        statement: args.statement,
        publicInputsHash: zkSnark.publicInputsHash,
        circuitId: zkSnark.circuitId,
      })
    ) {
      issues.push(issue('error', 'zk.mock_transcript_hash_mismatch', 'mock transcript hash does not match statement and public inputs hash', { subjectId }));
    }
    issues.push(issue('warning', 'zk.mock_transcript_not_snark', 'mock transcript verified only local integrity; no SNARK proof was verified', { subjectId }));
    return issues;
  }
  if (zkSnark.mode === 'external_snark') {
    if (zkSnark.backend !== 'external') {
      issues.push(issue('error', 'zk.external_backend_invalid', 'external_snark mode requires external backend', { subjectId }));
    }
    if (zkSnark.status === 'proved') {
      if (zkSnark.publicInputsHash === undefined || !isSha256Hex(zkSnark.publicInputsHash)) {
        issues.push(issue('error', 'zk.external_public_inputs_hash_invalid', 'proved external SNARK requires publicInputsHash', { subjectId }));
      }
      if (zkSnark.proofHash === undefined || !isSha256Hex(zkSnark.proofHash)) {
        issues.push(issue('error', 'zk.external_proof_hash_invalid', 'proved external SNARK requires proofHash', { subjectId }));
      }
      if (zkSnark.verifierRef === undefined || zkSnark.verifierRef.trim() === '') {
        issues.push(issue('error', 'zk.external_verifier_ref_missing', 'proved external SNARK requires verifierRef', { subjectId }));
      }
    } else if (zkSnark.status === 'failed') {
      issues.push(issue('error', 'zk.external_failed', 'external ZK proof status is failed', { subjectId }));
    } else {
      issues.push(issue('warning', 'zk.external_not_proved', 'external ZK proof is not proved', { subjectId }));
    }
  }
  return issues;
}

export function createLocalAttestation(args: {
  readonly statement: string;
  readonly publicInputs: unknown;
  readonly includeMockZk?: boolean;
  readonly issuedAt?: string;
}): ProtocolAttestation {
  const issuedAt = args.issuedAt ?? new Date().toISOString();
  const publicInputsHash = sha256Hex(stableStringify(args.publicInputs));
  const zkSnark = args.includeMockZk === true
    ? createMockZkTranscript({
      statement: args.statement,
      publicInputsHash,
    })
    : ZK_NOT_REQUESTED;
  const unsigned = {
    attestationId: stableId('attestation', {
      statement: args.statement,
      publicInputsHash,
      issuedAt,
      zkMode: zkSnark.mode,
      proofHash: zkSnark.proofHash ?? null,
    }),
    statement: args.statement,
    publicInputsHash,
    issuedAt,
    zkSnark,
  };
  return {
    ...unsigned,
    signature: createSelfSignedSignature(attestationSignaturePayload(unsigned)),
  };
}

export function createProtocolAttestationWithZk(args: {
  readonly statement: string;
  readonly publicInputs: unknown;
  readonly zkSnark: ZkSnarkDescriptor;
  readonly issuedAt?: string;
}): ProtocolAttestation {
  const issuedAt = args.issuedAt ?? new Date().toISOString();
  const publicInputsHash = sha256Hex(stableStringify(args.publicInputs));
  const unsigned = {
    attestationId: stableId('attestation', {
      statement: args.statement,
      publicInputsHash,
      issuedAt,
      zkMode: args.zkSnark.mode,
      proofHash: args.zkSnark.proofHash ?? null,
    }),
    statement: args.statement,
    publicInputsHash,
    issuedAt,
    zkSnark: args.zkSnark,
  };
  return {
    ...unsigned,
    signature: createSelfSignedSignature(attestationSignaturePayload(unsigned)),
  };
}

export function verifyProtocolAttestation(
  attestation: ProtocolAttestation,
): VerificationReport {
  const expectedId = stableId('attestation', {
    statement: attestation.statement,
    publicInputsHash: attestation.publicInputsHash,
    issuedAt: attestation.issuedAt,
    zkMode: attestation.zkSnark.mode,
    proofHash: attestation.zkSnark.proofHash ?? null,
  });
  const issues: VerificationIssue[] = [];
  if (attestation.attestationId !== expectedId) {
    issues.push(issue('error', 'attestation.id_mismatch', 'attestationId does not match canonical public fields', {
      subjectId: attestation.attestationId,
    }));
  }
  if (!isSha256Hex(attestation.publicInputsHash)) {
    issues.push(issue('error', 'attestation.public_inputs_hash_invalid', 'attestation publicInputsHash must be sha256 hex', {
      subjectId: attestation.attestationId,
    }));
  }
  issues.push(...verifyZkDescriptor(attestation.zkSnark, attestation.attestationId, {
    statement: attestation.statement,
  }));
  issues.push(...verifySignatureDescriptor(
    attestationSignaturePayload({
      attestationId: attestation.attestationId,
      statement: attestation.statement,
      publicInputsHash: attestation.publicInputsHash,
      issuedAt: attestation.issuedAt,
      zkSnark: attestation.zkSnark,
    }),
    attestation.signature,
    attestation.attestationId,
  ));
  return createVerificationReport({
    subject: attestation.attestationId,
    issues,
    headHash: sha256Hex(stableStringify({
      attestationId: attestation.attestationId,
      publicInputsHash: attestation.publicInputsHash,
      zkSnark: attestation.zkSnark,
      signature: attestation.signature,
    })),
  });
}

function signaturePayload(payload: unknown): Buffer {
  return Buffer.from(stableStringify({
    domain: SIGNATURE_DOMAIN,
    payload,
  }), 'utf8');
}

function attestationSignaturePayload(attestation: Omit<ProtocolAttestation, 'signature'>): unknown {
  return {
    domain: ATTESTATION_DOMAIN,
    attestationId: attestation.attestationId,
    statement: attestation.statement,
    publicInputsHash: attestation.publicInputsHash,
    issuedAt: attestation.issuedAt,
    zkSnark: attestation.zkSnark,
  };
}

function mockTranscriptHash(args: {
  readonly statement: string;
  readonly publicInputsHash: string;
  readonly circuitId: string;
}): string {
  return sha256Hex(stableStringify({
    domain: MOCK_ZK_DOMAIN,
    mode: 'mock_transcript',
    backend: 'mock_local',
    circuitId: args.circuitId,
    statement: args.statement,
    publicInputsHash: args.publicInputsHash,
  }));
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
