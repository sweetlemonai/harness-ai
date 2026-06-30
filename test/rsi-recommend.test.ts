import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rsiRecommendCommand } from '../src/commands/rsi.ts';
import { createEvidenceReceipt } from '../src/lib/evidence/ledger.ts';
import { appendLedgerEntry, readLedgerEntries } from '../src/lib/protocol/ledger.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import type { BcrxSubjectFields } from '../src/lib/protocol/types.ts';
import {
  createRllControlSignal,
  readRsiIndex,
} from '../src/lib/rll/ledger.ts';
import type { RllEvent } from '../src/lib/rll/types.ts';

describe('RSI recommend', () => {
  it('turns AgentOps control signals into recommend-only RSI candidates', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rsi-recommend-'));
    const files = sidecarPathsForRunDir(runDir);
    const subject = testSubject();
    const evidence = createEvidenceReceipt({
      kind: 'adapter_failure',
      subject,
      summary: 'adapter failed during advisory review',
      observedBy: 'test',
      content: { adapterId: 'local-test', error: 'timeout' },
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const signal = createRllControlSignal({
      action: 'repair_adapter',
      subject,
      reason: 'local-test timed out during advisory review',
      strength: 0.9,
      evidenceRefs: [evidence.evidenceId],
    });
    appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);

    const code = await rsiRecommendCommand({ runDir });
    const candidates = readRsiIndex(files.rsiIndexFile);
    const rll = readLedgerEntries<RllEvent>(files.rllFile);

    assert.equal(code, 0);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0]!.hypothesis, /Repair or replace/);
    assert.deepEqual(candidates[0]!.requiredEvidenceRefs, [evidence.evidenceId]);
    assert.equal(rll.some((entry) => entry.kind === 'rsi_candidate'), true);
  });

  it('collapses duplicate recommendations on repeated runs', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rsi-dedupe-'));
    const files = sidecarPathsForRunDir(runDir);
    const subject = testSubject();
    const evidence = createEvidenceReceipt({
      kind: 'human_assertion',
      subject,
      summary: 'material claim needs adversarial review',
      observedBy: 'test',
      content: { dissentNeeded: true },
    });
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    const signal = createRllControlSignal({
      action: 'request_dissent',
      subject,
      reason: 'material claim needs adversarial review',
      strength: 0.8,
      evidenceRefs: [evidence.evidenceId],
    });
    appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);

    assert.equal(await rsiRecommendCommand({ runDir }), 0);
    assert.equal(await rsiRecommendCommand({ runDir }), 0);

    assert.equal(readRsiIndex(files.rsiIndexFile).length, 1);
  });

  it('skips evidence-free control signals instead of creating candidates', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rsi-skip-'));
    const files = sidecarPathsForRunDir(runDir);
    const signal = createRllControlSignal({
      action: 'gather_more_evidence',
      subject: testSubject(),
      reason: 'unsupported claim needs proof',
      strength: 0.7,
    });
    appendLedgerEntry(files.agentopsEventsFile, signal as unknown as Record<string, unknown>);

    const code = await rsiRecommendCommand({ runDir });
    const rll = readLedgerEntries<RllEvent>(files.rllFile);

    assert.equal(code, 1);
    assert.equal(readRsiIndex(files.rsiIndexFile).length, 0);
    assert.equal(rll.some((entry) => entry.kind === 'failure'), true);
  });
});

function testSubject(): BcrxSubjectFields {
  return {
    subjectId: 'task:rsi-test',
    subjectType: 'task',
    title: 'RSI test task',
    privacyZone: 'WORKSPACE',
    materiality: 'high',
  };
}
