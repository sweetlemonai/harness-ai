import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAdapterFailureEvidence,
  createAdapterRecoveryEvidence,
  createEvidenceReceipt,
} from '../src/lib/evidence/ledger.ts';
import { createProtocolMessage, createProtocolReceipt } from '../src/lib/protocol/messages.ts';
import { evaluateProductionPromotion } from '../src/lib/protocol/promotion.ts';
import { appendLedgerEntry } from '../src/lib/protocol/ledger.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import { stableHash, stableId } from '../src/lib/protocol/hash.ts';
import { createRllControlSignal, createRllEvent } from '../src/lib/rll/ledger.ts';
import type { BcrxSubjectFields } from '../src/lib/protocol/types.ts';
import {
  createSidecarSigner,
  signEvidenceReceipt,
  signProtocolMessage,
  signProtocolReceipt,
} from '../src/lib/proof/signing.ts';

describe('production promotion guard', () => {
  it('blocks a missing run instead of treating empty audits as readiness', () => {
    const runDir = join(tmpdir(), `harness-promotion-missing-${Date.now()}`);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, false);
    assert.equal(decision.guard.profile, 'production');
    assert.equal(decision.guard.callerProfileOverrideAllowed, false);
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'sidecar_audit.no_entries_checked'),
      true,
    );
  });

  it('blocks alpha-only sidecars from production promotion', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-promotion-alpha-'));
    const files = sidecarPathsForRunDir(runDir);
    const subject = subjectFor('task:alpha-promotion', 'alpha');
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject,
      summary: 'alpha-only evidence',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['superharness.control'],
      subject,
      body: { ok: true },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, false);
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'bcrx_subject.production_context_required'),
      true,
    );
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'protocol_message.signature_not_signed'),
      true,
    );
  });

  it('allows a production-tagged run when signatures, ledgers, and policy are satisfied', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-promotion-production-'));
    const files = sidecarPathsForRunDir(runDir);
    const signer = createSidecarSigner({
      enabled: true,
      provider: 'local_ephemeral_ed25519',
      trustLevel: 'operator_bound',
      keyId: 'test-operator-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationListRef: 'test://revocations/empty',
    });
    const subject = subjectFor('task:production-promotion', 'production');
    const evidence = signEvidenceReceipt(createEvidenceReceipt({
      kind: 'human_assertion',
      subject,
      summary: 'production evidence where ZK is not required by policy',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = signProtocolMessage(createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['superharness.control'],
      subject,
      body: { ok: true },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    }), signer);
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
    const receipt = signProtocolReceipt(createProtocolReceipt({
      receiptType: 'message_recorded',
      subject,
      status: 'accepted',
      messageId: message.messageId,
      payload: message,
      evidenceRefs: [evidence.evidenceId],
      issuedAt: '2026-06-30T00:00:02.000Z',
    }), signer);
    appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);
    appendAcceptedDissent(files, signer, {
      subject,
      evidenceRef: evidence.evidenceId,
      createdAt: '2026-06-30T00:00:02.500Z',
      issuedAt: '2026-06-30T00:00:02.750Z',
      rllAt: '2026-06-30T00:00:02.900Z',
    });
    const rllEvent = createRllEvent({
      kind: 'observation',
      subject,
      source: 'test',
      summary: 'production observation',
      outputRefs: [evidence.evidenceId, message.messageId, receipt.receiptId],
      createdAt: '2026-06-30T00:00:03.000Z',
      metrics: {},
      confidence: 1,
    });
    appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
    const signal = createRllControlSignal({
      action: 'gather_more_evidence',
      subject,
      reason: 'production promotion fixture signal',
      strength: 0.2,
      sourceEventIds: [rllEvent.eventId],
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:04.000Z',
    });
    appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, true);
    assert.equal(decision.blockers.length, 0);
    assert.equal(
      decision.warnings.some((entry) => entry.code === 'evidence_receipt.zk_not_proved'),
      true,
    );
  });

  it('blocks production promotion when required dissent lacks an accepted receipt', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-promotion-missing-dissent-'));
    const files = sidecarPathsForRunDir(runDir);
    const signer = productionSigner();
    const subject = subjectFor('task:missing-dissent', 'production');
    const evidence = signEvidenceReceipt(createEvidenceReceipt({
      kind: 'human_assertion',
      subject,
      summary: 'production evidence without dissent',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = signProtocolMessage(createProtocolMessage({
      kind: 'task_request',
      from: 'codex.test',
      to: ['superharness.control'],
      subject,
      body: { ok: true },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    }), signer);
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
    const receipt = signProtocolReceipt(createProtocolReceipt({
      receiptType: 'message_recorded',
      subject,
      status: 'accepted',
      messageId: message.messageId,
      payload: message,
      evidenceRefs: [evidence.evidenceId],
      issuedAt: '2026-06-30T00:00:02.000Z',
    }), signer);
    appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);
    const rllEvent = createRllEvent({
      kind: 'observation',
      subject,
      source: 'test',
      summary: 'production observation without dissent',
      outputRefs: [evidence.evidenceId, message.messageId, receipt.receiptId],
      createdAt: '2026-06-30T00:00:03.000Z',
      metrics: {},
      confidence: 1,
    });
    appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
    const signal = createRllControlSignal({
      action: 'gather_more_evidence',
      subject,
      reason: 'production promotion missing dissent fixture signal',
      strength: 0.2,
      sourceEventIds: [rllEvent.eventId],
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:04.000Z',
    });
    appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, false);
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'dissent.requirement_unmet'),
      true,
    );
  });

  it('blocks production promotion when signed adapter failure evidence is present', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-promotion-adapter-failure-'));
    const files = sidecarPathsForRunDir(runDir);
    const signer = createSidecarSigner({
      enabled: true,
      provider: 'local_ephemeral_ed25519',
      trustLevel: 'operator_bound',
      keyId: 'test-operator-key',
      expiresAt: '2099-01-01T00:00:00.000Z',
      revocationListRef: 'test://revocations/empty',
    });
    const subject = subjectFor('adapter:production-failure', 'production');
    const evidence = signEvidenceReceipt(createEvidenceReceipt({
      kind: 'adapter_failure',
      subject: {
        ...subject,
        subjectType: 'adapter',
      },
      summary: 'production adapter failure',
      observedBy: 'test',
      content: { error: 'upstream refused' },
      createdAt: '2026-06-30T00:00:00.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = signProtocolMessage(createProtocolMessage({
      kind: 'adapter_failure',
      from: 'codex.test',
      to: ['superharness.control'],
      subject: evidence.subject,
      body: { error: 'upstream refused' },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 1 },
    }), signer);
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
    const receipt = signProtocolReceipt(createProtocolReceipt({
      receiptType: 'adapter_failure_recorded',
      subject: evidence.subject,
      status: 'degraded',
      messageId: message.messageId,
      payload: message,
      evidenceRefs: [evidence.evidenceId],
      issuedAt: '2026-06-30T00:00:02.000Z',
    }), signer);
    appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);
    const rllEvent = createRllEvent({
      kind: 'failure',
      subject: evidence.subject,
      source: 'test',
      summary: 'production adapter failure',
      outputRefs: [evidence.evidenceId, message.messageId, receipt.receiptId],
      createdAt: '2026-06-30T00:00:03.000Z',
      metrics: { adapterFailure: 1 },
      confidence: 1,
    });
    appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
    const signal = createRllControlSignal({
      action: 'request_dissent',
      subject: evidence.subject,
      reason: 'adapter failure should block production promotion',
      strength: 1,
      sourceEventIds: [rllEvent.eventId],
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:04.000Z',
    });
    appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, false);
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'agentops_panel.adapter_failure_open'),
      true,
    );
  });

  it('does not let an unbound adapter recovery clear a production adapter failure', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-promotion-invalid-recovery-'));
    const files = sidecarPathsForRunDir(runDir);
    const signer = productionSigner();
    appendProductionFixture(files, signer);
    const failureSubject = { ...subjectFor('adapter:ornith-adapter', 'production'), subjectType: 'adapter' as const };
    const failure = signEvidenceReceipt(createAdapterFailureEvidence({
      subject: failureSubject,
      observedBy: 'test',
      failure: {
        adapterId: 'ornith-adapter',
        providerId: 'local-v1',
        error: 'reasoning-only response',
      },
      createdAt: '2026-06-30T00:01:00.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, failure as unknown as Record<string, unknown>);
    const recovery = signEvidenceReceipt(createAdapterRecoveryEvidence({
      subject: {
        ...failureSubject,
        verificationStatus: 'independently_verified',
        identityBindingStatus: 'evidence_bound',
        blocking: false,
      },
      observedBy: 'test',
      recovery: {
        adapterId: 'ornith-adapter',
        providerId: 'local-v1',
        adapterInstanceId: 'spark4:ornith-adapter',
        adapterVersion: '2026.06.30-invalid',
        recoveredBy: 'codex.test',
        verifierAgentId: 'ornith.test',
        identityVerifierAgentId: 'step37.test',
        verifierTrustAnchorRef: 'fleet://ornith/root',
        verifierAttestationRefs: ['attestation:ornith:runtime'],
        identityVerifierTrustAnchorRef: 'fleet://step37/root',
        identityVerifierAttestationRefs: ['attestation:step37:runtime'],
        transactionId: 'verify_bind_tx_invalid',
        transactionStatus: 'prepared',
        transactionPreparedAt: '2026-06-30T00:01:00.500Z',
        transactionCommittedAt: '2026-06-30T00:01:00.500Z',
        bindingPayloadHash: 'not-the-canonical-binding-hash',
        recoveryEvidenceRefs: [failure.evidenceId],
        verificationEvidenceRefs: [failure.evidenceId],
        identityBindingRefs: [failure.evidenceId],
        resolvesEvidenceIds: [failure.evidenceId],
        resolvesSubjectIds: [failureSubject.subjectId],
      },
      createdAt: '2026-06-30T00:01:01.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, recovery as unknown as Record<string, unknown>);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, false);
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'agentops_panel.adapter_recovery_invalid'),
      true,
    );
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'agentops_panel.adapter_failure_open'),
      true,
    );
  });

  it('does not let a verifier-bound adapter recovery clear the wrong failure evidence', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-promotion-wrong-recovery-target-'));
    const files = sidecarPathsForRunDir(runDir);
    const signer = productionSigner();
    appendProductionFixture(files, signer);
    const failureSubject = { ...subjectFor('adapter:ornith-adapter', 'production'), subjectType: 'adapter' as const };
    const failure = signEvidenceReceipt(createAdapterFailureEvidence({
      subject: failureSubject,
      observedBy: 'test',
      failure: {
        adapterId: 'ornith-adapter',
        providerId: 'local-v1',
        error: 'reasoning-only response',
      },
      createdAt: '2026-06-30T00:01:30.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, failure as unknown as Record<string, unknown>);
    appendAcceptedDissent(files, signer, {
      subject: failureSubject,
      evidenceRef: failure.evidenceId,
      createdAt: '2026-06-30T00:01:30.125Z',
      issuedAt: '2026-06-30T00:01:30.250Z',
      rllAt: '2026-06-30T00:01:30.375Z',
    });
    const wrongFailureId = 'evidence_wrong_failure_id';
    const recoveryPayload = adapterRecoveryBindingPayload({
      adapterId: 'ornith-adapter',
      providerId: 'local-v1',
      modelId: null,
      adapterInstanceId: 'spark4:ornith-adapter',
      adapterVersion: '2026.06.30-wrong-target',
      recoveredBy: 'codex.test',
      verifierAgentId: 'ornith.test',
      identityVerifierAgentId: 'step37.test',
      verifierTrustAnchorRef: 'fleet://ornith/root',
      identityVerifierTrustAnchorRef: 'fleet://step37/root',
      recoveryEvidenceRefs: [failure.evidenceId],
      verificationEvidenceRefs: [failure.evidenceId],
      identityBindingRefs: ['identity:ornith:test', 'identity:step37:test'],
      resolvesEvidenceIds: [wrongFailureId],
      resolvesSubjectIds: [failureSubject.subjectId],
    });
    const unsignedRecovery = createAdapterRecoveryEvidence({
      subject: {
        ...failureSubject,
        verificationStatus: 'independently_verified',
        identityBindingStatus: 'cryptographically_verified',
        verifierTrustAnchorRef: 'fleet://ornith/root',
        verifierAttestationRefs: ['attestation:ornith:runtime'],
        identityVerifierAgentId: 'step37.test',
        identityVerifierTrustAnchorRef: 'fleet://step37/root',
        identityVerifierAttestationRefs: ['attestation:step37:runtime'],
        blocking: false,
      },
      observedBy: 'test',
      recovery: {
        adapterId: 'ornith-adapter',
        providerId: 'local-v1',
        adapterInstanceId: 'spark4:ornith-adapter',
        adapterVersion: '2026.06.30-wrong-target',
        recoveredBy: 'codex.test',
        verifierAgentId: 'ornith.test',
        identityVerifierAgentId: 'step37.test',
        verifierTrustAnchorRef: 'fleet://ornith/root',
        verifierAttestationRefs: ['attestation:ornith:runtime'],
        identityVerifierTrustAnchorRef: 'fleet://step37/root',
        identityVerifierAttestationRefs: ['attestation:step37:runtime'],
        transactionId: stableId('verify_bind_tx', recoveryPayload),
        transactionStatus: 'committed',
        transactionPreparedAt: '2026-06-30T00:01:30.500Z',
        transactionCommittedAt: '2026-06-30T00:01:30.750Z',
        bindingPayloadHash: stableHash(recoveryPayload),
        recoveryEvidenceRefs: [failure.evidenceId],
        verificationEvidenceRefs: [failure.evidenceId],
        identityBindingRefs: ['identity:ornith:test', 'identity:step37:test'],
        resolvesEvidenceIds: [wrongFailureId],
        resolvesSubjectIds: [failureSubject.subjectId],
      },
      createdAt: '2026-06-30T00:01:31.000Z',
    });
    const recovery = signEvidenceReceipt({
      ...unsignedRecovery,
      metadata: {
        ...unsignedRecovery.metadata,
        recovered: true,
        blocking: false,
        independentVerificationSatisfied: true,
        identityBindingStatus: 'cryptographically_verified',
        identityBindingRefs: ['identity:ornith:test', 'identity:step37:test'],
      },
    }, signer);
    appendLedgerEntry(files.evidenceFile, recovery as unknown as Record<string, unknown>);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, false);
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'agentops_panel.adapter_recovery_target_mismatch'),
      true,
    );
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'agentops_panel.adapter_failure_open'),
      true,
    );
  });

  it('allows a verifier-bound adapter recovery to clear a production adapter failure', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-promotion-valid-recovery-'));
    const files = sidecarPathsForRunDir(runDir);
    const signer = productionSigner();
    appendProductionFixture(files, signer);
    const failureSubject = { ...subjectFor('adapter:ornith-adapter', 'production'), subjectType: 'adapter' as const };
    const failure = signEvidenceReceipt(createAdapterFailureEvidence({
      subject: failureSubject,
      observedBy: 'test',
      failure: {
        adapterId: 'ornith-adapter',
        providerId: 'local-v1',
        error: 'reasoning-only response',
      },
      createdAt: '2026-06-30T00:02:00.000Z',
    }), signer);
    appendLedgerEntry(files.evidenceFile, failure as unknown as Record<string, unknown>);
    appendAcceptedDissent(files, signer, {
      subject: failureSubject,
      evidenceRef: failure.evidenceId,
      createdAt: '2026-06-30T00:02:00.125Z',
      issuedAt: '2026-06-30T00:02:00.250Z',
      rllAt: '2026-06-30T00:02:00.375Z',
    });
    const recoveryPayload = adapterRecoveryBindingPayload({
      adapterId: 'ornith-adapter',
      providerId: 'local-v1',
      modelId: null,
      adapterInstanceId: 'spark4:ornith-adapter',
      adapterVersion: '2026.06.30-valid',
      recoveredBy: 'codex.test',
      verifierAgentId: 'ornith.test',
      identityVerifierAgentId: 'step37.test',
      verifierTrustAnchorRef: 'fleet://ornith/root',
      identityVerifierTrustAnchorRef: 'fleet://step37/root',
      recoveryEvidenceRefs: [failure.evidenceId],
      verificationEvidenceRefs: [failure.evidenceId],
      identityBindingRefs: ['identity:ornith:test', 'identity:step37:test'],
      resolvesEvidenceIds: [failure.evidenceId],
      resolvesSubjectIds: [failureSubject.subjectId],
    });
    const unsignedRecovery = createAdapterRecoveryEvidence({
      subject: {
        ...failureSubject,
        verificationStatus: 'independently_verified',
        identityBindingStatus: 'cryptographically_verified',
        verifierTrustAnchorRef: 'fleet://ornith/root',
        verifierAttestationRefs: ['attestation:ornith:runtime'],
        identityVerifierAgentId: 'step37.test',
        identityVerifierTrustAnchorRef: 'fleet://step37/root',
        identityVerifierAttestationRefs: ['attestation:step37:runtime'],
        blocking: false,
      },
      observedBy: 'test',
      recovery: {
        adapterId: 'ornith-adapter',
        providerId: 'local-v1',
        adapterInstanceId: 'spark4:ornith-adapter',
        adapterVersion: '2026.06.30-valid',
        recoveredBy: 'codex.test',
        verifierAgentId: 'ornith.test',
        identityVerifierAgentId: 'step37.test',
        verifierTrustAnchorRef: 'fleet://ornith/root',
        verifierAttestationRefs: ['attestation:ornith:runtime'],
        identityVerifierTrustAnchorRef: 'fleet://step37/root',
        identityVerifierAttestationRefs: ['attestation:step37:runtime'],
        transactionId: stableId('verify_bind_tx', recoveryPayload),
        transactionStatus: 'committed',
        transactionPreparedAt: '2026-06-30T00:02:00.500Z',
        transactionCommittedAt: '2026-06-30T00:02:00.750Z',
        bindingPayloadHash: stableHash(recoveryPayload),
        recoveryEvidenceRefs: [failure.evidenceId],
        verificationEvidenceRefs: [failure.evidenceId],
        identityBindingRefs: ['identity:ornith:test', 'identity:step37:test'],
        resolvesEvidenceIds: [failure.evidenceId],
        resolvesSubjectIds: [failureSubject.subjectId],
      },
      createdAt: '2026-06-30T00:02:01.000Z',
    });
    const recovery = signEvidenceReceipt({
      ...unsignedRecovery,
      metadata: {
        ...unsignedRecovery.metadata,
        recovered: true,
        blocking: false,
        independentVerificationSatisfied: true,
        identityBindingStatus: 'cryptographically_verified',
        identityBindingRefs: ['identity:ornith:test', 'identity:step37:test'],
      },
    }, signer);
    appendLedgerEntry(files.evidenceFile, recovery as unknown as Record<string, unknown>);

    const decision = evaluateProductionPromotion({ runDir });

    assert.equal(decision.allowed, true);
    assert.equal(
      decision.blockers.some((entry) => entry.code === 'agentops_panel.adapter_failure_open'),
      false,
    );
  });
});

function productionSigner(): NonNullable<ReturnType<typeof createSidecarSigner>> {
  return createSidecarSigner({
    enabled: true,
    provider: 'local_ephemeral_ed25519',
    trustLevel: 'operator_bound',
    keyId: 'test-operator-key',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revocationListRef: 'test://revocations/empty',
  })!;
}

function adapterRecoveryBindingPayload(args: {
  readonly adapterId: string;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly adapterInstanceId: string;
  readonly adapterVersion: string;
  readonly recoveredBy: string;
  readonly verifierAgentId: string;
  readonly identityVerifierAgentId: string;
  readonly verifierTrustAnchorRef: string;
  readonly identityVerifierTrustAnchorRef: string;
  readonly recoveryEvidenceRefs: readonly string[];
  readonly verificationEvidenceRefs: readonly string[];
  readonly identityBindingRefs: readonly string[];
  readonly resolvesEvidenceIds: readonly string[];
  readonly resolvesSubjectIds: readonly string[];
}): Record<string, unknown> {
  return {
    schemaVersion: 'superharness.adapter_recovery_binding.v2',
    adapterId: args.adapterId,
    providerId: args.providerId,
    modelId: args.modelId,
    adapterInstanceId: args.adapterInstanceId,
    adapterVersion: args.adapterVersion,
    recoveredBy: args.recoveredBy,
    verifierAgentId: args.verifierAgentId,
    identityVerifierAgentId: args.identityVerifierAgentId,
    verifierTrustAnchorRef: args.verifierTrustAnchorRef,
    identityVerifierTrustAnchorRef: args.identityVerifierTrustAnchorRef,
    recoveryEvidenceRefs: args.recoveryEvidenceRefs,
    verificationEvidenceRefs: args.verificationEvidenceRefs,
    identityBindingRefs: args.identityBindingRefs,
    resolvesEvidenceIds: args.resolvesEvidenceIds,
    resolvesSubjectIds: args.resolvesSubjectIds,
  };
}

function appendProductionFixture(
  files: ReturnType<typeof sidecarPathsForRunDir>,
  signer: NonNullable<ReturnType<typeof createSidecarSigner>>,
): void {
  const subject = subjectFor('task:production-promotion', 'production');
  const evidence = signEvidenceReceipt(createEvidenceReceipt({
    kind: 'human_assertion',
    subject,
    summary: 'production fixture evidence',
    observedBy: 'test',
    content: { ok: true },
    createdAt: '2026-06-30T00:00:00.000Z',
  }), signer);
  appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
  const message = signProtocolMessage(createProtocolMessage({
    kind: 'task_request',
    from: 'codex.test',
    to: ['superharness.control'],
    subject,
    body: { ok: true },
    evidenceRefs: [evidence.evidenceId],
    createdAt: '2026-06-30T00:00:01.000Z',
    epistemics: { status: 'observed', confidence: 1 },
  }), signer);
  appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: 'message_recorded',
    subject,
    status: 'accepted',
    messageId: message.messageId,
    payload: message,
    evidenceRefs: [evidence.evidenceId],
    issuedAt: '2026-06-30T00:00:02.000Z',
  }), signer);
  appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);
  appendAcceptedDissent(files, signer, {
    subject,
    evidenceRef: evidence.evidenceId,
    createdAt: '2026-06-30T00:00:02.500Z',
    issuedAt: '2026-06-30T00:00:02.750Z',
    rllAt: '2026-06-30T00:00:02.900Z',
  });
  const rllEvent = createRllEvent({
    kind: 'observation',
    subject,
    source: 'test',
    summary: 'production observation',
    outputRefs: [evidence.evidenceId, message.messageId, receipt.receiptId],
    createdAt: '2026-06-30T00:00:03.000Z',
    metrics: {},
    confidence: 1,
  });
  appendLedgerEntry(files.rllFile, rllEvent as unknown as Record<string, unknown>);
  const signal = createRllControlSignal({
    action: 'gather_more_evidence',
    subject,
    reason: 'production promotion fixture signal',
    strength: 0.2,
    sourceEventIds: [rllEvent.eventId],
    evidenceRefs: [evidence.evidenceId],
    createdAt: '2026-06-30T00:00:04.000Z',
  });
  appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);
}

function appendAcceptedDissent(
  files: ReturnType<typeof sidecarPathsForRunDir>,
  signer: NonNullable<ReturnType<typeof createSidecarSigner>>,
  args: {
    readonly subject: BcrxSubjectFields;
    readonly evidenceRef: string;
    readonly createdAt: string;
    readonly issuedAt: string;
    readonly rllAt: string;
    readonly from?: string;
  },
): void {
  const dissent = signProtocolMessage(createProtocolMessage({
    kind: 'dissent',
    from: args.from ?? 'adversary.test',
    to: ['superharness.control'],
    subject: args.subject,
    body: {
      stance: 'dissent',
      strongestWeaknesses: ['production promotion requires adversarial pressure'],
      recommendedRepairs: ['keep dissent receipt bound to evidence'],
      evidenceNeeded: [args.evidenceRef],
      residualRisk: 'fixture dissent only proves the gate shape',
    },
    evidenceRefs: [args.evidenceRef],
    createdAt: args.createdAt,
    epistemics: {
      status: 'observed',
      confidence: 0.9,
      dissentRequired: true,
    },
  }), signer);
  appendLedgerEntry(files.protocolMessagesFile, dissent as unknown as Record<string, unknown>);
  const receipt = signProtocolReceipt(createProtocolReceipt({
    receiptType: 'dissent_recorded',
    subject: args.subject,
    status: 'accepted',
    messageId: dissent.messageId,
    payload: dissent,
    evidenceRefs: [args.evidenceRef],
    issuedAt: args.issuedAt,
  }), signer);
  appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);
  const event = createRllEvent({
    kind: 'dissent',
    subject: args.subject,
    source: dissent.from,
    summary: 'accepted production dissent fixture',
    inputRefs: [args.evidenceRef],
    outputRefs: [dissent.messageId, receipt.receiptId],
    createdAt: args.rllAt,
    metrics: { dissent: 1 },
    confidence: 0.9,
  });
  appendLedgerEntry(files.rllFile, event as unknown as Record<string, unknown>);
}

function subjectFor(
  subjectId: string,
  assuranceContext: BcrxSubjectFields['assuranceContext'],
): BcrxSubjectFields {
  return {
    subjectId,
    subjectType: 'task',
    title: subjectId,
    assuranceContext,
    privacyZone: 'WORKSPACE',
    materiality: 'high',
    evidencePolicy: {
      required: true,
      minRefs: 1,
      acceptedKinds: ['human_assertion'],
    },
    dissentPolicy: {
      required: true,
      minDissenters: 1,
      scope: 'material_claims',
    },
    proofPolicy: {
      required: false,
      minProofs: 0,
      acceptedModes: ['not_requested'],
    },
  };
}
