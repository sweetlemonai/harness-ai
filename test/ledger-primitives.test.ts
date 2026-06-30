import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvidenceRef,
  createEvidenceRef,
  verifyEvidenceLedger,
} from '../src/lib/evidence/ledger.ts';
import {
  createReceipt,
  verifyReceiptChain,
} from '../src/lib/protocol/receipts.ts';
import { createScopeRef } from '../src/lib/protocol/scope.ts';
import {
  appendRllEvent,
  createRllEventDraft,
  verifyRllLedger,
} from '../src/lib/rll/ledger.ts';
import type { AgentIdentity } from '../src/types.ts';

const actor: AgentIdentity = {
  agentId: 'codex.local',
  kind: 'codex',
  displayName: 'Codex',
};

describe('v2 ledger primitives', () => {
  it('appends evidence refs and detects tampering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-evidence-'));
    const path = join(dir, 'evidence.jsonl');
    const ref = createEvidenceRef({
      kind: 'command',
      uri: 'command:npm-run-typecheck',
      producedBy: actor,
      content: { exitCode: 0, stdout: 'ok' },
      command: ['npm', 'run', 'typecheck'],
      exitCode: 0,
      observedAt: '2026-06-30T00:00:00.000Z',
    });

    const entry = appendEvidenceRef(path, ref);
    assert.equal(verifyEvidenceLedger(path).ok, true);

    const tampered = readFileSync(path, 'utf8').replace(entry.ref.uri, 'command:tampered');
    writeFileSync(path, tampered, 'utf8');
    assert.equal(verifyEvidenceLedger(path).ok, false);
  });

  it('validates receipt ids and previous receipt ordering', () => {
    const evidence = createEvidenceRef({
      kind: 'human_observation',
      uri: 'observation:test',
      producedBy: actor,
      content: 'receipt test',
      observedAt: '2026-06-30T00:00:00.000Z',
    });
    const sent = createReceipt({
      kind: 'sent',
      subjectId: 'message-1',
      issuer: actor,
      evidenceRefs: [evidence],
      issuedAt: '2026-06-30T00:00:01.000Z',
    });
    const delivered = createReceipt({
      kind: 'delivered',
      subjectId: 'message-1',
      issuer: actor,
      evidenceRefs: [evidence],
      previousReceiptId: sent.receiptId,
      issuedAt: '2026-06-30T00:00:02.000Z',
    });

    assert.equal(verifyReceiptChain([sent, delivered]).ok, true);
    assert.equal(verifyReceiptChain([delivered, sent]).ok, false);
  });

  it('appends RLL events and detects hash-chain edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-rll-'));
    const path = join(dir, 'rll.jsonl');
    const scope = createScopeRef({
      runId: 'run-1',
      workspaceId: 'workspace-1',
      privacyZone: 'WORKSPACE',
      visibility: 'internal',
    });

    appendRllEvent(path, createRllEventDraft({
      runId: 'run-1',
      nodeId: 'node-a',
      eventType: 'adapter.invocation.started',
      actor,
      subjectType: 'adapter',
      subjectId: 'adapter-1',
      payloadSummary: 'adapter invocation started',
      privacyZone: 'WORKSPACE',
      scope,
      visibility: 'internal',
      timestamp: '2026-06-30T00:00:00.000Z',
    }));
    appendRllEvent(path, createRllEventDraft({
      runId: 'run-1',
      nodeId: 'node-a',
      eventType: 'adapter.invocation.completed',
      actor,
      subjectType: 'adapter',
      subjectId: 'adapter-1',
      payloadSummary: 'adapter invocation completed',
      privacyZone: 'WORKSPACE',
      scope,
      visibility: 'internal',
      timestamp: '2026-06-30T00:00:01.000Z',
    }));

    assert.equal(verifyRllLedger(path).ok, true);
    appendFileSync(path, '\n', 'utf8');
    assert.equal(verifyRllLedger(path).ok, true);

    const tampered = readFileSync(path, 'utf8').replace('completed', 'altered');
    writeFileSync(path, tampered, 'utf8');
    assert.equal(verifyRllLedger(path).ok, false);
  });
});
