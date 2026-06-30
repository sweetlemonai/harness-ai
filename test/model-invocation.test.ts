import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/lib/config.ts';
import { readLedgerEntries } from '../src/lib/protocol/ledger.ts';
import { resolveHarnessPaths } from '../src/lib/paths.ts';
import { sidecarPathsForRunDir } from '../src/lib/protocol/sidecar.ts';
import { invokeRegisteredModel } from '../src/lib/models/invocation.ts';
import type {
  EventType,
  HarnessConfig,
  Logger,
  RunContext,
  RunPaths,
  TaskPaths,
} from '../src/types.ts';
import type { EvidenceReceipt } from '../src/lib/evidence/types.ts';

describe('registered model invocation', () => {
  it('records adapter failure evidence when exit 0 has no parseable contract', async () => {
    const ctx = testRunContext({
      defaultAdapter: 'fake-malformed',
      adapters: [{
        id: 'fake-malformed',
        kind: 'fake-local',
        args: ['--mode', 'malformed-json'],
      }],
    });

    const result = await invokeRegisteredModel({
      ctx,
      agent: 'codex.test',
      phase: 'build',
      attempt: 1,
      prompt: 'return malformed output',
      timeoutMs: 1000,
    });
    const evidence = readLedgerEntries<EvidenceReceipt>(ctx.runPaths.evidenceFile);

    assert.equal(result.exitCode, 0);
    assert.equal(result.contract, null);
    assert.equal(evidence.some((entry) => (
      entry.kind === 'adapter_failure'
      && entry.summary.includes('without a parseable harness contract')
    )), true);
  });

  it('blocks hosted OpenAI-compatible invocation before network I/O when privacy preflight fails', async () => {
    const previousFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called after privacy block');
    };
    try {
      const ctx = testRunContext({
        defaultAdapter: 'hosted-openai-compatible',
        adapters: [{
          id: 'hosted-openai-compatible',
          kind: 'openai-compatible',
          baseUrl: 'https://hosted.test/v1',
          model: 'hosted-model',
          privacyZone: 'HOSTED_REGIONAL',
        }],
      });

      const result = await invokeRegisteredModel({
        ctx,
        agent: 'codex.test',
        phase: 'build',
        attempt: 1,
        prompt: 'This includes mission gist and private strategy.',
        timeoutMs: 1000,
      });
      const evidence = readLedgerEntries<EvidenceReceipt>(ctx.runPaths.evidenceFile);

      assert.equal(fetchCalled, false);
      assert.equal(result.exitCode, -1);
      assert.match(result.stderr, /privacy preflight blocked/);
      assert.equal(evidence.some((entry) => (
        entry.kind === 'adapter_failure'
        && entry.summary.includes('privacy preflight blocked')
      )), true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

function testRunContext(models: HarnessConfig['models']): RunContext {
  const paths = resolveHarnessPaths();
  const config = {
    ...loadConfig(paths),
    models,
  };
  const runDir = mkdtempSync(join(tmpdir(), 'harness-model-invocation-'));
  const files = sidecarPathsForRunDir(runDir);
  const runPaths: RunPaths = {
    runId: 'test-run',
    runDir,
    stateFile: join(runDir, 'state.json'),
    runMetaFile: join(runDir, 'run.json'),
    eventsFile: join(runDir, 'events.jsonl'),
    logFile: join(runDir, 'harness.log'),
    escalationFile: join(runDir, 'ESCALATION.md'),
    interruptedFile: join(runDir, 'INTERRUPTED.md'),
    snapshotsDir: join(runDir, 'snapshots'),
    promptsDir: join(runDir, 'prompts'),
    outputsDir: join(runDir, 'outputs'),
    reportsDir: join(runDir, 'reports'),
    protocolDir: files.protocolDir,
    evidenceDir: files.evidenceDir,
    receiptsDir: join(runDir, 'receipts'),
    rllDir: files.rllDir,
    codegraphDir: files.codegraphDir,
    protocolMessagesFile: files.protocolMessagesFile,
    protocolReceiptsFile: files.protocolReceiptsFile,
    evidenceFile: files.evidenceFile,
    rllFile: files.rllFile,
    agentopsEventsFile: files.agentopsEventsFile,
    rsiIndexFile: files.rsiIndexFile,
  };
  const taskPaths: TaskPaths = {
    ref: { project: 'test', task: 'model-invocation' },
    taskFile: join(runDir, 'task.md'),
    workspaceDir: join(runDir, 'workspace'),
    e2eDir: join(runDir, 'e2e'),
    runsDir: join(runDir, 'runs'),
    dependencyGraphFile: join(runDir, 'dependency-graph.yml'),
    currentRunSymlink: join(runDir, 'current'),
    lockFile: join(runDir, 'harness.lock'),
  };
  return {
    config,
    paths,
    taskPaths,
    runPaths,
    logger: noopLogger(),
    task: taskPaths.ref,
    branch: 'harness/test',
    taskFrontmatter: {
      type: 'logic',
      hasDesign: false,
      project: 'test',
      depends: [],
    },
    capabilities: null,
    outputs: {},
    flags: {
      ship: false,
      dryRun: false,
      json: false,
    },
    shuttingDown: () => false,
  };
}

function noopLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    event: (_type: EventType, _fields: Record<string, unknown>) => undefined,
    close: async () => undefined,
  };
}
