import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ackBusMessage,
  ackBusMessageWithRead,
  auditBusProjections,
  localJsonlInboxUri,
  readBusEnvelopes,
  readBusTransactions,
  readInbox,
  readLifecycleReceipts,
  sendBusMessage,
} from '../src/lib/collaboration/localJsonlBus.ts';
import { appendLedgerEntry } from '../src/lib/protocol/ledger.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import { doctorProtocol } from '../src/lib/protocol/doctor.ts';

describe('local JSONL collaboration bus', () => {
  it('distinguishes delivered, read, and accepted receipts', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-'));
    const sent = sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'task.request',
      body: { contentType: 'text/plain', text: 'please review this' },
      createdAt: '2026-06-30T00:00:00.000Z',
      idempotencyKey: 'idem:test-bus',
    });

    assert.equal(sent.duplicate, false);
    assert.equal(sent.deliveredReceipts.length, 1);
    assert.equal(readInbox({ runDir, agentId: 'claude.test' }).messages.length, 1);
    assert.equal(
      doctorProtocol({
        messages: readBusEnvelopes(runDir),
        receipts: readLifecycleReceipts(runDir),
      }).ok,
      false,
    );

    const inbox = readInbox({ runDir, agentId: 'claude.test', markRead: true });
    assert.equal(inbox.readReceipts.length, 1);
    const accepted = ackBusMessage({
      runDir,
      agent: { agentId: 'claude.test', kind: 'claude' },
      messageId: sent.envelope.messageId,
      kind: 'accepted',
    });

    assert.equal(accepted.duplicate, false);
    assert.equal(
      doctorProtocol({
        messages: readBusEnvelopes(runDir),
        receipts: readLifecycleReceipts(runDir),
      }).ok,
      true,
    );
    assert.equal(
      doctorProtocol({
        messages: readBusEnvelopes(runDir),
        receipts: readLifecycleReceipts(runDir),
        profile: 'production',
      }).ok,
      true,
    );
  });

  it('dedupes retry-safe send, read, and ack operations', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-dedupe-'));
    const first = sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'question',
      body: { contentType: 'text/plain', text: 'same message' },
      createdAt: '2026-06-30T00:00:00.000Z',
      idempotencyKey: 'idem:dedupe',
    });
    const retry = sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'question',
      body: { contentType: 'text/plain', text: 'same message' },
      createdAt: '2026-06-30T00:00:01.000Z',
      idempotencyKey: 'idem:dedupe',
    });

    assert.equal(retry.duplicate, true);
    assert.equal(retry.envelope.messageId, first.envelope.messageId);
    assert.equal(readInbox({ runDir, agentId: 'claude.test', markRead: true }).readReceipts.length, 1);
    assert.equal(readInbox({ runDir, agentId: 'claude.test', markRead: true }).readReceipts.length, 1);
    assert.equal(ackBusMessage({
      runDir,
      agent: { agentId: 'claude.test', kind: 'claude' },
      messageId: first.envelope.messageId,
      kind: 'accepted',
    }).duplicate, false);
    assert.equal(ackBusMessage({
      runDir,
      agent: { agentId: 'claude.test', kind: 'claude' },
      messageId: first.envelope.messageId,
      kind: 'accepted',
    }).duplicate, true);
  });

  it('can commit read and semantic ack in one transaction', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-read-ack-'));
    const sent = sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('ornith.test')],
      intent: 'review.request',
      body: { contentType: 'text/plain', text: 'review after processing' },
      idempotencyKey: 'idem:read-ack',
    });

    const accepted = ackBusMessageWithRead({
      runDir,
      agent: { agentId: 'ornith.test', kind: 'local_model' },
      messageId: sent.envelope.messageId,
      kind: 'accepted',
    });
    const transaction = readBusTransactions(runDir).find((entry) =>
      entry.type === 'ack'
      && entry.agentId === 'ornith.test'
      && entry.receipts.some((receipt) => receipt.kind === 'read')
      && entry.receipts.some((receipt) => receipt.kind === 'accepted'),
    );

    assert.equal(accepted.duplicate, false);
    assert.ok(transaction);
    assert.deepEqual(transaction.receipts.map((receipt) => receipt.kind), ['read', 'accepted']);
  });

  it('binds delivered receipts to each recipient', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-delivered-recipients-'));
    const sent = sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [
        reachableRecipient('ornith.test'),
        reachableRecipient('deepseek.test'),
      ],
      intent: 'review.request',
      body: { contentType: 'text/plain', text: 'multi-recipient review' },
      idempotencyKey: 'idem:multi-recipient',
    });
    const delivered = sent.deliveredReceipts;

    assert.equal(delivered.length, 2);
    assert.equal(new Set(delivered.map((receipt) => receipt.receiptId)).size, 2);
    assert.deepEqual(
      delivered.map((receipt) => receipt.recipient?.agentId).sort(),
      ['deepseek.test', 'ornith.test'],
    );
    assert.equal(
      readBusTransactions(runDir).flatMap((entry) => entry.receipts).some((receipt) => receipt.receiptId === delivered[0]!.receiptId),
      true,
    );
  });

  it('records undeliverable instead of delivered when a recipient has no reachable inbox', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-missing-recipient-'));
    const sent = sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [{ agentId: 'claude.missing', required: true }],
      intent: 'review.request',
      body: { contentType: 'text/plain', text: 'this recipient has no registered inbox' },
      idempotencyKey: 'idem:missing-recipient',
    });

    assert.equal(sent.deliveredReceipts.length, 0);
    assert.equal(sent.undeliverableReceipts.length, 1);
    assert.equal(sent.undeliverableReceipts[0]?.recipient?.agentId, 'claude.missing');
    assert.equal(readInbox({ runDir, agentId: 'claude.missing' }).messages.length, 0);
    assert.equal(
      readLifecycleReceipts(runDir).some((receipt) => receipt.kind === 'undeliverable'),
      true,
    );
    assert.equal(
      doctorProtocol({
        messages: readBusEnvelopes(runDir),
        receipts: readLifecycleReceipts(runDir),
      }).issues.some((entry) => entry.code === 'protocol.required_receipt_missing'),
      true,
    );
  });

  it('ignores uncommitted projection files until a bus transaction exists', () => {
    const sourceRunDir = mkdtempSync(join(tmpdir(), 'harness-bus-source-'));
    const partialRunDir = mkdtempSync(join(tmpdir(), 'harness-bus-partial-'));
    const sent = sendBusMessage({
      runDir: sourceRunDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'task.request',
      body: { contentType: 'text/plain', text: 'partial write source' },
      idempotencyKey: 'idem:partial-source',
    });
    appendLedgerEntry(
      sidecarPathsForRunDir(partialRunDir).protocolEnvelopesFile,
      sent.envelope as unknown as Record<string, unknown>,
    );

    assert.equal(readBusEnvelopes(partialRunDir).length, 0);
    assert.equal(
      auditBusProjections(partialRunDir).issues.some((entry) => entry.code === 'bus_projection.orphan_envelope'),
      true,
    );
    assert.equal(
      doctorProtocol({
        messages: readBusEnvelopes(partialRunDir),
        receipts: readLifecycleReceipts(partialRunDir),
      }).ok,
      true,
    );
  });

  it('reads committed transactions even when projection files are missing', () => {
    const sourceRunDir = mkdtempSync(join(tmpdir(), 'harness-bus-tx-source-'));
    const transactionOnlyRunDir = mkdtempSync(join(tmpdir(), 'harness-bus-tx-only-'));
    const sent = sendBusMessage({
      runDir: sourceRunDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'task.request',
      body: { contentType: 'text/plain', text: 'transaction is source of truth' },
      requiredReceipts: ['delivered'],
      idempotencyKey: 'idem:transaction-source',
    });
    const transaction = readBusTransactions(sourceRunDir)[0];
    assert.ok(transaction);
    appendLedgerEntry(
      sidecarPathsForRunDir(transactionOnlyRunDir).protocolBusTransactionsFile,
      transaction as unknown as Record<string, unknown>,
    );

    assert.equal(readBusEnvelopes(transactionOnlyRunDir)[0]?.messageId, sent.envelope.messageId);
    assert.equal(readLifecycleReceipts(transactionOnlyRunDir).length, 2);
    assert.equal(
      doctorProtocol({
        messages: readBusEnvelopes(transactionOnlyRunDir),
        receipts: readLifecycleReceipts(transactionOnlyRunDir),
      }).ok,
      true,
    );
  });

  it('detects projection divergence from committed transactions', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-divergent-'));
    sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'task.request',
      body: { contentType: 'text/plain', text: 'projection before drift' },
      idempotencyKey: 'idem:projection-drift',
    });
    const files = sidecarPathsForRunDir(runDir);
    writeFileSync(
      files.protocolEnvelopesFile,
      readFileSync(files.protocolEnvelopesFile, 'utf8').replace('projection before drift', 'projection after drift'),
      'utf8',
    );

    const report = auditBusProjections(runDir);

    assert.equal(report.ok, false);
    assert.equal(
      report.issues.some((entry) => entry.code === 'bus_projection.envelope_diverged'),
      true,
    );
  });

  it('detects committed bus receipt evidence tampering in the production doctor', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-evidence-tamper-'));
    const sent = sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'task.request',
      body: { contentType: 'text/plain', text: 'tamper target' },
      idempotencyKey: 'idem:evidence-tamper',
    });
    ackBusMessageWithRead({
      runDir,
      agent: { agentId: 'claude.test', kind: 'claude' },
      messageId: sent.envelope.messageId,
      kind: 'accepted',
    });
    const files = sidecarPathsForRunDir(runDir);
    const transactions = readBusTransactions(runDir);
    const tampered = {
      ...transactions[0]!,
      receipts: transactions[0]!.receipts.map((receipt, index) => index === 0
        ? {
          ...receipt,
          evidenceRefs: receipt.evidenceRefs.map((ref) => ({
            ...ref,
            sha256: 'not-a-sha',
          })),
        }
        : receipt),
    };
    writeFileSync(files.protocolBusTransactionsFile, `${JSON.stringify(tampered)}\n`, 'utf8');

    const report = doctorProtocol({
      messages: readBusEnvelopes(runDir),
      receipts: readLifecycleReceipts(runDir),
      profile: 'production',
    });

    assert.equal(report.ok, false);
    assert.equal(
      report.issues.some((entry) => entry.code === 'receipt.evidence_ref_sha256_invalid'),
      true,
    );
    assert.equal(
      report.issues.some((entry) => entry.code === 'receipt.signature_hash_mismatch'),
      true,
    );
  });

  it('detects committed bus idempotency replays in production', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-bus-idempotency-replay-'));
    sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'task.request',
      body: { contentType: 'text/plain', text: 'first message' },
      createdAt: '2026-06-30T00:00:00.000Z',
      idempotencyKey: 'idem:replay-source',
    });
    sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [reachableRecipient('claude.test')],
      intent: 'task.request',
      body: { contentType: 'text/plain', text: 'second message' },
      createdAt: '2026-06-30T00:00:01.000Z',
      idempotencyKey: 'idem:replay-other',
    });
    const files = sidecarPathsForRunDir(runDir);
    const transactions = readBusTransactions(runDir);
    const replayed = transactions.map((transaction, index) => index === 1 && transaction.envelope !== undefined
      ? {
        ...transaction,
        envelope: {
          ...transaction.envelope,
          idempotencyKey: 'idem:replay-source',
        },
      }
      : transaction);
    writeFileSync(files.protocolBusTransactionsFile, replayed.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    const report = doctorProtocol({
      messages: readBusEnvelopes(runDir),
      receipts: readLifecycleReceipts(runDir),
      profile: 'production',
    });

    assert.equal(report.ok, false);
    assert.equal(
      report.issues.some((entry) => entry.code === 'protocol.idempotency_replay'),
      true,
    );
    assert.equal(
      report.issues.some((entry) => entry.code === 'protocol.message_id_mismatch'),
      true,
    );
  });
});

function reachableRecipient(agentId: string) {
  return {
    agentId,
    inboxUri: localJsonlInboxUri(agentId),
    required: true,
  };
}
