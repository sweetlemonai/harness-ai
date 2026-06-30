import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  productionBreakGlassCommand,
  productionCanaryCommand,
  productionDoctorCommand,
  productionInitLocalCommand,
} from '../src/commands/production.ts';
import { readLedgerEntries } from '../src/lib/protocol/ledger.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import type { EvidenceReceipt } from '../src/lib/evidence/types.ts';

process.env.HARNESS_IGNORE_LOCAL_CONFIG = '1';

describe('production roadmap commands', () => {
  it('fails closed under default alpha config instead of treating missing trust anchors as ready', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-production-doctor-'));
    const output = await captureStdout(() => productionDoctorCommand({ runDir, json: true }));
    const parsed = JSON.parse(output) as {
      allowed: boolean;
      blockers: Array<{ code: string }>;
      gates: {
        signing: { ok: boolean };
        zkSnarks: { ok: boolean };
        fleet: { ok: boolean };
        commandGroup: { ok: boolean };
      };
    };

    assert.equal(parsed.allowed, false);
    assert.equal(parsed.gates.signing.ok, false);
    assert.equal(parsed.gates.zkSnarks.ok, false);
    assert.equal(parsed.gates.fleet.ok, false);
    assert.equal(parsed.gates.commandGroup.ok, false);
    assert.equal(parsed.blockers.some((entry) => entry.code === 'production.signing_disabled'), true);
    assert.equal(parsed.blockers.some((entry) => entry.code === 'production.v1_witness_missing'), false);
    assert.equal(existsSync(join(runDir, 'production', 'production-readiness.json')), true);
  });

  it('records blocked break-glass attempts as evidence with a machine-parseable receipt', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-break-glass-'));
    const output = await captureStdout(() => productionBreakGlassCommand({
      runDir,
      incidentId: 'INC-123',
      operatorId: 'operator.test',
      reason: 'restore service',
      blastRadius: 'single synthetic test run',
      rollback: 'revert synthetic change',
      json: true,
    }));
    const parsed = JSON.parse(output) as {
      receipt: {
        receiptId: string;
        allowed: boolean;
        blockers: Array<{ code: string }>;
      };
      evidenceId: string;
    };
    const files = sidecarPathsForRunDir(runDir);
    const evidence = readLedgerEntries<EvidenceReceipt>(files.evidenceFile);
    const artifact = JSON.parse(readFileSync(join(runDir, 'production', 'break-glass-INC-123.json'), 'utf8')) as {
      receipt: { receiptId: string };
    };

    assert.equal(parsed.receipt.allowed, false);
    assert.equal(parsed.receipt.blockers.some((entry) => entry.code === 'production.break_glass_signing_missing'), true);
    assert.equal(parsed.receipt.blockers.some((entry) => entry.code === 'production.break_glass_command_group_disabled'), true);
    assert.equal(evidence.some((entry) => entry.evidenceId === parsed.evidenceId), true);
    assert.equal(evidence.some((entry) => entry.metadata.receiptId === parsed.receipt.receiptId), true);
    assert.equal(artifact.receipt.receiptId, parsed.receipt.receiptId);
  });

  it('keeps canary at the configured floor while production blockers or missing telemetry exist', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-production-canary-'));
    const output = await captureStdout(() => productionCanaryCommand({
      runDir,
      currentLevel: 4,
      greenCycles: 3,
      redIssues: 1,
      missingTelemetry: true,
      json: true,
    }));
    const parsed = JSON.parse(output) as {
      allowed: boolean;
      currentLevel: number;
      nextLevel: number;
      controller: {
        reason: string;
        effective: { floor: number; cap: number; stepUp: number };
      };
      blockers: Array<{ code: string }>;
    };

    assert.equal(parsed.allowed, false);
    assert.equal(parsed.currentLevel, 4);
    assert.equal(parsed.nextLevel, parsed.controller.effective.floor);
    assert.equal(parsed.blockers.some((entry) => entry.code === 'production.canary_missing_telemetry'), true);
    assert.equal(parsed.blockers.some((entry) => entry.code === 'production.canary_red_issues'), true);
    assert.equal(existsSync(join(runDir, 'production', 'production-canary-decision.json')), true);
  });

  it('bootstraps a local production profile without weakening package defaults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-production-init-'));
    const catalog = {
      object: 'list',
      data: [
        {
          id: 'local-critic-v1',
          object: 'model',
          hot_memory: true,
          upstream: 'http://127.0.0.1:9001',
          provider_model_id: 'critic-model',
        },
      ],
    };
    const output = await withV1Server(catalog, async (v1ModelsUrl) => captureStdout(() => productionInitLocalCommand({
      v1ModelsUrl,
      operatorId: 'operator.test',
      commandGroupMembers: ['operator.backup'],
      requiredApprovals: 2,
      configLocalFile: join(root, 'config.local.json'),
      fleetConfigFile: join(root, 'fleet.json'),
      witnessCatalogFile: join(root, 'witness.snapshot.json'),
      privateKeyFile: join(root, 'operator.pem'),
      revocationListFile: join(root, 'revocations.json'),
      zkProverFile: join(root, 'local-zk.mjs'),
      keyValidDays: 1,
      timeoutMs: 1000,
      json: true,
    })));
    const parsed = JSON.parse(output) as {
      localOnly: boolean;
      files: {
        configLocalFile: string;
        fleetConfigFile: string;
        witnessCatalogFile: string;
        privateKeyFile: string;
        revocationListFile: string;
        zkProverFile: string;
      };
    };
    const localConfig = JSON.parse(readFileSync(parsed.files.configLocalFile, 'utf8')) as {
      proofs: { signing: { provider: string }; zkSnarks: { defaultBackend: string } };
      production: { fleet: { configPath: string; consensusV1CatalogFiles: string[] }; commandGroup: { members: string[] } };
    };
    const fleetConfig = JSON.parse(readFileSync(parsed.files.fleetConfigFile, 'utf8')) as {
      source: { consensus_files: string[]; min_agreeing_sources: number };
      advisory: { min_dissenters: number };
    };
    const witness = JSON.parse(readFileSync(parsed.files.witnessCatalogFile, 'utf8')) as {
      catalog: { data: Array<{ id: string }> };
    };

    assert.equal(parsed.localOnly, true);
    assert.equal(localConfig.proofs.signing.provider, 'local_operator_file_ed25519');
    assert.equal(localConfig.proofs.zkSnarks.defaultBackend, 'external');
    assert.equal(localConfig.production.fleet.configPath, parsed.files.fleetConfigFile);
    assert.deepEqual(localConfig.production.fleet.consensusV1CatalogFiles, [parsed.files.witnessCatalogFile]);
    assert.equal(localConfig.production.commandGroup.members.includes('local.fleet.critic'), true);
    assert.deepEqual(fleetConfig.source.consensus_files, [parsed.files.witnessCatalogFile]);
    assert.equal(fleetConfig.source.min_agreeing_sources, 2);
    assert.equal(fleetConfig.advisory.min_dissenters, 2);
    assert.equal(witness.catalog.data[0]?.id, 'local-critic-v1');
    assert.equal(readFileSync(parsed.files.privateKeyFile, 'utf8').includes('PRIVATE KEY'), true);
    assert.equal(existsSync(parsed.files.revocationListFile), true);
    assert.equal(existsSync(parsed.files.zkProverFile), true);
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

async function withV1Server<T>(
  payload: unknown,
  fn: (v1ModelsUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/models') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}/v1/models`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
