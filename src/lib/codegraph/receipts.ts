import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import type {
  CodeGraphReceipt,
  EvidenceKind,
  EvidenceRef,
  ScopeRef,
  SignatureStatus,
} from './types.js';

export const UNSIGNED_LOCAL_SIGNATURE: SignatureStatus = {
  status: 'unsigned',
  algorithm: 'sha256',
  reason: 'local hash receipt; signing backend not configured',
};

export function createScopeRef(args: {
  readonly repoRoot: string;
  readonly project?: string | undefined;
  readonly task?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly privacyZone?: string | undefined;
}): ScopeRef {
  const scopeId = stableId('scope', {
    repoRoot: args.repoRoot,
    project: args.project ?? null,
    task: args.task ?? null,
    tenantId: args.tenantId ?? null,
    privacyZone: args.privacyZone ?? null,
  });
  return {
    scopeId,
    repoRoot: args.repoRoot,
    ...(args.project !== undefined ? { project: args.project } : {}),
    ...(args.task !== undefined ? { task: args.task } : {}),
    ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
    ...(args.privacyZone !== undefined ? { privacyZone: args.privacyZone } : {}),
  };
}

export function createEvidenceRef(args: {
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly content: unknown;
  readonly createdAt?: string | undefined;
  readonly uri?: string | undefined;
  readonly label?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): EvidenceRef {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const contentHash = sha256Hex(stableStringify(args.content));
  const evidenceId = stableId('evidence', {
    kind: args.kind,
    contentHash,
    summary: args.summary,
    uri: args.uri ?? null,
  });
  return {
    evidenceId,
    kind: args.kind,
    summary: args.summary,
    contentHash,
    createdAt,
    ...(args.uri !== undefined ? { uri: args.uri } : {}),
    ...(args.label !== undefined ? { label: args.label } : {}),
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  };
}

export function createCommandEvidence(args: {
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean | undefined;
  readonly durationMs?: number | undefined;
  readonly createdAt?: string | undefined;
}): EvidenceRef {
  const stdoutTail = tail(args.stdout, 8_000);
  const stderrTail = tail(args.stderr, 8_000);
  return createEvidenceRef({
    kind: 'command_output',
    summary: `${args.command} ${args.argv.join(' ')} exited ${args.exitCode}`,
    content: {
      command: args.command,
      argv: args.argv,
      cwd: args.cwd,
      exitCode: args.exitCode,
      stdoutTail,
      stderrTail,
      timedOut: args.timedOut ?? false,
      durationMs: args.durationMs ?? null,
    },
    createdAt: args.createdAt,
    uri: `command:${args.command}`,
    metadata: {
      exitCode: args.exitCode,
      timedOut: args.timedOut ?? false,
      stdoutBytes: Buffer.byteLength(args.stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(args.stderr, 'utf8'),
    },
  });
}

export function createFileEvidence(args: {
  readonly repoRoot: string;
  readonly path: string;
  readonly content?: string | undefined;
  readonly summary?: string | undefined;
  readonly createdAt?: string | undefined;
}): EvidenceRef {
  const rel = relative(args.repoRoot, args.path);
  return createEvidenceRef({
    kind: 'file_ref',
    summary: args.summary ?? `source file ${rel}`,
    content: {
      path: args.path,
      rel,
      contentHash: args.content === undefined ? null : sha256Hex(args.content),
    },
    createdAt: args.createdAt,
    uri: `file:${rel}`,
    metadata: { path: rel },
  });
}

export function createGeneratedFilePolicyEvidence(createdAt?: string | undefined): EvidenceRef {
  const generatedContextGlobs = [
    '.claude/skills/**',
    'AGENTS.md',
    'CLAUDE.md',
    'harness/**/generated/**',
  ];
  return createEvidenceRef({
    kind: 'generated_file_policy',
    summary: 'skip generated guidance/context output unless explicitly requested',
    content: { generatedContextGlobs, sidecarOnly: true },
    createdAt,
    uri: 'policy:codegraph-generated-files',
    metadata: { generatedContextGlobs },
  });
}

export function createCodeGraphReceipt(args: {
  readonly receiptType: CodeGraphReceipt['receiptType'];
  readonly providerId: string;
  readonly scope: ScopeRef;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly issuedAt?: string | undefined;
  readonly subject?: string | undefined;
  readonly snapshotId?: string | undefined;
  readonly status?: string | undefined;
  readonly publicInputs?: unknown;
}): CodeGraphReceipt {
  const issuedAt = args.issuedAt ?? new Date().toISOString();
  const publicInputs = args.publicInputs ?? {
    receiptType: args.receiptType,
    providerId: args.providerId,
    scope: args.scope,
    subject: args.subject ?? null,
    snapshotId: args.snapshotId ?? null,
    evidenceRefs: args.evidenceRefs.map((ref) => ref.evidenceId),
  };
  const publicInputsHash = sha256Hex(stableStringify(publicInputs));
  const payloadHash = sha256Hex(stableStringify({
    receiptType: args.receiptType,
    providerId: args.providerId,
    scope: args.scope,
    subject: args.subject ?? null,
    snapshotId: args.snapshotId ?? null,
    status: args.status ?? null,
    publicInputsHash,
    evidenceHashes: args.evidenceRefs.map((ref) => ref.contentHash),
    issuedAt,
  }));
  const receiptId = stableId('codegraph_receipt', {
    receiptType: args.receiptType,
    providerId: args.providerId,
    publicInputsHash,
    payloadHash,
    issuedAt,
  });
  return {
    receiptId,
    schemaVersion: 'codegraph.receipt.v1',
    receiptType: args.receiptType,
    providerId: args.providerId,
    scope: args.scope,
    issuedAt,
    ...(args.subject !== undefined ? { subject: args.subject } : {}),
    ...(args.snapshotId !== undefined ? { snapshotId: args.snapshotId } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    publicInputsHash,
    evidenceRefs: args.evidenceRefs,
    signature: UNSIGNED_LOCAL_SIGNATURE,
    payloadHash,
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Hex(stableStringify(value)).slice(0, 24)}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const entry = input[key];
    if (entry !== undefined) out[key] = sortJson(entry);
  }
  return out;
}

function tail(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  return buf.subarray(buf.length - maxBytes).toString('utf8');
}
