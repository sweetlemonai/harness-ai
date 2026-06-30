import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEvidenceReceipt } from '../src/lib/evidence/ledger.ts';
import { appendLedgerEntry } from '../src/lib/protocol/ledger.ts';
import {
  createProtocolMessage,
  createProtocolReceipt,
} from '../src/lib/protocol/messages.ts';
import {
  doctorProtocolSidecars,
} from '../src/lib/protocol/doctor.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import { protocolMessageSigningPayload } from '../src/lib/protocol/signingPayloads.ts';
import { createEd25519SignatureDescriptor } from '../src/lib/proof/local.ts';
import {
  createSidecarSigner,
  signEvidenceReceipt,
} from '../src/lib/proof/signing.ts';
import type { BcrxSubjectFields } from '../src/lib/protocol/types.ts';

const subject: BcrxSubjectFields = {
  subjectId: 'task:test-sidecar-doctor',
  subjectType: 'task',
  title: 'sidecar doctor test',
  assuranceContext: 'alpha',
  privacyZone: 'WORKSPACE',
  materiality: 'high',
  evidencePolicy: {
    required: true,
    minRefs: 1,
    acceptedKinds: ['human_assertion'],
  },
};

describe('protocol sidecar doctor', () => {
  it('fails a full audit that checks no sidecar entries', () => {
    const runDir = join(tmpdir(), `harness-sidecar-missing-${Date.now()}`);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'sidecar_audit.no_entries_checked'),
      true,
    );
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'sidecar_audit.evidence_missing'),
      true,
    );
  });

  it('validates sidecar ledgers and permits alpha unsigned proof warnings', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-doctor-'));
    const files = sidecarPathsForRunDir(runDir);
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject,
      summary: 'manual proof for test',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['claude.test'],
      subject,
      body: { task: 'validate' },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
    const receipt = createProtocolReceipt({
      receiptType: 'message_recorded',
      subject,
      status: 'accepted',
      messageId: message.messageId,
      payload: message,
      evidenceRefs: [evidence.evidenceId],
      issuedAt: '2026-06-30T00:00:02.000Z',
    });
    appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full' });

    assert.equal(report.ok, true);
    assert.equal(report.profile, 'alpha');
    assert.equal(report.report.issues.some((entry) => entry.severity === 'error'), false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'protocol_message.signature_not_signed'),
      true,
    );
  });

  it('fails when a sidecar line is tampered', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-tamper-'));
    const files = sidecarPathsForRunDir(runDir);
    const message = createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['claude.test'],
      subject: {
        ...subject,
        evidencePolicy: { required: false, minRefs: 0, acceptedKinds: [] },
      },
      body: { task: 'before' },
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
    const tampered = readFileSync(files.protocolMessagesFile, 'utf8').replace('before', 'after');
    writeFileSync(files.protocolMessagesFile, tampered, 'utf8');

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'protocol_message.id_mismatch'),
      true,
    );
  });

  it('fails when evidence policy is unmet', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-evidence-'));
    const files = sidecarPathsForRunDir(runDir);
    const message = createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['claude.test'],
      subject,
      body: { task: 'missing evidence' },
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'protocol_message.evidence_requirement_unmet'),
      true,
    );
  });

  it('keeps alpha operable while production profile blocks alpha-only readiness', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-profile-'));
    const files = sidecarPathsForRunDir(runDir);
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject,
      summary: 'manual proof for alpha profile split',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['claude.test'],
      subject,
      body: { task: 'profile split' },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);

    const alpha = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'alpha' });
    const production = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(alpha.ok, true);
    assert.equal(production.ok, false);
    assert.equal(
      production.report.issues.some((entry) => entry.code === 'bcrx_subject.production_context_required'),
      true,
    );
    assert.equal(
      production.report.issues.some((entry) => entry.code === 'protocol_message.signature_not_signed' && entry.severity === 'error'),
      true,
    );
  });

  it('blocks production ZK only when proofPolicy requires a proved external SNARK', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-proof-policy-'));
    const files = sidecarPathsForRunDir(runDir);
    const productionSubject: BcrxSubjectFields = {
      ...subject,
      subjectId: 'task:production-proof-policy',
      assuranceContext: 'production',
      proofPolicy: {
        required: false,
        minProofs: 0,
        acceptedModes: ['not_requested'],
      },
    };
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject: productionSubject,
      summary: 'manual proof where ZK is intentionally not requested',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['claude.test'],
      subject: productionSubject,
      body: { task: 'not requested proof' },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
    const receipt = createProtocolReceipt({
      receiptType: 'message_recorded',
      subject: productionSubject,
      status: 'accepted',
      messageId: message.messageId,
      payload: message,
      evidenceRefs: [evidence.evidenceId],
      issuedAt: '2026-06-30T00:00:02.000Z',
    });
    appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code.endsWith('.zk_required_not_proved')),
      false,
    );
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'protocol_message.signature_not_signed' && entry.severity === 'error'),
      true,
    );
  });

  it('blocks production readiness when proofPolicy requires proof but ZK is not proved', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-proof-required-'));
    const files = sidecarPathsForRunDir(runDir);
    const productionSubject: BcrxSubjectFields = {
      ...subject,
      subjectId: 'task:production-proof-required',
      assuranceContext: 'production',
      proofPolicy: {
        required: true,
        minProofs: 1,
        acceptedModes: ['external_snark'],
      },
    };
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject: productionSubject,
      summary: 'manual proof where ZK is required but missing',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const receipt = createProtocolReceipt({
      receiptType: 'message_recorded',
      subject: productionSubject,
      status: 'accepted',
      payload: { ok: true },
      evidenceRefs: [evidence.evidenceId],
      issuedAt: '2026-06-30T00:00:02.000Z',
    });
    appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'evidence_receipt.zk_required_not_proved'),
      true,
    );
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'protocol_receipt.zk_required_not_proved'),
      true,
    );
  });

  it('blocks proved external SNARK receipts that exceed their latency budget', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-zk-latency-'));
    const files = sidecarPathsForRunDir(runDir);
    const productionSubject: BcrxSubjectFields = {
      ...subject,
      subjectId: 'task:production-proof-latency',
      assuranceContext: 'production',
      proofPolicy: {
        required: true,
        minProofs: 1,
        acceptedModes: ['external_snark'],
      },
    };
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject: productionSubject,
      summary: 'external proof exceeded latency budget',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
      zkSnark: {
        status: 'proved',
        mode: 'external_snark',
        backend: 'external',
        publicInputsHash: 'a'.repeat(64),
        proofHash: 'b'.repeat(64),
        verifierRef: 'verifier:test',
        provedAt: '2026-06-30T00:00:01.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        latencyMs: 250,
        maxLatencyMs: 100,
      },
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'evidence_receipt.zk_latency_budget_exceeded'),
      true,
    );
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'evidence_receipt.zk_required_not_proved'),
      true,
    );
  });

  it('requires failed external SNARK proofs to declare a deterministic failure state', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-zk-fail-state-'));
    const files = sidecarPathsForRunDir(runDir);
    const productionSubject: BcrxSubjectFields = {
      ...subject,
      subjectId: 'task:production-proof-failed-state',
      assuranceContext: 'production',
      proofPolicy: {
        required: true,
        minProofs: 1,
        acceptedModes: ['external_snark'],
      },
    };
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject: productionSubject,
      summary: 'external proof failed closed with explicit state',
      observedBy: 'test',
      content: { ok: false },
      createdAt: '2026-06-30T00:00:00.000Z',
      zkSnark: {
        status: 'failed',
        mode: 'external_snark',
        backend: 'external',
        failurePolicy: 'fail_closed',
        failureState: 'rejected_fail_closed',
        reason: 'prover latency exceeded production budget',
      },
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'evidence_receipt.zk_failed'),
      true,
    );
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'evidence_receipt.zk_failure_state_missing'),
      false,
    );
  });

  it('blocks production operator-bound signatures without key lifecycle metadata', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-signature-lifecycle-'));
    const files = sidecarPathsForRunDir(runDir);
    const keyPair = generateKeyPairSync('ed25519');
    const productionSubject: BcrxSubjectFields = {
      ...subject,
      subjectId: 'task:signature-lifecycle',
      assuranceContext: 'production',
      evidencePolicy: { required: false, minRefs: 0, acceptedKinds: [] },
    };
    const unsigned = createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['claude.test'],
      subject: productionSubject,
      body: { task: 'missing key metadata' },
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    });
    const message = {
      ...unsigned,
      signature: createEd25519SignatureDescriptor(protocolMessageSigningPayload(unsigned), {
        privateKey: keyPair.privateKey,
        trustLevel: 'operator_bound',
        reason: 'test signature missing lifecycle metadata',
      }),
    };
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'protocol_message.signature_key_id_missing'),
      true,
    );
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'protocol_message.signature_revocation_ref_missing'),
      true,
    );
  });

  it('blocks production operator-bound signatures whose key is locally revoked', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-sidecar-revoked-key-'));
    const files = sidecarPathsForRunDir(runDir);
    const revocationFile = join(runDir, 'revocations.json');
    writeFileSync(revocationFile, JSON.stringify({ revokedKeyIds: ['revoked-operator-key'] }), 'utf8');
    const signer = createSidecarSigner({
      enabled: true,
      provider: 'local_ephemeral_ed25519',
      trustLevel: 'operator_bound',
      keyId: 'revoked-operator-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationListRef: pathToFileURL(revocationFile).href,
    });
    const productionSubject: BcrxSubjectFields = {
      ...subject,
      subjectId: 'task:production-revoked-key',
      assuranceContext: 'production',
    };
    const evidence = signEvidenceReceipt(createEvidenceReceipt({
      kind: 'human_assertion',
      subject: productionSubject,
      summary: 'signed with a locally revoked key',
      observedBy: 'test',
      content: { ok: false },
      createdAt: '2026-06-30T00:00:00.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);

    const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'evidence_receipt.signature_key_revoked'),
      true,
    );
  });
});
