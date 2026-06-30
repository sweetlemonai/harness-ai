import {
  importLegacySource,
  readLegacySourceManifest,
  scanLegacySource,
  type LegacySourceKind,
} from '../lib/legacy/importer.js';
import { loadConfiguredSidecarSigner } from '../lib/proof/signing.js';

export interface LegacyScanCommandArgs {
  readonly path: string;
  readonly kind: LegacySourceKind;
  readonly manifest?: string;
  readonly json?: boolean;
}

export interface LegacyImportCommandArgs {
  readonly runDir: string;
  readonly path: string;
  readonly kind: LegacySourceKind;
  readonly manifest: string;
  readonly json?: boolean;
}

export async function legacyScanCommand(args: LegacyScanCommandArgs): Promise<number> {
  const manifest = args.manifest === undefined
    ? undefined
    : readLegacySourceManifest(args.manifest);
  const result = scanLegacySource({
    path: args.path,
    kind: args.kind,
    ...(manifest !== undefined ? { manifest } : {}),
  });
  writeOutput(result, args.json === true);
  return result.exists ? 0 : 1;
}

export async function legacyImportCommand(args: LegacyImportCommandArgs): Promise<number> {
  const manifest = readLegacySourceManifest(args.manifest);
  const result = importLegacySource({
    runDir: args.runDir,
    path: args.path,
    kind: args.kind,
    manifest,
    signer: loadConfiguredSidecarSigner(),
  });
  writeOutput({
    manifest: result.manifest,
    importedEvidenceIds: result.evidence.map((entry) => entry.evidenceId),
    importedMessageIds: result.envelopes.map((entry) => entry.messageId),
    lossy: result.lossy,
    unavailableLegacyStates: result.unavailableLegacyStates,
  }, args.json === true);
  return 0;
}

export function parseLegacySourceKind(value: string): LegacySourceKind {
  if (value === 'bcrx_v1' || value === 'vcrx_legacy') return value;
  throw new Error(`invalid legacy source kind '${value}'`);
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
