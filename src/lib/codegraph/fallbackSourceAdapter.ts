import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
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

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  'harness',
]);

const SOURCE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.py',
  '.go',
  '.rs',
  '.java',
]);

export class FallbackSourceCodeGraphAdapter implements CodeGraphAdapter {
  readonly adapterId = 'fallback-source-adapter-v1';
  readonly providerId = 'source-fallback';

  private readonly now: () => Date;

  constructor(options: CodeGraphAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async probe(scope: ScopeRef): Promise<CodeGraphProbeResult> {
    const evidence = createEvidenceRef({
      kind: 'fallback_notice',
      summary: 'direct source-read fallback is available but no dependency graph is indexed',
      content: {
        repoRoot: scope.repoRoot,
        limitations: [
          'no callers/callees graph',
          'no ownership graph',
          'test candidates are filename heuristics',
        ],
      },
      createdAt: this.nowIso(),
      uri: 'provider:source-fallback',
    });
    return {
      providerId: this.providerId,
      available: true,
      version: 'direct-source-read-v1',
      healthRefs: [evidence],
    };
  }

  async snapshot(scope: ScopeRef): Promise<CodeGraphSnapshot> {
    const issuedAt = this.nowIso();
    const files = listSourceFiles(scope.repoRoot, 2_000);
    const status = await runGit(scope.repoRoot, ['status', '--porcelain=v1'], issuedAt);
    const commit = await runGit(scope.repoRoot, ['rev-parse', 'HEAD'], issuedAt);
    const generatedFilePolicyRef = createGeneratedFilePolicyEvidence(issuedAt);
    const inventoryRef = createEvidenceRef({
      kind: 'source_scan',
      summary: `direct source scan found ${files.length} files`,
      content: { files },
      createdAt: issuedAt,
      uri: 'source-scan:repo',
      metadata: { fileCount: files.length },
    });
    const graphHash = sha256Hex(stableStringify({
      providerId: this.providerId,
      files,
      gitStatus: status.stdout.trim(),
      commitHash: commit.exitCode === 0 ? commit.stdout.trim() : null,
    }));
    const snapshotId = stableId('codegraph_snapshot', {
      providerId: this.providerId,
      repoRoot: scope.repoRoot,
      graphHash,
    });
    const sourceRefs = [inventoryRef, status.evidenceRef, commit.evidenceRef, generatedFilePolicyRef];
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_unavailable',
      providerId: this.providerId,
      scope,
      evidenceRefs: sourceRefs,
      snapshotId,
      status: 'partial',
      issuedAt,
      publicInputs: {
        snapshotId,
        repoRoot: scope.repoRoot,
        fileCount: files.length,
        graphHash,
        reason: 'fallback source scan only',
      },
    });
    const commitHash = commit.exitCode === 0 ? commit.stdout.trim() : undefined;
    const worktreeStatus = status.stdout.trim();
    return {
      snapshotId,
      providerId: this.providerId,
      repoRoot: scope.repoRoot,
      providerVersion: 'direct-source-read-v1',
      ...(commitHash !== undefined ? { commitHash } : {}),
      worktreeHash: sha256Hex(worktreeStatus),
      worktreeStatusRef: status.evidenceRef,
      dirtyWorktreeState: worktreeStatus.length === 0 ? 'clean_indexed' : 'dirty_unindexed',
      dirtyWorktreePolicy: 'block_mutation',
      generatedFilePolicyRef,
      indexedAt: issuedAt,
      freshness: 'partial',
      stalenessReason: 'no code graph provider available; direct source reads only',
      graphHash,
      sourceRefs,
      proofReceiptIds: [],
      receiptId: receipt.receiptId,
    };
  }

  async refresh(input: CodeGraphRefreshRequest): Promise<CodeGraphRefreshResult> {
    const evidence = createEvidenceRef({
      kind: 'fallback_notice',
      summary: 'source fallback cannot refresh a code graph index',
      content: {
        sidecarOnly: input.sidecarOnly,
        force: input.force ?? false,
        repoRoot: input.scope.repoRoot,
      },
      createdAt: this.nowIso(),
      uri: 'provider:source-fallback',
    });
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_unavailable',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: [evidence],
      status: 'unavailable',
      issuedAt: this.nowIso(),
      publicInputs: {
        reason: 'no graph index exists for source fallback',
        sidecarOnly: input.sidecarOnly,
      },
    });
    return {
      status: 'unavailable',
      receiptId: receipt.receiptId,
      evidenceRefs: [evidence],
    };
  }

  async query(input: CodeGraphQueryRequest): Promise<CodeGraphQuery> {
    const snapshot = await this.snapshot(input.scope);
    const evidence = await this.sourceEvidenceForSubject(input.scope.repoRoot, input.subject);
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_query',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: [evidence],
      subject: input.subject,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      status: 'degraded',
      issuedAt: this.nowIso(),
      publicInputs: {
        queryKind: input.queryKind,
        subject: input.subject,
        snapshotId: input.snapshotId ?? snapshot.snapshotId,
        fallback: true,
      },
    });
    return {
      queryId: stableId('codegraph_query', {
        providerId: this.providerId,
        queryKind: input.queryKind,
        subject: input.subject,
        evidenceHash: evidence.contentHash,
      }),
      providerId: this.providerId,
      queryKind: input.queryKind,
      subject: input.subject,
      scope: input.scope,
      resultRef: evidence,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      confidence: 0.25,
      receiptId: receipt.receiptId,
    };
  }

  async impact(input: CodeGraphImpactRequest): Promise<ImpactReceipt> {
    const snapshot = await this.snapshot(input.scope);
    const files = await matchingFiles(input.scope.repoRoot, input.subject);
    const refs = files.length > 0
      ? files.map((file) => createFileEvidence({
        repoRoot: input.scope.repoRoot,
        path: resolve(input.scope.repoRoot, file),
        summary: `fallback impact match ${file}`,
        createdAt: this.nowIso(),
      }))
      : [await this.sourceEvidenceForSubject(input.scope.repoRoot, input.subject)];
    const affectedFiles = files.length > 0 ? files : (isPathSubject(input.subject) ? [input.subject] : []);
    const unresolvedEdges = [
      'fallback source scan cannot determine callers, callees, dependency depth, or ownership',
    ];
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_impact',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: refs,
      subject: input.subject,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      status: 'degraded',
      issuedAt: this.nowIso(),
      publicInputs: {
        subject: input.subject,
        depth: input.depth,
        affectedFiles,
        unresolvedEdges,
        fallback: true,
      },
    });
    return {
      receiptId: receipt.receiptId,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      scope: input.scope,
      changedSymbols: isPathSubject(input.subject) ? [] : [input.subject],
      changedPathRefs: refs,
      affectedCallers: [],
      affectedCallees: [],
      affectedFiles,
      depth: input.depth,
      confidence: 0.2,
      ambiguousMatches: files.length > 1 && !isPathSubject(input.subject) ? files : [],
      unresolvedEdges,
      generatedFileExclusions: ['.claude/skills/', 'AGENTS.md', 'CLAUDE.md'],
      reviewerRequired: true,
      signature: UNSIGNED_LOCAL_SIGNATURE,
    };
  }

  async testCandidates(input: CodeGraphTestRequest): Promise<TestCandidateMap> {
    const snapshot = await this.snapshot(input.scope);
    const testFiles = findLikelyTests(input.scope.repoRoot, input.subject);
    const rationale = createEvidenceRef({
      kind: 'fallback_notice',
      summary: 'fallback test candidates are filename and directory heuristics',
      content: { subject: input.subject, testFiles },
      createdAt: this.nowIso(),
      uri: 'provider:source-fallback/tests',
    });
    const candidateTests = testFiles.map((file) => ({
      testRef: createFileEvidence({
        repoRoot: input.scope.repoRoot,
        path: resolve(input.scope.repoRoot, file),
        summary: `fallback test candidate ${file}`,
        createdAt: this.nowIso(),
      }),
      classification: classifyTest(file, input.subject),
      confidence: classifyTest(file, input.subject) === 'focused' ? 0.45 : 0.25,
      rationaleRef: rationale,
      historicalFailureRefs: [],
    }));
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_test_mapping',
      providerId: this.providerId,
      scope: input.scope,
      evidenceRefs: [rationale, ...candidateTests.map((entry) => entry.testRef)],
      subject: input.subject,
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      status: 'degraded',
      issuedAt: this.nowIso(),
      publicInputs: {
        subject: input.subject,
        testFiles,
        fallback: true,
      },
    });
    return {
      mapId: stableId('codegraph_tests', {
        providerId: this.providerId,
        subject: input.subject,
        testFiles,
      }),
      snapshotId: input.snapshotId ?? snapshot.snapshotId,
      scope: input.scope,
      sourceRefs: [rationale],
      candidateTests,
      verificationResultRefs: [],
      receiptId: receipt.receiptId,
    };
  }

  async doctor(scope: ScopeRef): Promise<CodeGraphDoctorReport> {
    const snapshot = await this.snapshot(scope);
    const findings = [
      'GitNexus or another graph provider is not being used',
      'dependency edges, callers, callees, process flows, and ownership are unavailable',
      'direct source reads can orient work but cannot clear high-risk impact',
    ];
    const receipt = createCodeGraphReceipt({
      receiptType: 'code_graph_doctor',
      providerId: this.providerId,
      scope,
      evidenceRefs: snapshot.sourceRefs,
      status: 'degraded',
      issuedAt: this.nowIso(),
      publicInputs: {
        findings,
        snapshotId: snapshot.snapshotId,
      },
    });
    return {
      reportId: stableId('codegraph_doctor', {
        providerId: this.providerId,
        scope,
        findings,
        receiptId: receipt.receiptId,
      }),
      scope,
      status: 'degraded',
      findings,
      evidenceRefs: snapshot.sourceRefs,
      receiptId: receipt.receiptId,
    };
  }

  async explainFailure(ref: EvidenceRef): Promise<string> {
    return `Fallback evidence ${ref.evidenceId} is only a direct source-read clue: ${ref.summary}. Use a graph provider before treating impact or test coverage as complete.`;
  }

  private async sourceEvidenceForSubject(repoRoot: string, subject: string): Promise<EvidenceRef> {
    if (isPathSubject(subject)) {
      const path = resolve(repoRoot, subject);
      let content: string | undefined;
      if (existsSync(path) && statSync(path).isFile()) {
        content = readFileSync(path, 'utf8');
      }
      return createFileEvidence({
        repoRoot,
        path,
        content,
        summary: content === undefined
          ? `fallback path subject ${subject} was not readable`
          : `fallback source read ${subject}`,
        createdAt: this.nowIso(),
      });
    }
    const files = await matchingFiles(repoRoot, subject);
    return createEvidenceRef({
      kind: 'source_scan',
      summary: `fallback symbol scan for ${subject} found ${files.length} files`,
      content: { subject, files },
      createdAt: this.nowIso(),
      uri: `source-scan:${subject}`,
      metadata: { fileCount: files.length },
    });
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

async function runGit(cwd: string, args: readonly string[], createdAt: string): Promise<{
  readonly evidenceRef: EvidenceRef;
  readonly stdout: string;
  readonly exitCode: number;
}> {
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
    exitCode: exec.exitCode,
  };
}

function listSourceFiles(repoRoot: string, limit: number): string[] {
  const out: string[] = [];
  visit(repoRoot);
  return out.sort();

  function visit(dir: string): void {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (SKIP_DIRS.has(entry)) continue;
      if (entry === '.claude') continue;
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(full);
      } else if (stat.isFile() && SOURCE_EXTS.has(extname(entry))) {
        out.push(relative(repoRoot, full));
      }
    }
  }
}

async function matchingFiles(repoRoot: string, subject: string): Promise<string[]> {
  if (isPathSubject(subject)) {
    const path = resolve(repoRoot, subject);
    return existsSync(path) ? [relative(repoRoot, path)] : [];
  }
  const exec = await runCommand('rg', ['--files-with-matches', '--fixed-strings', subject, '.'], {
    cwd: repoRoot,
    timeoutMs: 10_000,
  });
  if (exec.exitCode !== 0 && exec.stdout.trim().length === 0) return [];
  return exec.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isGeneratedContext(line))
    .slice(0, 100)
    .sort();
}

function findLikelyTests(repoRoot: string, subject: string): string[] {
  const files = listSourceFiles(repoRoot, 4_000);
  const base = basename(subject, extname(subject));
  const dir = isPathSubject(subject) ? dirname(subject) : '';
  const directNames = new Set([
    `${base}.test.ts`,
    `${base}.spec.ts`,
    `${base}.test.tsx`,
    `${base}.spec.tsx`,
  ]);
  return files
    .filter((file) => isTestFile(file))
    .filter((file) => {
      if (directNames.has(basename(file))) return true;
      if (dir.length > 0 && file.includes(dir)) return true;
      return file.toLowerCase().includes(base.toLowerCase());
    })
    .slice(0, 25);
}

function classifyTest(file: string, subject: string): 'focused' | 'broad' | 'smoke' | 'unknown' {
  const base = basename(subject, extname(subject)).toLowerCase();
  const lower = file.toLowerCase();
  if (lower.includes('/smoke') || lower.includes('smoke.')) return 'smoke';
  if (lower.includes(base)) return 'focused';
  if (lower.includes('/e2e/') || lower.includes('.e2e.')) return 'broad';
  return 'unknown';
}

function isPathSubject(subject: string): boolean {
  return subject.includes('/') || extname(subject).length > 0;
}

function isTestFile(file: string): boolean {
  return /(?:^|\/)(?:__tests__\/.*|.*(?:\.test|\.spec|\.e2e)\.[cm]?[tj]sx?)$/.test(file);
}

function isGeneratedContext(file: string): boolean {
  return file.startsWith('.claude/skills/') || file === 'AGENTS.md' || file === 'CLAUDE.md';
}
