import { loadConfig } from '../lib/config.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { appendLedgerEntry } from '../lib/protocol/ledger.js';
import { sidecarPathsForRunDir } from '../lib/protocol/sidecar.js';
import type { PrivacyZone } from '../lib/protocol/types.js';
import {
  readPrivacyPreflightText,
  runPrivacyPreflight,
} from '../lib/privacy/preflight.js';
import { createEvidenceReceipt } from '../lib/evidence/ledger.js';
import {
  createSidecarSigner,
  signEvidenceReceipt,
} from '../lib/proof/signing.js';

export interface PrivacyPreflightCommandArgs {
  readonly runDir?: string;
  readonly sourceZone?: PrivacyZone;
  readonly targetZone: PrivacyZone;
  readonly text?: string;
  readonly file?: string;
  readonly json?: boolean;
}

export async function privacyPreflightCommand(
  args: PrivacyPreflightCommandArgs,
): Promise<number> {
  const paths = resolveHarnessPaths();
  const config = loadConfig(paths);
  const text = readPrivacyPreflightText({
    ...(args.text !== undefined ? { text: args.text } : {}),
    ...(args.file !== undefined ? { file: args.file } : {}),
  });
  const result = runPrivacyPreflight({
    config,
    text,
    ...(args.sourceZone !== undefined ? { sourceZone: args.sourceZone } : {}),
    targetZone: args.targetZone,
  });
  let evidenceId: string | null = null;
  if (args.runDir !== undefined) {
    const files = sidecarPathsForRunDir(args.runDir);
    const evidence = signEvidenceReceipt(createEvidenceReceipt({
      kind: 'privacy_preflight',
      subject: {
        subjectId: `privacy:${result.sourceZone}->${result.targetZone}`,
        subjectType: 'claim',
        title: 'privacy preflight',
        assuranceContext: 'alpha',
        privacyZone: result.sourceZone,
        materiality: result.ok ? 'medium' : 'critical',
      },
      summary: result.ok ? 'privacy preflight passed' : 'privacy preflight blocked',
      observedBy: 'harness.privacy.cli',
      content: result,
      metadata: {
        findingCount: result.findings.length,
      },
    }), createSidecarSigner(config.proofs.signing));
    appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
    evidenceId = evidence.evidenceId;
  }
  writeOutput({ ...result, evidenceId }, args.json === true);
  return result.ok ? 0 : 1;
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
