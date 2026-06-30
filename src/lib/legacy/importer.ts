import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { MessageEnvelopeV2 } from '../../types.js';
import { createEvidenceReceipt } from '../evidence/ledger.js';
import type { EvidenceReceipt } from '../evidence/types.js';
import {
  signEvidenceReceipt,
  type SidecarSigner,
} from '../proof/signing.js';
import { appendLedgerEntry } from '../protocol/ledger.js';
import { sidecarPathsForRunDir } from '../protocol/sidecar.js';
import { hashFile, stableId } from '../protocol/hash.js';
import type { BcrxSubjectFields } from '../protocol/types.js';
import {
  localJsonlInboxUri,
  sendBusMessage,
} from '../collaboration/localJsonlBus.js';

export type LegacySourceKind = 'bcrx_v1' | 'vcrx_legacy';

export interface LegacySourceManifest {
  readonly manifestVersion: 'superharness.legacy_source_manifest.v1';
  readonly sourceId: string;
  readonly kind: LegacySourceKind;
  readonly sourcePath: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly sourceAgentId?: string;
  readonly targetAgentId?: string;
}

export interface LegacyScanResult {
  readonly path: string;
  readonly kind: LegacySourceKind;
  readonly exists: boolean;
  readonly fileCount: number;
  readonly files: readonly LegacyFileSummary[];
  readonly canImportCanonically: boolean;
  readonly reason?: string;
}

export interface LegacyFileSummary {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LegacyImportResult {
  readonly manifest: LegacySourceManifest;
  readonly evidence: readonly EvidenceReceipt[];
  readonly envelopes: readonly MessageEnvelopeV2[];
  readonly lossy: true;
  readonly unavailableLegacyStates: readonly string[];
}

export function scanLegacySource(args: {
  readonly path: string;
  readonly kind: LegacySourceKind;
  readonly manifest?: LegacySourceManifest;
}): LegacyScanResult {
  const sourcePath = resolve(args.path);
  if (!existsSync(sourcePath)) {
    return {
      path: sourcePath,
      kind: args.kind,
      exists: false,
      fileCount: 0,
      files: [],
      canImportCanonically: false,
      reason: 'source path does not exist',
    };
  }
  const files = listLegacyFiles(sourcePath);
  const manifestOk = args.manifest !== undefined
    && args.manifest.kind === args.kind
    && resolve(args.manifest.sourcePath) === sourcePath;
  return {
    path: sourcePath,
    kind: args.kind,
    exists: true,
    fileCount: files.length,
    files,
    canImportCanonically: manifestOk,
    ...(manifestOk ? {} : { reason: 'canonical import requires an approved source manifest for this exact path and kind' }),
  };
}

export function readLegacySourceManifest(path: string): LegacySourceManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isLegacySourceManifest(parsed)) {
    throw new Error(`invalid legacy source manifest: ${path}`);
  }
  return parsed;
}

export function importLegacySource(args: {
  readonly runDir: string;
  readonly path: string;
  readonly kind: LegacySourceKind;
  readonly manifest: LegacySourceManifest;
  readonly signer?: SidecarSigner | undefined;
}): LegacyImportResult {
  const scan = scanLegacySource(args);
  if (!scan.exists) {
    throw new Error(scan.reason ?? 'legacy source path is unavailable');
  }
  if (!scan.canImportCanonically) {
    throw new Error(scan.reason ?? 'legacy source manifest is required');
  }
  const files = sidecarPathsForRunDir(args.runDir);
  const subject = legacySubject(args.manifest, scan);
  const evidence: EvidenceReceipt[] = [];
  const envelopes: MessageEnvelopeV2[] = [];
  for (const file of scan.files) {
    const content = readFileSync(file.path, 'utf8');
    const receipt = signEvidenceReceipt(createEvidenceReceipt({
      kind: 'file_ref',
      subject,
      summary: `${args.kind} legacy source file: ${basename(file.path)}`,
      observedBy: 'harness.legacy.importer',
      content: {
        path: file.path,
        sha256: file.sha256,
        bytes: file.bytes,
        preview: content.slice(0, 1000),
      },
      uri: `file:${file.path}`,
      metadata: {
        legacyKind: args.kind,
        sourceId: args.manifest.sourceId,
        lossy: true,
        deliveryState: 'unavailable',
        readState: 'unavailable',
        acceptanceState: 'unavailable',
      },
    }), args.signer);
    appendLedgerEntry(files.evidenceFile, receipt as unknown as Record<string, unknown>);
    evidence.push(receipt);
    const sent = sendBusMessage({
      runDir: files.runDir,
      from: {
        agentId: args.manifest.sourceAgentId ?? `${args.kind}.legacy-adapter`,
        kind: 'legacy_adapter',
      },
      to: [{
        agentId: args.manifest.targetAgentId ?? 'superharness.legacy-import',
        inboxUri: localJsonlInboxUri(args.manifest.targetAgentId ?? 'superharness.legacy-import'),
        required: true,
      }],
      intent: 'artifact',
      body: {
        contentType: 'application/vnd.superharness.legacy-import+json',
        json: {
          legacyKind: args.kind,
          sourceId: args.manifest.sourceId,
          sourcePath: args.manifest.sourcePath,
          file: {
            path: file.path,
            sha256: file.sha256,
            bytes: file.bytes,
          },
          semantics: {
            lossy: true,
            oldDelivery: 'unavailable',
            oldRead: 'unavailable',
            oldAcceptance: 'unavailable',
            note: 'legacy transport state is not promoted to v2 lifecycle receipts',
          },
          evidenceId: receipt.evidenceId,
        },
      },
      requiredReceipts: ['delivered'],
      idempotencyKey: stableId('legacy_import', {
        sourceId: args.manifest.sourceId,
        kind: args.kind,
        file: file.path,
        sha256: file.sha256,
      }),
    });
    envelopes.push(sent.envelope);
  }
  return {
    manifest: args.manifest,
    evidence,
    envelopes,
    lossy: true,
    unavailableLegacyStates: ['delivery', 'read', 'acceptance'],
  };
}

function listLegacyFiles(path: string): LegacyFileSummary[] {
  const stat = statSync(path);
  const files = stat.isFile() ? [path] : walk(path);
  return files
    .filter((file) => /\.(?:json|jsonl|md|txt|yaml|yml)$/i.test(file))
    .map((file) => ({
      path: resolve(file),
      bytes: statSync(file).size,
      sha256: hashFile(file),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function walk(path: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path)) {
    const full = join(path, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '.git' || entry === 'node_modules') continue;
      out.push(...walk(full));
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function legacySubject(
  manifest: LegacySourceManifest,
  scan: LegacyScanResult,
): BcrxSubjectFields {
  return {
    subjectId: `legacy:${manifest.kind}:${manifest.sourceId}`,
    subjectType: 'claim',
    title: `${manifest.kind} legacy import ${manifest.sourceId}`,
    assuranceContext: 'alpha',
    privacyZone: 'WORKSPACE',
    materiality: 'high',
    evidencePolicy: {
      required: true,
      minRefs: 1,
      acceptedKinds: ['file_ref'],
    },
    instrumentationRefs: scan.files.map((file) => `sha256:${file.sha256}`),
  };
}

function isLegacySourceManifest(value: unknown): value is LegacySourceManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<LegacySourceManifest>;
  return candidate.manifestVersion === 'superharness.legacy_source_manifest.v1'
    && (candidate.kind === 'bcrx_v1' || candidate.kind === 'vcrx_legacy')
    && typeof candidate.sourceId === 'string'
    && candidate.sourceId.trim().length > 0
    && typeof candidate.sourcePath === 'string'
    && candidate.sourcePath.trim().length > 0
    && typeof candidate.approvedBy === 'string'
    && candidate.approvedBy.trim().length > 0
    && typeof candidate.approvedAt === 'string'
    && candidate.approvedAt.trim().length > 0;
}
