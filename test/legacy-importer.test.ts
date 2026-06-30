import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importLegacySource,
  scanLegacySource,
  type LegacySourceManifest,
} from '../src/lib/legacy/importer.ts';
import {
  readBusEnvelopes,
  readLifecycleReceipts,
} from '../src/lib/collaboration/localJsonlBus.ts';
import { doctorProtocol } from '../src/lib/protocol/doctor.ts';

describe('legacy BCRX/VCRX importer', () => {
  it('scans legacy sources without minting canonical records when manifest is absent', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'harness-legacy-scan-'));
    writeFileSync(join(sourceDir, 'handoff.md'), '# Legacy handoff\n', 'utf8');

    const scan = scanLegacySource({ path: sourceDir, kind: 'bcrx_v1' });

    assert.equal(scan.exists, true);
    assert.equal(scan.fileCount, 1);
    assert.equal(scan.canImportCanonically, false);
    assert.match(scan.reason ?? '', /manifest/);
  });

  it('imports manifest-approved legacy files as lossy v2 artifacts only', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'harness-legacy-import-src-'));
    const runDir = mkdtempSync(join(tmpdir(), 'harness-legacy-import-run-'));
    writeFileSync(join(sourceDir, 'handoff.md'), '# Legacy handoff\nClaude says ok\n', 'utf8');
    const manifest: LegacySourceManifest = {
      manifestVersion: 'superharness.legacy_source_manifest.v1',
      sourceId: 'legacy-test',
      kind: 'bcrx_v1',
      sourcePath: sourceDir,
      approvedBy: 'operator.test',
      approvedAt: '2026-06-30T00:00:00.000Z',
      sourceAgentId: 'bcrx.legacy',
      targetAgentId: 'codex.import',
    };

    const result = importLegacySource({
      runDir,
      path: sourceDir,
      kind: 'bcrx_v1',
      manifest,
    });

    assert.equal(result.lossy, true);
    assert.deepEqual(result.unavailableLegacyStates, ['delivery', 'read', 'acceptance']);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.envelopes.length, 1);
    assert.deepEqual(result.envelopes[0]?.requiredReceipts, ['delivered']);
    assert.equal(
      doctorProtocol({
        messages: readBusEnvelopes(runDir),
        receipts: readLifecycleReceipts(runDir),
      }).ok,
      true,
    );
  });
});
