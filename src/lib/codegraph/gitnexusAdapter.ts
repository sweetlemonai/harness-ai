import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { runCommand } from '../shell.js';
import {
  createCodeGraphReceipt,
  createCommandEvidence,
  createEvidenceRef,
  createFileEvidence,
  createGeneratedFilePolicyEvidence,
  sha256Hex,
  stableId,
  stableStringify,
  UNSIGNED_LOCAL_SIGNATURE,
} from './receipts.js';
import type {
  CodeGraphAdapter,
  CodeGraphAdapterOptions,
  CodeGraphDoctorReport,
  CodeGraphImpactRequest,
  CodeGraphProbeResult,
  CodeGraphQuery,
  CodeGraphQueryRequest,
  CodeGraphRefreshRequest,
  CodeGraphRefreshResult,
  CodeGraphSnapshot,
  CodeGraphTestRequest,
  EvidenceRef,
  ImpactReceipt,
  ScopeRef,
  TestCandidateMap,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GITNEXUS_BIN =
  '/Users/veagent/.openclaw/tools/gitnexus-github/node_modules/.bin/gitnexus';

interface ExecEvidence {
  readonly evidenceRef: EvidenceRef;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export class GitNexusCodeGraphAdapter implements CodeGraphAdapter {
  readonly adapterId = 'gitnexus-adapter-v1';
  readonly providerId = 'gitnexus';

  private readonly gitnexusBin: string | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: CodeGraphAdapterOptions = {}) {
    this.gitnexusBin = options.gitnexusBin ?? process.env.GITNEXUS_BIN;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async probe(scope: ScopeRef): Promise<CodeGraphProbeResult> {
    const resolved = this.resolveGitNexusBinary();
    if (resolved === null) {
      const evidence = createEvidenceRef({
        kind: 'provider_health',
        summary: 'GitNexus binary was not found',
        content: {
          checked: [this.gitnexusBin ?? null, DEFAULT_GITNEXUS_BIN, 'gitnexus'],
          repoRoot: scope.repoRoot,
        },
        createdAt: this.nowIso(),
        uri: 'provider:gitnexus',
      });
      return {
        providerId: this.providerId,
        available: false,
        healthRefs: [evidence],
        unavailableReason: 'gitnexus binary not found',
      };
    }

    const version = await this.runGitNexus(scope.repoRoot, ['--version']);
    if (version.exitCode === 0) {
      return {
        providerId: this.providerId,
        available: true,
        version: firstNonEmptyLine(version.stdout) ?? 'unknown',
        healthRefs: [version.evidenceRef],
      };
    }

    const status = await this.runGitNexus(scope.repoRoot, ['status']);
    const available = status.exitCode === 0;
    return {
      providerId: this.providerId,
      available,
      ...(available ? { version: 'unknown' } : {}),
      healthRefs: [version.evidenceRef, status.evidenceRef],
      ...(available ? {} : { unavailableReason: summarizeFailure(status) }),
    };
  }

  async snapshot(scope: ScopeRef): Promise<CodeGraphSnapshot> {
    const issuedAt = this.nowIso();
    const [probe, status, commit, worktree] = await Promise.all([
      this.probe(scope),
      this.runGitNexus(scope.repoRoot, ['status']),
      runGit(scope.repoRoot, ['rev-parse', 'HEAD'], issuedAt),
      runGit(scope.repoRoot, ['status', '--porcelain=v1'], issuedAt),
    ]);
    const generatedFilePolicyRef = createGeneratedFilePolicyEvidence(issuedAt);
    const sourceRefs = [
      status.evidenceRef,
      commit.evidenceRef,
      worktree.evidenceRef,
      generatedFilePolicyRef,
    ];
    const commitHash = commit.exitCode === 0 ? commit.stdout.trim() : undefined;
    const worktreeStatus = worktree.stdout.trim();
    const dirtyWorktreeState = classifyDirtyState(worktree.exitCode, worktreeStatus);
    const freshness = probe.available && status.exitCode === 0 ? 'fresh' : 'failed';
    const graphHash = sha256Hex(stableStringify({
      providerId: this.providerId,
      statusStdout: status.stdout,
      statusStderr: status.stderr,
      commitHash: commitHash ?? null,
      worktreeStatus,
      freshness,
    }));
    const snapshotId = stableId('codegraph_snapshot', {
      providerId: this.providerId,
      repoRoot: scope.repoRoot,
      graphHash,
      commitHash: commitHash ?? null,
    });
    const receipt = createCodeGraphReceipt({
      receiptType: freshness === 'fresh' ? 'code_graph_snapshot' : 'code_graph_unavailable',
      providerId: this.providerId,
      scope,
      evidenceRefs: sourceRefs,
      issuedAt,
      snapshotId,
      status: freshness,
      publicInputs: {
        snapshotId,
        repoRoot: scope.repoRoot,
        commitHash: commitHash ?? null,
        dirtyWorktreeState,
        graphHash,
        generatedFilePolicy: generatedFilePolicyRef.contentHash,
      },
    });
    return {
      snapshotId,
      providerId: this.providerId,
      repoRoot: scope.repoRoot,
      ...(probe.version !== undefined ? { providerVersion: probe.version } : {}),
      analyzerCommandRef: status.evidenceRef,
      ...(commitHash !== undefined ? { commitHash, indexedCommitHash: commitHash } : {}),
      worktreeHash: sha256Hex(worktreeStatus),
      worktreeStatusRef: worktree.evidenceRef,
      dirtyWorktreeState,
      dirtyWorktreePolicy: 'index_with_overlay',
      generatedFilePolicyRef,
      indexedAt: issuedAt,
      freshness,
      ...(freshness === 'failed' ? { stalenessReason: probe.unavailableReason ?? summarizeFailure(status) } : {}),
      lastRefreshAttemptRef: status.evidenceRef,
      graphHash,
      sourceRefs,
      proofReceiptIds: [],
      receiptId: receipt.receiptId,
    };
  }

  async refresh(input: CodeGraphRefreshRequest): Promise<CodeGraphRefreshResult> {
    const args = ['analyze'];
    if (input.force === true) args.push('--force');
    if (input.sidecarOnly) args.push('--skip-agents-md');
    const refresh = await this.runGitNexus(input.scope.repoRoot, args);
    if (refresh.exitCode !== 0) {
      const receipt = createCodeGraphReceipt({
        receiptType: 'code_graph_refresh_failed',
        providerId: this.providerId,
        scope: input.scope,
        evidenceRefs: [refresh.evidenceRef],
        status: refresh.timedOut ? 'timeout' : 'failed',
        issuedAt: this.nowIso(),
        publicInputs: {
          sidecarOnly: input.sidecarOnly,
          force: input.force ?? false,
          exitCode: refresh.exitCode,
          timedOut: refresh.timedOut,
        },
      });
      return {
        status: this.resolveGitNexusBinary() === null ? 'unavailable' : 'failed',
        receiptId: receipt.receiptId,
        evidenceRefs: [refresh.evidenceRef],
      };
    }
    const snapshot = await this.snapshot(input.scope);
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_snapshot',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: [refresh.evidenceRef, ...snapshot.sourceRefs],
      snapshotId: snapshot.snapshotId,
      status: 'refreshed',
      issuedAt: this.nowIso(),
      publicInputs: {
        sidecarOnly: input.sidecarOnly,
        force: input.force ?? false,
        snapshotId: snapshot.snapshotId,
        refreshEvidence: refresh.evidenceRef.contentHash,
      },
    });
    return {
      snapshotId: snapshot.snapshotId,
      status: 'refreshed',
      receiptId: receipt.receiptId,
      evidenceRefs: [refresh.evidenceRef, ...snapshot.sourceRefs],
    };
  }

  async query(input: CodeGraphQueryRequest): Promise<CodeGraphQuery> {
    const snapshot = await this.snapshot(input.scope);
    const args = this.queryArgs(input.queryKind, input.subject);
    const result = await this.runGitNexus(input.scope.repoRoot, args);
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_query',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: [result.evidenceRef],
      subject: input.subject,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      status: result.exitCode === 0 ? 'completed' : 'degraded',
      issuedAt: this.nowIso(),
      publicInputs: {
        queryKind: input.queryKind,
        subject: input.subject,
        snapshotId: input.snapshotId ?? snapshot.snapshotId,
        resultHash: result.evidenceRef.contentHash,
      },
    });
    return {
      queryId: stableId('codegraph_query', {
        providerId: this.providerId,
        queryKind: input.queryKind,
        subject: input.subject,
        snapshotId: input.snapshotId ?? snapshot.snapshotId,
        resultHash: result.evidenceRef.contentHash,
      }),
      providerId: this.providerId,
      queryKind: input.queryKind,
      subject: input.subject,
      scope: input.scope,
      resultRef: result.evidenceRef,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      confidence: result.exitCode === 0 ? 0.65 : 0.15,
      receiptId: receipt.receiptId,
    };
  }

  async impact(input: CodeGraphImpactRequest): Promise<ImpactReceipt> {
    const snapshot = await this.snapshot(input.scope);
    const result = await this.runGitNexus(input.scope.repoRoot, [
      'impact',
      input.subject,
      '--depth',
      String(input.depth),
    ]);
    const affectedFiles = result.exitCode === 0
      ? extractLikelyPaths(result.stdout)
      : [];
    const subjectRef = createFileEvidence({
      repoRoot: input.scope.repoRoot,
      path: resolve(input.scope.repoRoot, input.subject),
      summary: `impact subject ${input.subject}`,
      createdAt: this.nowIso(),
    });
    const unresolvedEdges = result.exitCode === 0
      ? []
      : [`gitnexus impact unavailable: ${summarizeFailure(result)}`];
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_impact',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: [result.evidenceRef, subjectRef],
      subject: input.subject,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      status: result.exitCode === 0 ? 'completed' : 'degraded',
      issuedAt: this.nowIso(),
      publicInputs: {
        subject: input.subject,
        depth: input.depth,
        snapshotId: input.snapshotId ?? snapshot.snapshotId,
        affectedFiles,
        unresolvedEdges,
      },
    });
    return {
      receiptId: receipt.receiptId,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      scope: input.scope,
      changedSymbols: isLikelyPath(input.subject) ? [] : [input.subject],
      changedPathRefs: [subjectRef],
      affectedCallers: [],
      affectedCallees: [],
      affectedFiles,
      depth: input.depth,
      confidence: result.exitCode === 0 ? 0.55 : 0.1,
      ambiguousMatches: [],
      unresolvedEdges,
      generatedFileExclusions: generatedContextExclusions(),
      reviewerRequired: result.exitCode !== 0 || affectedFiles.length === 0,
      signature: UNSIGNED_LOCAL_SIGNATURE,
    };
  }

  async testCandidates(input: CodeGraphTestRequest): Promise<TestCandidateMap> {
    const snapshot = await this.snapshot(input.scope);
    const result = await this.runGitNexus(input.scope.repoRoot, [
      'tests',
      input.subject,
    ]);
    const testPaths = result.exitCode === 0 ? extractLikelyTestPaths(result.stdout) : [];
    const candidateTests = testPaths.map((path) => ({
      testRef: createFileEvidence({
        repoRoot: input.scope.repoRoot,
        path: resolve(input.scope.repoRoot, path),
        summary: `GitNexus test candidate ${path}`,
        createdAt: this.nowIso(),
      }),
      classification: 'unknown' as const,
      confidence: 0.45,
      historicalFailureRefs: [],
    }));
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_test_mapping',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: [result.evidenceRef, ...candidateTests.map((entry) => entry.testRef)],
      subject: input.subject,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      status: result.exitCode === 0 ? 'completed' : 'degraded',
      issuedAt: this.nowIso(),
      publicInputs: {
        subject: input.subject,
        snapshotId: input.snapshotId ?? snapshot.snapshotId,
        testPaths,
      },
    });
    return {
      mapId: stableId('codegraph_tests', {
        subject: input.subject,
        snapshotId: input.snapshotId ?? snapshot.snapshotId,
        testPaths,
      }),
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      scope: input.scope,
      sourceRefs: [result.evidenceRef],
      candidateTests,
      verificationResultRefs: [],
      receiptId: receipt.receiptId,
    };
  }

  async doctor(scope: ScopeRef): Promise<CodeGraphDoctorReport> {
    const probe = await this.probe(scope);
    const snapshot = await this.snapshot(scope);
    const findings: string[] = [];
    if (!probe.available) findings.push(`GitNexus unavailable: ${probe.unavailableReason ?? 'unknown reason'}`);
    if (snapshot.freshness !== 'fresh') findings.push(`snapshot freshness is ${snapshot.freshness}`);
    if (snapshot.dirtyWorktreeState !== 'clean_indexed') {
      findings.push(`worktree state is ${snapshot.dirtyWorktreeState}; graph confidence is reduced`);
    }
    if (findings.length === 0) findings.push('GitNexus provider is reachable and produced a snapshot receipt');
    const status = !probe.available
      ? 'unavailable'
      : snapshot.freshness === 'fresh' && snapshot.dirtyWorktreeState === 'clean_indexed'
        ? 'healthy'
        : 'degraded';
    const evidenceRefs = [...probe.healthRefs, ...snapshot.sourceRefs];
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_doctor',
      providerId: this.providerId,
      scope,
      evidenceRefs,
      status,
      issuedAt: this.nowIso(),
      publicInputs: {
        status,
        findings,
        snapshotId: snapshot.snapshotId,
      },
    });
    return {
      reportId: stableId('codegraph_doctor', {
        providerId: this.providerId,
        scope,
        status,
        findings,
        receiptId: receipt.receiptId,
      }),
      scope,
      status,
      findings,
      evidenceRefs,
      receiptId: receipt.receiptId,
    };
  }

  async explainFailure(ref: EvidenceRef): Promise<string> {
    return `GitNexus evidence ${ref.evidenceId} is ${ref.summary}. Treat graph-derived claims as degraded until the provider refreshes successfully.`;
  }

  private queryArgs(kind: CodeGraphQuery['queryKind'], subject: string): string[] {
    switch (kind) {
      case 'impact':
        return ['impact', subject, '--depth', '2'];
      case 'test_candidates':
        return ['tests', subject];
      case 'symbol_lookup':
        return ['search', subject];
      case 'callers':
      case 'callees':
      case 'process_trace':
      case 'cluster':
      case 'ownership':
      case 'drift':
        return ['query', kind, subject];
    }
    return assertNever(kind);
  }

  private async runGitNexus(cwd: string, args: readonly string[]): Promise<ExecEvidence> {
    const bin = this.resolveGitNexusBinary();
    if (bin === null) {
      const evidenceRef = createEvidenceRef({
        kind: 'provider_health',
        summary: `gitnexus ${args.join(' ')} unavailable: binary not found`,
        content: { args, cwd, checked: [this.gitnexusBin ?? null, DEFAULT_GITNEXUS_BIN, 'gitnexus'] },
        createdAt: this.nowIso(),
        uri: 'provider:gitnexus',
      });
      return {
        evidenceRef,
        stdout: '',
        stderr: 'gitnexus binary not found',
        exitCode: -1,
        timedOut: false,
      };
    }
    const exec = await runCommand(bin, args, {
      cwd,
      timeoutMs: this.timeoutMs,
      env: {
        ...process.env,
        GITNEXUS_NO_GENERATED_OUTPUT: '1',
        GITNEXUS_SIDECAR_ONLY: '1',
      },
    });
    return {
      evidenceRef: createCommandEvidence({
        command: bin,
        argv: args,
        cwd,
        exitCode: exec.exitCode,
        stdout: exec.stdout,
        stderr: exec.stderr,
        timedOut: exec.timedOut,
        durationMs: exec.durationMs,
        createdAt: this.nowIso(),
      }),
      stdout: exec.stdout,
      stderr: exec.stderr,
      exitCode: exec.exitCode,
      timedOut: exec.timedOut,
    };
  }

  private resolveGitNexusBinary(): string | null {
    const candidates = [
      this.gitnexusBin,
      DEFAULT_GITNEXUS_BIN,
      'gitnexus',
    ].filter((entry): entry is string => entry !== undefined && entry.length > 0);

    for (const candidate of candidates) {
      if (isAbsolute(candidate)) {
        if (existsSync(candidate)) return candidate;
        continue;
      }
      if (candidate.includes('/')) {
        const full = resolve(candidate);
        if (existsSync(full)) return full;
        continue;
      }
      return candidate;
    }
    return null;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

async function runGit(cwd: string, args: readonly string[], createdAt: string): Promise<ExecEvidence> {
  const exec = await runCommand('git', args, {
    cwd,
    timeoutMs: 10_000,
  });
  return {
    evidenceRef: createCommandEvidence({
      command: 'git',
      argv: args,
      cwd,
      exitCode: exec.exitCode,
      stdout: exec.stdout,
      stderr: exec.stderr,
      timedOut: exec.timedOut,
      durationMs: exec.durationMs,
      createdAt,
    }),
    stdout: exec.stdout,
    stderr: exec.stderr,
    exitCode: exec.exitCode,
    timedOut: exec.timedOut,
  };
}

function classifyDirtyState(exitCode: number, status: string): CodeGraphSnapshot['dirtyWorktreeState'] {
  if (exitCode !== 0) return 'unknown';
  if (status.length === 0) return 'clean_indexed';
  return 'dirty_indexed_with_overlay';
}

function summarizeFailure(result: ExecEvidence): string {
  const source = `${result.stderr}\n${result.stdout}`.trim();
  if (source.length === 0) return `exit ${result.exitCode}`;
  return source.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-2).join(' | ');
}

function firstNonEmptyLine(value: string): string | null {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function extractLikelyPaths(output: string): string[] {
  const paths = new Set<string>();
  const re = /(?:^|[\s"'`])((?:src|test|tests|app|lib|packages|projects)\/[A-Za-z0-9._/@+-]+\.[A-Za-z0-9]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    const candidate = match[1];
    if (candidate !== undefined && !generatedContextExclusions().some((prefix) => candidate.startsWith(prefix))) {
      paths.add(candidate);
    }
  }
  return [...paths].sort();
}

function extractLikelyTestPaths(output: string): string[] {
  return extractLikelyPaths(output).filter((path) =>
    /(?:^|\/)(?:__tests__\/.*|.*(?:\.test|\.spec)\.[cm]?[tj]sx?|.*e2e.*\.[cm]?[tj]sx?)$/.test(path),
  );
}

function isLikelyPath(subject: string): boolean {
  return subject.includes('/') || /\.[A-Za-z0-9]+$/.test(basename(subject));
}

function generatedContextExclusions(): string[] {
  return ['.claude/skills/', 'AGENTS.md', 'CLAUDE.md'];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled code graph query kind: ${String(value)}`);
}
