import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentopsAdviseCommand } from '../src/commands/agentops.ts';
import { readLifecycleReceipts } from '../src/lib/collaboration/localJsonlBus.ts';
import { doctorProtocolSidecars } from '../src/lib/protocol/doctor.ts';
import { readLedgerEntries } from '../src/lib/protocol/ledger.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import type { EvidenceReceipt } from '../src/lib/evidence/types.ts';
import type { ProtocolMessage } from '../src/lib/protocol/types.ts';
import type { RllEvent } from '../src/lib/rll/types.ts';

describe('AgentOps advisory panel', () => {
  it('invokes V1-derived local models and records evidence-bound dissent', async () => {
    const restoreFetch = mockChatFetch('ornith-test', () => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                stance: 'dissent',
                strongest_weaknesses: ['missing independent verifier'],
                recommended_repairs: ['assign verifier from policy registry'],
                evidence_needed: ['verifier receipt'],
                residual_risk: 'identity binding remains alpha-only',
                confidence: 0.88,
              }),
            },
          },
        ],
        usage: { completion_tokens: 42 },
      },
    }));
    try {
      const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-advise-'));
      const v1File = writeV1Snapshot('http://agentops.test', 'ornith-test');

      const code = await agentopsAdviseCommand({
        runDir,
        prompt: 'Review the harness plan for groupthink and BCRX gaps.',
        v1CatalogFile: v1File,
        minDissenters: 1,
        timeoutMs: 1000,
      });

      const files = sidecarPathsForRunDir(runDir);
      const evidence = readLedgerEntries<EvidenceReceipt>(files.evidenceFile);
      const messages = readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile);
      const rll = readLedgerEntries<RllEvent>(files.rllFile);
      const lifecycleReceipts = readLifecycleReceipts(runDir);

      assert.equal(code, 0);
      assert.equal(evidence.some((entry) => entry.kind === 'model_output'), true);
      assert.equal(messages.some((entry) => entry.kind === 'dissent'), true);
      assert.equal(rll.some((entry) => entry.kind === 'dissent'), true);
      assert.equal(lifecycleReceipts.some((entry) => entry.kind === 'read'), true);
      assert.equal(lifecycleReceipts.some((entry) => entry.kind === 'completed'), true);
    } finally {
      restoreFetch();
    }
  });

  it('records reasoning-only responses as adapter failures', async () => {
    const restoreFetch = mockChatFetch('deepseek-test', () => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              reasoning: 'private reasoning with no final answer',
            },
          },
        ],
      },
    }));
    try {
      const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-reasoning-only-'));
      const v1File = writeV1Snapshot('http://agentops.test', 'deepseek-test');

      const code = await agentopsAdviseCommand({
        runDir,
        prompt: 'Review the harness plan and return final JSON.',
        v1CatalogFile: v1File,
        minDissenters: 1,
        timeoutMs: 1000,
      });

      const files = sidecarPathsForRunDir(runDir);
      const evidence = readLedgerEntries<EvidenceReceipt>(files.evidenceFile);
      const messages = readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile);
      const rll = readLedgerEntries<RllEvent>(files.rllFile);
      const lifecycleReceipts = readLifecycleReceipts(runDir);

      assert.equal(code, 1);
      assert.equal(evidence.some((entry) => entry.kind === 'adapter_failure'), true);
      assert.equal(
        evidence.some((entry) => JSON.stringify(entry).includes('private reasoning')),
        false,
      );
      assert.equal(messages.some((entry) => entry.kind === 'adapter_failure'), true);
      assert.equal(rll.some((entry) => entry.kind === 'failure'), true);
      assert.equal(lifecycleReceipts.some((entry) => entry.kind === 'read'), true);
      assert.equal(lifecycleReceipts.some((entry) => entry.kind === 'failed'), true);
    } finally {
      restoreFetch();
    }
  });

  it('uses the upstream-advertised request model after alias validation', async () => {
    const restoreFetch = mockChatFetch('provider-model', () => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                stance: 'dissent',
                strongest_weaknesses: ['alias handling must use upstream model id'],
                recommended_repairs: ['select the first candidate advertised by /v1/models'],
                evidence_needed: ['chat request body'],
                residual_risk: 'low',
                confidence: 0.9,
              }),
            },
          },
        ],
      },
    }));
    try {
      const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-alias-'));
      const v1File = writeV1Snapshot('http://agentops.test', 'v1-model', {
        hfModelId: 'hf-model',
        providerModelId: 'provider-model',
      });

      const code = await agentopsAdviseCommand({
        runDir,
        prompt: 'Review alias handling.',
        v1CatalogFile: v1File,
        minDissenters: 1,
        timeoutMs: 1000,
      });

      assert.equal(code, 0);
    } finally {
      restoreFetch();
    }
  });

  it('does not count unstructured keyword matches as evidence-bound dissent', async () => {
    const restoreFetch = mockChatFetch('ornith-test', () => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: 'This has a material weakness and should not survive, but it is not JSON.',
            },
          },
        ],
      },
    }));
    try {
      const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-unstructured-dissent-'));
      const v1File = writeV1Snapshot('http://agentops.test', 'ornith-test');

      const code = await agentopsAdviseCommand({
        runDir,
        prompt: 'Review dissent parsing.',
        v1CatalogFile: v1File,
        minDissenters: 1,
        timeoutMs: 1000,
      });

      const files = sidecarPathsForRunDir(runDir);
      const messages = readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile);

      assert.equal(code, 1);
      assert.equal(messages.some((entry) => entry.kind === 'dissent'), false);
    } finally {
      restoreFetch();
    }
  });

  it('does not count dissent JSON without weakness, repair, and evidence fields', async () => {
    const restoreFetch = mockChatFetch('ornith-test', () => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                stance: 'dissent',
                strongest_weaknesses: [],
                recommended_repairs: [],
                evidence_needed: [],
                residual_risk: '',
                confidence: 0.8,
              }),
            },
          },
        ],
      },
    }));
    try {
      const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-empty-dissent-'));
      const v1File = writeV1Snapshot('http://agentops.test', 'ornith-test');

      const code = await agentopsAdviseCommand({
        runDir,
        prompt: 'Review empty dissent parsing.',
        v1CatalogFile: v1File,
        minDissenters: 1,
        timeoutMs: 1000,
      });

      const files = sidecarPathsForRunDir(runDir);
      const evidence = readLedgerEntries<EvidenceReceipt>(files.evidenceFile);
      const messages = readLedgerEntries<ProtocolMessage>(files.protocolMessagesFile);

      assert.equal(code, 1);
      assert.equal(messages.some((entry) => entry.kind === 'dissent'), false);
      assert.equal(JSON.stringify(evidence).includes('dissent_missing_required_fields'), true);
    } finally {
      restoreFetch();
    }
  });

  it('rejects production advisory before invocation when no production signer is configured', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-prod-nosigner-'));
    const v1File = writeV1Snapshot('http://agentops.test', 'ornith-test');
    const previousCwd = process.cwd();
    const repoRoot = mkdtempSync(join(tmpdir(), 'harness-agentops-nosigner-root-'));

    try {
      process.chdir(repoRoot);
      await assert.rejects(() => agentopsAdviseCommand({
        runDir,
        prompt: 'Production review must have lifecycle signing.',
        v1CatalogFile: v1File,
        minDissenters: 1,
        timeoutMs: 1000,
        assuranceContext: 'production',
      }), /production AgentOps advisory requires a configured sidecar signer/);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('rejects production advisory when only a legacy config panel is available', async () => {
    const previousCwd = process.cwd();
    const repoRoot = mkdtempSync(join(tmpdir(), 'harness-agentops-prod-config-panel-root-'));
    const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-prod-config-panel-'));
    const configPath = join(repoRoot, 'fleet.json');
    writeFileSync(configPath, JSON.stringify({
      panel: [{
        name: 'legacy-config-only',
        endpoint: 'http://agentops.test',
        model: 'legacy-model',
      }],
    }), 'utf8');

    try {
      writeProductionSigningConfig(repoRoot);
      process.chdir(repoRoot);
      await assert.rejects(() => agentopsAdviseCommand({
        runDir,
        prompt: 'Production review must use V1 inventory.',
        configPath,
        minDissenters: 1,
        timeoutMs: 1000,
        assuranceContext: 'production',
      }), /requires a V1 model inventory source/);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('records production advisory sidecars with signing lifecycle metadata', async () => {
    const restoreFetch = mockChatFetch('ornith-test', () => ({
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                stance: 'dissent',
                strongest_weaknesses: ['production signatures need lifecycle metadata'],
                recommended_repairs: ['load operator-bound signer from strict config'],
                evidence_needed: ['production sidecar doctor report'],
                residual_risk: 'external signer custody still needs deployment proof',
                confidence: 0.91,
              }),
            },
          },
        ],
      },
    }));
    const previousCwd = process.cwd();
    const repoRoot = mkdtempSync(join(tmpdir(), 'harness-agentops-prod-root-'));
    try {
      writeProductionSigningConfig(repoRoot);
      process.chdir(repoRoot);
      const runDir = mkdtempSync(join(tmpdir(), 'harness-agentops-prod-signed-'));
      const v1File = writeV1Snapshot('http://agentops.test', 'ornith-test');

      const code = await agentopsAdviseCommand({
        runDir,
        prompt: 'Production review must have lifecycle signing.',
        v1CatalogFile: v1File,
        minDissenters: 1,
        timeoutMs: 1000,
        assuranceContext: 'production',
      });

      const files = sidecarPathsForRunDir(runDir);
      const evidence = readLedgerEntries<EvidenceReceipt>(files.evidenceFile);
      const report = doctorProtocolSidecars({ runDir, auditMode: 'full', profile: 'production' });

      assert.equal(code, 0);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]!.signature.keyId, 'agentops-test-key');
      assert.equal(evidence[0]!.signature.expiresAt, '2099-01-01T00:00:00.000Z');
      assert.equal(evidence[0]!.signature.revocationListRef, 'test://revocations/agentops');
      assert.equal(report.ok, true);
      assert.equal(report.report.issues.some((entry) => entry.severity === 'error'), false);
    } finally {
      process.chdir(previousCwd);
      restoreFetch();
    }
  });
});

function mockChatFetch(
  modelId: string,
  chatHandler: () => {
    readonly status: number;
    readonly body: unknown;
  },
) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'http://agentops.test/v1/models') {
      assert.equal(init?.method, 'GET');
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: modelId }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    assert.equal(String(input), 'http://agentops.test/v1/chat/completions');
    assert.equal(init?.method, 'POST');
    const body = typeof init?.body === 'string' ? init.body : '';
    assert.ok(body.includes('Return JSON only'));
    assert.equal((JSON.parse(body) as { readonly model?: unknown }).model, modelId);
    const result = chatHandler();
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function writeV1Snapshot(
  baseUrl: string,
  modelId: string,
  aliases: {
    readonly hfModelId?: string;
    readonly providerModelId?: string;
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-agentops-v1-'));
  const file = join(dir, 'models.json');
  writeFileSync(file, JSON.stringify({
    object: 'list',
    data: [
      {
        id: modelId,
        provider_model_id: aliases.providerModelId ?? modelId,
        ...(aliases.hfModelId !== undefined ? { hf_model_id: aliases.hfModelId } : {}),
        node_id: `${modelId}-node`,
        upstream: baseUrl,
        source: 'test_inventory',
        hot_memory: true,
      },
    ],
  }), 'utf8');
  return file;
}

function writeProductionSigningConfig(repoRoot: string): void {
  const harnessDir = join(repoRoot, 'harness');
  mkdirSync(harnessDir, { recursive: true });
  const keyPair = generateKeyPairSync('ed25519');
  const privateKeyFile = join(repoRoot, 'operator-ed25519.pem');
  writeFileSync(privateKeyFile, keyPair.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }), 'utf8');
  writeFileSync(join(harnessDir, 'config.local.json'), JSON.stringify({
    proofs: {
      signing: {
        enabled: true,
        provider: 'local_operator_file_ed25519',
        trustLevel: 'operator_bound',
        privateKeyFile,
        keyId: 'agentops-test-key',
        expiresAt: '2099-01-01T00:00:00.000Z',
        revocationListRef: 'test://revocations/agentops',
        revokedKeyIds: [],
      },
    },
  }), 'utf8');
}
