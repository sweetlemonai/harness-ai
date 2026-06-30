import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentopsGraphCommand } from '../src/commands/agentops.ts';
import { modelsListCommand } from '../src/commands/models.ts';
import { protocolReplayCommand } from '../src/commands/protocol.ts';
import { rsiRebuildCommand } from '../src/commands/rsi.ts';
import { sendBusMessage, localJsonlInboxUri } from '../src/lib/collaboration/localJsonlBus.ts';
import { createEvidenceReceipt } from '../src/lib/evidence/ledger.ts';
import type { EvidenceReceipt } from '../src/lib/evidence/types.ts';
import { appendLedgerEntry, readLedgerEntries } from '../src/lib/protocol/ledger.ts';
import { createProtocolMessage } from '../src/lib/protocol/messages.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import type { BcrxSubjectFields, ProtocolMessage } from '../src/lib/protocol/types.ts';
import { createRllEvent } from '../src/lib/rll/ledger.ts';
import type { RllControlSignal, RllEvent, RsiCandidate } from '../src/lib/rll/types.ts';

const subject: BcrxSubjectFields = {
  subjectId: 'task:spec-surface',
  subjectType: 'task',
  title: 'spec surface test',
  assuranceContext: 'alpha',
  privacyZone: 'WORKSPACE',
  materiality: 'high',
  evidencePolicy: {
    required: true,
    minRefs: 1,
    acceptedKinds: ['human_assertion', 'adapter_failure'],
  },
};

describe('spec command surface', () => {
  it('lists configured model adapters', async () => {
    const output = await captureStdout(() => modelsListCommand({ json: true }));
    const parsed = JSON.parse(output) as { adapters: Array<{ id: string }> };

    assert.equal(parsed.adapters.some((entry) => entry.id === 'claude-cli-v1'), true);
    assert.equal(parsed.adapters.some((entry) => entry.id === 'fake-local-v1'), true);
  });

  it('replays committed bus transactions', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-spec-replay-'));
    sendBusMessage({
      runDir,
      from: { agentId: 'codex.test', kind: 'codex' },
      to: [{ agentId: 'claude.test', inboxUri: localJsonlInboxUri('claude.test'), required: true }],
      intent: 'question',
      body: { contentType: 'text/plain', text: 'hello' },
      idempotencyKey: 'spec-surface-replay',
    });

    const output = await captureStdout(() => protocolReplayCommand({ runDir, json: true }));
    const parsed = JSON.parse(output) as { counts: { busTransactions: number; timeline: number } };

    assert.equal(parsed.counts.busTransactions, 1);
    assert.equal(parsed.counts.timeline > 0, true);
  });

  it('builds an AgentOps graph from sidecar messages and evidence', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-spec-graph-'));
    const files = sidecarPathsForRunDir(runDir);
    const evidence = appendLedgerEntry(
      files.evidenceFile,
      createEvidenceReceipt({
        kind: 'human_assertion',
        subject,
        summary: 'operator supplied graph evidence',
        observedBy: 'test',
        content: { ok: true },
      }) as unknown as Record<string, unknown>,
    ).entry as unknown as EvidenceReceipt;
    const message = createProtocolMessage({
      kind: 'dissent',
      from: 'reviewer.test',
      to: ['codex.test'],
      subject,
      body: { finding: 'needs evidence' },
      evidenceRefs: [evidence.evidenceId],
      epistemics: { status: 'observed', confidence: 1 },
    });
    appendLedgerEntry(files.protocolMessagesFile, message as unknown as Record<string, unknown>);

    const output = await captureStdout(() => agentopsGraphCommand({ runDir, json: true }));
    const parsed = JSON.parse(output) as {
      nodes: Array<{ id: string; kind: string }>;
      edges: Array<{ from: string; to: string; kind: string }>;
    };

    assert.equal(parsed.nodes.some((entry) => entry.id === (message as ProtocolMessage).messageId), true);
    assert.equal(parsed.nodes.some((entry) => entry.id === evidence.evidenceId), true);
    assert.equal(parsed.edges.some((entry) => entry.kind === 'supports'), true);
  });

  it('rebuilds RSI candidates from evidence-backed RLL events', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-spec-rsi-rebuild-'));
    const files = sidecarPathsForRunDir(runDir);
    const evidence = appendLedgerEntry(
      files.evidenceFile,
      createEvidenceReceipt({
        kind: 'adapter_failure',
        subject,
        summary: 'adapter failure evidence',
        observedBy: 'test',
        content: { error: 'timeout' },
      }) as unknown as Record<string, unknown>,
    ).entry as unknown as EvidenceReceipt;
    const event = createRllEvent({
      kind: 'failure',
      subject,
      source: 'test',
      summary: 'adapter timeout during spec surface test',
      outputRefs: [evidence.evidenceId],
      metrics: { adapterFailure: 1 },
      confidence: 1,
    });
    appendLedgerEntry(files.rllFile, event as unknown as Record<string, unknown>);

    const output = await captureStdout(() => rsiRebuildCommand({ runDir, json: true }));
    const parsed = JSON.parse(output) as { appendedSignals: number; candidates: RsiCandidate[] };
    const signals = readLedgerEntries<RllControlSignal>(files.agentopsEventsFile);
    const events = readLedgerEntries<RllEvent>(files.rllFile);

    assert.equal(parsed.appendedSignals, 1);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(signals.length, 1);
    assert.equal(events.some((entry) => entry.kind === 'rsi_candidate'), true);
  });
});

async function captureStdout(fn: () => Promise<number>): Promise<string> {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = original;
  }
}
