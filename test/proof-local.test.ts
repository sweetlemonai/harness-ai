import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createExternalZkDescriptor,
  type ExternalZkProverConfig,
} from '../src/lib/proof/externalZk.ts';
import {
  createLocalAttestation,
  createProtocolAttestationWithZk,
  verifyProtocolAttestation,
} from '../src/lib/proof/local.ts';
import { createSidecarSigner } from '../src/lib/proof/signing.ts';
import type { ProtocolAttestation } from '../src/lib/protocol/types.ts';

describe('local proof attestations', () => {
  it('verifies self-signed alpha attestations with explicit mock transcript warnings', () => {
    const attestation = createLocalAttestation({
      statement: 'receipt public inputs are bound',
      publicInputs: { receiptId: 'receipt_test', ok: true },
      includeMockZk: true,
      issuedAt: '2026-06-30T00:00:00.000Z',
    });

    const report = verifyProtocolAttestation(attestation);

    assert.equal(report.ok, true);
    assert.equal(attestation.signature.status, 'signed');
    assert.equal(attestation.signature.algorithm, 'ed25519');
    assert.equal(attestation.signature.trustLevel, 'self_signed');
    assert.equal(attestation.zkSnark.mode, 'mock_transcript');
    assert.equal(attestation.zkSnark.status, 'unavailable');
    assert.equal(
      report.issues.some((entry) => entry.code === 'zk.mock_transcript_not_snark'),
      true,
    );
  });

  it('fails when an attestation statement is tampered', () => {
    const attestation = createLocalAttestation({
      statement: 'original statement',
      publicInputs: { receiptId: 'receipt_test' },
      includeMockZk: true,
      issuedAt: '2026-06-30T00:00:00.000Z',
    });
    const tampered: ProtocolAttestation = {
      ...attestation,
      statement: 'tampered statement',
    };

    const report = verifyProtocolAttestation(tampered);

    assert.equal(report.ok, false);
    assert.equal(
      report.issues.some((entry) => entry.code === 'attestation.id_mismatch'),
      true,
    );
    assert.equal(
      report.issues.some((entry) => entry.code === 'signature.verify_failed'),
      true,
    );
  });

  it('fails if a mock-local transcript claims proved SNARK status', () => {
    const attestation = createLocalAttestation({
      statement: 'mock transcript cannot be a SNARK proof',
      publicInputs: { receiptId: 'receipt_test' },
      includeMockZk: true,
      issuedAt: '2026-06-30T00:00:00.000Z',
    });
    const falseProof: ProtocolAttestation = {
      ...attestation,
      zkSnark: {
        ...attestation.zkSnark,
        status: 'proved',
      },
    };

    const report = verifyProtocolAttestation(falseProof);

    assert.equal(report.ok, false);
    assert.equal(
      report.issues.some((entry) => entry.code === 'zk.mock_transcript_claims_proved'),
      true,
    );
  });

  it('refuses to create an operator-bound signer for a revoked key id', () => {
    assert.throws(() => createSidecarSigner({
      enabled: true,
      provider: 'local_ephemeral_ed25519',
      trustLevel: 'operator_bound',
      keyId: 'operator-key-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationListRef: 'test://revocations',
      revokedKeyIds: ['operator-key-1'],
    }), /revoked/);
  });

  it('refuses operator-bound signing without a revocation reference', () => {
    assert.throws(() => createSidecarSigner({
      enabled: true,
      provider: 'local_ephemeral_ed25519',
      trustLevel: 'operator_bound',
      keyId: 'operator-key-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }), /revocationListRef/);
  });

  it('uses a configured external signer command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-external-signer-'));
    const script = join(dir, 'signer.mjs');
    writeFileSync(script, `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  process.stdout.write(JSON.stringify({
    status: 'signed',
    algorithm: 'ed25519',
    signature: 'base64:dGVzdA==',
    publicKeyRef: 'inline-spki-ed25519:dGVzdA==',
    trustLevel: request.trustLevel,
    keyId: request.keyId,
    issuedAt: '2026-06-30T00:00:00.000Z',
    expiresAt: request.expiresAt,
    revocationListRef: request.revocationListRef,
    reason: request.reason
  }));
});
`, 'utf8');
    const signer = createSidecarSigner({
      enabled: true,
      provider: 'external',
      command: process.execPath,
      args: [script],
      timeoutMs: 1000,
      trustLevel: 'operator_bound',
      keyId: 'kms-test-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationListRef: 'kms://revocations/test',
    });

    const signature = signer?.sign({ ok: true }, 'external signer test');

    assert.equal(signature?.status, 'signed');
    assert.equal(signature?.trustLevel, 'operator_bound');
    assert.equal(signature?.keyId, 'kms-test-key');
  });

  it('uses an external signer fallback when the primary command fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-external-signer-fallback-'));
    const failing = join(dir, 'fail.mjs');
    const fallback = join(dir, 'fallback.mjs');
    writeFileSync(failing, 'process.exit(42);', 'utf8');
    writeFileSync(fallback, `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  process.stdout.write(JSON.stringify({
    status: 'signed',
    algorithm: 'ed25519',
    signature: 'base64:ZmFsbGJhY2s=',
    publicKeyRef: 'inline-spki-ed25519:ZmFsbGJhY2s=',
    trustLevel: request.trustLevel,
    keyId: 'kms-fallback-key',
    issuedAt: '2026-06-30T00:00:00.000Z',
    expiresAt: request.expiresAt,
    revocationListRef: request.revocationListRef,
    reason: request.reason
  }));
});
`, 'utf8');
    const signer = createSidecarSigner({
      enabled: true,
      provider: 'external',
      command: process.execPath,
      args: [failing],
      timeoutMs: 1000,
      fallbackSigners: [{
        command: process.execPath,
        args: [fallback],
        timeoutMs: 1000,
        keyId: 'kms-fallback-key',
      }],
      trustLevel: 'operator_bound',
      keyId: 'kms-primary-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationListRef: 'kms://revocations/test',
    });

    const signature = signer?.sign({ ok: true }, 'fallback signer test');

    assert.equal(signature?.status, 'signed');
    assert.equal(signature?.keyId, 'kms-fallback-key');
  });

  it('can explicitly degrade to unavailable when every external signer fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-external-signer-unavailable-'));
    const failing = join(dir, 'fail.mjs');
    writeFileSync(failing, 'process.exit(42);', 'utf8');
    const signer = createSidecarSigner({
      enabled: true,
      provider: 'external',
      command: process.execPath,
      args: [failing],
      timeoutMs: 1000,
      failurePolicy: 'degrade_to_unavailable',
      trustLevel: 'operator_bound',
      keyId: 'kms-primary-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationListRef: 'kms://revocations/test',
    });

    const signature = signer?.sign({ ok: true }, 'unavailable signer test');

    assert.equal(signature?.status, 'unavailable');
    assert.match(signature?.reason ?? '', /cascade unavailable/);
  });

  it('wraps a proved external ZK descriptor in a verifiable attestation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-external-zk-'));
    const prover = join(dir, 'prover.mjs');
    writeFileSync(prover, `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  process.stdout.write(JSON.stringify({
    status: 'proved',
    mode: 'external_snark',
    backend: 'external',
    circuitId: request.circuitId,
    circuitVersion: request.circuitVersion,
    publicInputsHash: request.publicInputsHash,
    proofHash: 'c'.repeat(64),
    verifierRef: request.verifierRef,
    provedAt: '2026-06-30T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    latencyMs: 5,
    maxLatencyMs: request.maxLatencyMs,
    failurePolicy: request.failurePolicy,
    failureState: 'none'
  }));
});
`, 'utf8');
    const config = externalZkConfig(prover);
    const publicInputs = { receiptId: 'receipt_test', ok: true };

    const zkSnark = createExternalZkDescriptor({
      statement: 'receipt public inputs are externally proved',
      publicInputs,
      config,
    });
    const attestation = createProtocolAttestationWithZk({
      statement: 'receipt public inputs are externally proved',
      publicInputs,
      zkSnark,
      issuedAt: '2026-06-30T00:00:01.000Z',
    });
    const report = verifyProtocolAttestation(attestation);

    assert.equal(zkSnark.status, 'proved');
    assert.equal(zkSnark.failurePolicy, 'fail_closed');
    assert.equal(report.ok, true);
  });

  it('fails closed when an external ZK prover returns mismatched public inputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-external-zk-mismatch-'));
    const prover = join(dir, 'prover.mjs');
    writeFileSync(prover, `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    status: 'proved',
    mode: 'external_snark',
    backend: 'external',
    publicInputsHash: '${'d'.repeat(64)}',
    proofHash: 'e'.repeat(64),
    verifierRef: 'verifier:test',
    provedAt: '2026-06-30T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z'
  }));
});
`, 'utf8');

    const zkSnark = createExternalZkDescriptor({
      statement: 'receipt public inputs are externally proved',
      publicInputs: { receiptId: 'receipt_test', ok: true },
      config: externalZkConfig(prover),
    });

    assert.equal(zkSnark.status, 'failed');
    assert.equal(zkSnark.failureState, 'rejected_fail_closed');
    assert.match(zkSnark.reason ?? '', /publicInputsHash mismatch/);
  });
});

function externalZkConfig(command: string): ExternalZkProverConfig {
  return {
    command: process.execPath,
    args: [command],
    timeoutMs: 1000,
    maxOutputBytes: 8192,
    circuitId: 'test-circuit',
    circuitVersion: 'v1',
    verifierRef: 'verifier:test',
    setupHash: 'setup:test',
    maxLatencyMs: 100,
    failurePolicy: 'fail_closed',
  };
}
