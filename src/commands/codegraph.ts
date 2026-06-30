import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createAvailableCodeGraphAdapter,
  createCodeGraphAdapter,
  createCodeGraphScope,
  type CodeGraphProviderSelection,
} from '../lib/codegraph/adapter.js';
import {
  createCodeGraphReceipt,
  createEvidenceRef,
} from '../lib/codegraph/receipts.js';
import {
  findCodeGraphStoredRecord,
  storeCodeGraphPayload,
  verifyCodeGraphStoredRecord,
} from '../lib/codegraph/store.js';
import type {
  CodeGraphAdapter,
  CodeGraphReceipt,
  ScopeRef,
} from '../lib/codegraph/types.js';

interface BaseCodeGraphCommandArgs {
  readonly repoRoot?: string;
  readonly provider?: CodeGraphProviderSelection;
  readonly json?: boolean;
}

export interface CodeGraphStatusCommandArgs extends BaseCodeGraphCommandArgs {}

export interface CodeGraphRefreshCommandArgs extends BaseCodeGraphCommandArgs {
  readonly sidecarOnly?: boolean;
  readonly force?: boolean;
}

export interface CodeGraphImpactCommandArgs extends BaseCodeGraphCommandArgs {
  readonly path?: string;
  readonly symbol?: string;
  readonly depth?: number;
}

export interface CodeGraphTestsCommandArgs extends BaseCodeGraphCommandArgs {
  readonly path?: string;
  readonly symbol?: string;
}

export interface CodeGraphDoctorCommandArgs extends BaseCodeGraphCommandArgs {}

export interface CodeGraphReceiptCommandArgs extends BaseCodeGraphCommandArgs {
  readonly ref: string;
}

export async function codegraphStatusCommand(
  args: CodeGraphStatusCommandArgs = {},
): Promise<number> {
  const scope = makeScope(args);
  const requestedProvider = args.provider ?? 'auto';
  const gitnexus = createCodeGraphAdapter('gitnexus', { repoRoot: scope.repoRoot });
  const gitnexusProbe = await gitnexus.probe(scope);
  const adapter = await selectAdapter(requestedProvider, scope);
  const snapshot = await adapter.snapshot(scope);
  const payload = {
    providerId: adapter.providerId,
    requestedProvider,
    gitnexusProbe,
    snapshot,
  };
  storeCodeGraphPayload({
    scope,
    command: 'status',
    payload,
    receiptId: snapshot.receiptId,
  });
  if (args.json === true) {
    writeJson(payload);
  } else {
    process.stdout.write(`codegraph provider: ${adapter.providerId}\n`);
    process.stdout.write(`snapshot: ${snapshot.snapshotId}\n`);
    process.stdout.write(`freshness: ${snapshot.freshness}\n`);
    process.stdout.write(`worktree: ${snapshot.dirtyWorktreeState}\n`);
    if (!gitnexusProbe.available) {
      process.stdout.write(`gitnexus: unavailable (${gitnexusProbe.unavailableReason ?? 'unknown reason'})\n`);
    }
    process.stdout.write(`receipt: ${snapshot.receiptId}\n`);
  }
  return 0;
}

export async function codegraphRefreshCommand(
  args: CodeGraphRefreshCommandArgs = {},
): Promise<number> {
  const scope = makeScope(args);
  const adapter = await selectAdapter(args.provider ?? 'auto', scope);
  const result = await adapter.refresh({
    scope,
    sidecarOnly: args.sidecarOnly ?? true,
    force: args.force ?? false,
  });
  storeCodeGraphPayload({
    scope,
    command: 'refresh',
    payload: result,
    receiptId: result.receiptId,
  });
  if (args.json === true) {
    writeJson(result);
  } else {
    process.stdout.write(`codegraph refresh: ${result.status}\n`);
    if (result.snapshotId !== undefined) process.stdout.write(`snapshot: ${result.snapshotId}\n`);
    process.stdout.write(`receipt: ${result.receiptId}\n`);
    for (const ref of result.evidenceRefs) {
      process.stdout.write(`evidence: ${ref.evidenceId} ${ref.summary}\n`);
    }
  }
  return result.status === 'failed' ? 1 : 0;
}

export async function codegraphImpactCommand(
  args: CodeGraphImpactCommandArgs,
): Promise<number> {
  const subject = subjectFromPathOrSymbol(args);
  const scope = makeScope(args);
  const adapter = await selectAdapter(args.provider ?? 'auto', scope);
  const result = await adapter.impact({
    scope,
    subject,
    depth: args.depth ?? 2,
  });
  storeCodeGraphPayload({
    scope,
    command: 'impact',
    payload: result,
    receiptId: result.receiptId,
  });
  if (args.json === true) {
    writeJson(result);
  } else {
    process.stdout.write(`impact subject: ${subject}\n`);
    process.stdout.write(`provider: ${adapter.providerId}\n`);
    process.stdout.write(`snapshot: ${result.snapshotId}\n`);
    process.stdout.write(`confidence: ${formatConfidence(result.confidence)}\n`);
    process.stdout.write(`reviewer required: ${result.reviewerRequired ? 'yes' : 'no'}\n`);
    renderList('affected files', result.affectedFiles);
    renderList('unresolved edges', result.unresolvedEdges);
    renderList('ambiguous matches', result.ambiguousMatches);
    process.stdout.write(`receipt: ${result.receiptId}\n`);
  }
  return result.unresolvedEdges.length > 0 ? 1 : 0;
}

export async function codegraphTestsCommand(
  args: CodeGraphTestsCommandArgs,
): Promise<number> {
  const subject = subjectFromPathOrSymbol(args);
  const scope = makeScope(args);
  const adapter = await selectAdapter(args.provider ?? 'auto', scope);
  const result = await adapter.testCandidates({ scope, subject });
  storeCodeGraphPayload({
    scope,
    command: 'tests',
    payload: result,
    receiptId: result.receiptId,
  });
  if (args.json === true) {
    writeJson(result);
  } else {
    process.stdout.write(`test candidates for: ${subject}\n`);
    process.stdout.write(`provider: ${adapter.providerId}\n`);
    if (result.candidateTests.length === 0) {
      process.stdout.write('(no candidates found)\n');
    } else {
      for (const candidate of result.candidateTests) {
        process.stdout.write(
          `- ${candidate.testRef.uri ?? candidate.testRef.evidenceId} ` +
          `[${candidate.classification}, confidence ${formatConfidence(candidate.confidence)}]\n`,
        );
      }
    }
    process.stdout.write(`receipt: ${result.receiptId}\n`);
  }
  return result.candidateTests.length === 0 ? 1 : 0;
}

export async function codegraphDoctorCommand(
  args: CodeGraphDoctorCommandArgs = {},
): Promise<number> {
  const scope = makeScope(args);
  const adapter = await selectAdapter(args.provider ?? 'auto', scope);
  const report = await adapter.doctor(scope);
  storeCodeGraphPayload({
    scope,
    command: 'doctor',
    payload: report,
    receiptId: report.receiptId,
  });
  if (args.json === true) {
    writeJson(report);
  } else {
    process.stdout.write(`codegraph doctor: ${report.status}\n`);
    process.stdout.write(`provider: ${adapter.providerId}\n`);
    for (const finding of report.findings) {
      process.stdout.write(`- ${finding}\n`);
    }
    process.stdout.write(`receipt: ${report.receiptId}\n`);
  }
  return report.status === 'healthy' || report.status === 'degraded' ? 0 : 1;
}

export async function codegraphReceiptCommand(
  args: CodeGraphReceiptCommandArgs,
): Promise<number> {
  const scope = makeScope(args);
  const stored = findCodeGraphStoredRecord(scope, args.ref);
  if (stored !== null) {
    const payload = {
      found: true,
      validPayloadHash: verifyCodeGraphStoredRecord(stored),
      record: stored,
    };
    if (args.json === true) {
      writeJson(payload);
    } else {
      process.stdout.write(`receipt lookup: ${args.ref}\n`);
      process.stdout.write(`stored receipt: ${stored.receiptId}\n`);
      process.stdout.write(`command: ${stored.command}\n`);
      process.stdout.write(`payload hash: ${stored.payloadHash}\n`);
      process.stdout.write(`payload hash valid: ${payload.validPayloadHash ? 'yes' : 'no'}\n`);
    }
    return payload.validPayloadHash ? 0 : 1;
  }
  const evidence = createEvidenceRef({
    kind: 'receipt',
    summary: `receipt lookup request for ${args.ref}`,
    content: {
      ref: args.ref,
      note: 'receipt not found in local codegraph receipt store',
    },
    createdAt: new Date().toISOString(),
    uri: `receipt:${args.ref}`,
  });
  const receipt: CodeGraphReceipt = createCodeGraphReceipt({
    receiptType: 'code_graph_unavailable',
    providerId: 'codegraph-command',
    scope,
    evidenceRefs: [evidence],
    subject: args.ref,
    status: 'lookup_unavailable',
    issuedAt: new Date().toISOString(),
    publicInputs: {
      requestedRef: args.ref,
      persistence: 'lookup_miss',
    },
  });
  storeCodeGraphPayload({
    scope,
    command: 'receipt',
    payload: receipt,
    receiptId: receipt.receiptId,
  });
  if (args.json === true) {
    writeJson({
      found: false,
      receipt,
      evidence,
    });
  } else {
    process.stdout.write(`receipt lookup: ${args.ref}\n`);
    process.stdout.write('stored receipt not found\n');
    process.stdout.write(`receipt: ${receipt.receiptId}\n`);
    process.stdout.write(`evidence: ${evidence.evidenceId} ${evidence.summary}\n`);
  }
  return 1;
}

function makeScope(args: BaseCodeGraphCommandArgs): ScopeRef {
  const repoRoot = realpathSync(resolve(args.repoRoot ?? process.cwd()));
  return createCodeGraphScope({ repoRoot });
}

async function selectAdapter(
  provider: CodeGraphProviderSelection,
  scope: ScopeRef,
): Promise<CodeGraphAdapter> {
  return createAvailableCodeGraphAdapter(provider, scope, { repoRoot: scope.repoRoot });
}

function subjectFromPathOrSymbol(args: {
  readonly path?: string;
  readonly symbol?: string;
}): string {
  if (args.path !== undefined && args.symbol !== undefined) {
    throw new Error('pass exactly one of path or symbol');
  }
  if (args.path !== undefined) return args.path;
  if (args.symbol !== undefined) return args.symbol;
  throw new Error('path or symbol is required');
}

function renderList(label: string, values: readonly string[]): void {
  process.stdout.write(`${label}:`);
  if (values.length === 0) {
    process.stdout.write(' none\n');
    return;
  }
  process.stdout.write('\n');
  for (const value of values) process.stdout.write(`- ${value}\n`);
}

function formatConfidence(value: number | undefined): string {
  if (value === undefined) return 'unknown';
  return value.toFixed(2);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
