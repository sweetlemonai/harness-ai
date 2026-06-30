import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProtocolInboxView } from '../src/commands/protocol.ts';
import { createEvidenceReceipt } from '../src/lib/evidence/ledger.ts';
import { appendLedgerEntry } from '../src/lib/protocol/ledger.ts';
import {
  createProtocolMessage,
  createProtocolReceipt,
} from '../src/lib/protocol/messages.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import type { BcrxSubjectFields } from '../src/lib/protocol/types.ts';

describe('protocol inbox view', () => {
  it('includes addressed sidecar protocol messages and receipts', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-protocol-inbox-'));
    const files = sidecarPathsForRunDir(runDir);
    const subject: BcrxSubjectFields = {
      subjectId: 'task:inbox-sidecar-visibility',
      subjectType: 'task',
      title: 'sidecar visibility',
      assuranceContext: 'alpha',
      privacyZone: 'WORKSPACE',
      materiality: 'high',
      evidencePolicy: {
        required: true,
        minRefs: 1,
        acceptedKinds: ['human_assertion'],
      },
    };
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject,
      summary: 'sidecar message should be visible in protocol inbox',
      observedBy: 'test',
      content: { ok: true },
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const message = createProtocolMessage({
      kind: 'dissent',
      from: 'ornith.test',
      to: ['codex.test'],
      subject,
      body: { stance: 'dissent' },
      evidenceRefs: [evidence.evidenceId],
      createdAt: '2026-06-30T00:00:01.000Z',
      epistemics: { status: 'observed', confidence: 0.9, dissentRequired: true },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);
    const receipt = createProtocolReceipt({
      receiptType: 'dissent_recorded',
      subject,
      status: 'accepted',
      messageId: message.messageId,
      payload: message,
      evidenceRefs: [evidence.evidenceId],
      issuedAt: '2026-06-30T00:00:02.000Z',
    });
    appendLedgerEntry(files.protocolReceiptsFile, receipt as unknown as Record<string, unknown>);

    const inbox = readProtocolInboxView({ runDir, agentId: 'codex.test' });

    assert.equal(inbox.messages.length, 0);
    assert.equal(inbox.sidecarMessages.length, 1);
    assert.equal(inbox.sidecarMessages[0]?.messageId, message.messageId);
    assert.equal(inbox.sidecarReceipts.length, 1);
    assert.equal(inbox.sidecarReceipts[0]?.receiptId, receipt.receiptId);
  });
});
