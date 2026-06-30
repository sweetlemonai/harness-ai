import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedgerEntry } from '../src/lib/protocol/ledger.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import { doctorRllSidecars } from '../src/lib/rll/doctor.ts';
import {
  createRllControlSignal,
  createRllEvent,
  createRsiCandidate,
  upsertRsiCandidate,
} from '../src/lib/rll/ledger.ts';
import type { BcrxSubjectFields } from '../src/lib/protocol/types.ts';

const subject: BcrxSubjectFields = {
  subjectId: 'task:rll-doctor-test',
  subjectType: 'task',
  title: 'RLL doctor test',
  privacyZone: 'WORKSPACE',
  materiality: 'high',
};

describe('RLL sidecar doctor', () => {
  it('warns when deterministic RLL control signals have not been projected', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rll-doctor-signal-'));
    const files = sidecarPathsForRunDir(runDir);
    const event = createRllEvent({
      kind: 'failure',
      subject,
      source: 'test.adapter',
      summary: 'adapter failed with 401',
      outputRefs: [],
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    appendLedgerEntry(files.rllFile, event as unknown as Record<string, unknown>);

    const report = doctorRllSidecars({ runDir, auditMode: 'full' });

    assert.equal(report.ok, true);
    assert.equal(report.counts.recommendedSignals, 1);
    assert.equal(report.counts.missingProjectedSignals, 1);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'rll_projection.signal_not_projected'),
      true,
    );
  });

  it('fails when an RSI candidate requires missing evidence', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rll-doctor-evidence-'));
    const files = sidecarPathsForRunDir(runDir);
    const candidate = createRsiCandidate({
      subject,
      hypothesis: 'repair adapter failures before retrying',
      expectedBenefit: 'fewer false green fleet runs',
      risk: 'may slow urgent work',
      requiredEvidenceRefs: ['evidence_missing'],
    });
    upsertRsiCandidate(files.rsiIndexFile, candidate);

    const report = doctorRllSidecars({ runDir, auditMode: 'full' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'rsi_candidate.required_evidence_missing'),
      true,
    );
  });

  it('fails when an RSI candidate is marked applied during alpha', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rll-doctor-applied-'));
    const files = sidecarPathsForRunDir(runDir);
    const candidate = createRsiCandidate({
      subject,
      hypothesis: 'expand task scope from observed failures',
      expectedBenefit: 'task learns from execution traces',
      risk: 'unbounded scope growth without operator review',
    });
    upsertRsiCandidate(files.rsiIndexFile, candidate);
    const raw = JSON.parse(readFileSync(files.rsiIndexFile, 'utf8')) as Array<Record<string, unknown>>;
    writeFileSync(files.rsiIndexFile, `${JSON.stringify(raw.map((entry) => ({
      ...entry,
      status: 'applied',
    })), null, 2)}\n`, 'utf8');

    const report = doctorRllSidecars({ runDir, auditMode: 'full' });

    assert.equal(report.ok, false);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'rsi_candidate.applied_disabled_alpha'),
      true,
    );
  });

  it('does not fail production audit for a single transient opposing correction', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rll-doctor-transient-'));
    const files = sidecarPathsForRunDir(runDir);
    const expand = createRllControlSignal({
      action: 'expand_scope',
      subject,
      reason: 'increase task scope from observation',
      strength: 0.8,
      evidenceRefs: ['evidence_a'],
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    const narrow = createRllControlSignal({
      action: 'narrow_scope',
      subject,
      reason: 'reduce task scope from contradiction',
      strength: 0.8,
      evidenceRefs: ['evidence_b'],
      createdAt: '2026-06-30T00:00:01.000Z',
    });
    appendLedgerEntry(files.agentopsEventsFile, expand as unknown as Record<string, unknown>);
    appendLedgerEntry(files.agentopsEventsFile, narrow as unknown as Record<string, unknown>);

    const report = doctorRllSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.counts.feedbackOscillations, 0);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'rll_feedback.oscillation_detected'),
      false,
    );
  });

  it('fails production audit when RLL control signals repeatedly oscillate for one subject', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-rll-doctor-oscillation-'));
    const files = sidecarPathsForRunDir(runDir);
    const expand = createRllControlSignal({
      action: 'expand_scope',
      subject,
      reason: 'increase task scope from observation',
      strength: 0.8,
      evidenceRefs: ['evidence_a'],
      createdAt: '2026-06-30T00:00:00.000Z',
    });
    const narrow = createRllControlSignal({
      action: 'narrow_scope',
      subject,
      reason: 'reduce task scope from contradiction',
      strength: 0.8,
      evidenceRefs: ['evidence_b'],
      createdAt: '2026-06-30T00:00:01.000Z',
    });
    const expandAgain = createRllControlSignal({
      action: 'expand_scope',
      subject,
      reason: 'increase task scope again without new stability evidence',
      strength: 0.8,
      evidenceRefs: ['evidence_c'],
      createdAt: '2026-06-30T00:00:02.000Z',
    });
    appendLedgerEntry(files.agentopsEventsFile, expand as unknown as Record<string, unknown>);
    appendLedgerEntry(files.agentopsEventsFile, narrow as unknown as Record<string, unknown>);
    appendLedgerEntry(files.agentopsEventsFile, expandAgain as unknown as Record<string, unknown>);

    const report = doctorRllSidecars({ runDir, auditMode: 'full', profile: 'production' });

    assert.equal(report.ok, false);
    assert.equal(report.counts.feedbackOscillations, 1);
    assert.equal(
      report.report.issues.some((entry) => entry.code === 'rll_feedback.oscillation_detected'),
      true,
    );
  });
});
