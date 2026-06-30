// Thin CLI entry point. Routes subcommands to commands/*.ts. Contains no
// pipeline logic — every command module owns its own argument validation
// and calls into pipeline/runner.ts when it needs to run phases.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { PHASE_IDS, type PhaseId } from './types.js';
import { runCommand, type RunCommandArgs } from './commands/run.js';
import { shipCommand, type ShipCommandArgs } from './commands/ship.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { debugCommand } from './commands/debug.js';
import {
  agentopsAdviseCommand,
  agentopsExportCommand,
  agentopsGraphCommand,
  agentopsPanelCommand,
  agentopsReplayCommand,
} from './commands/agentops.js';
import {
  codegraphDoctorCommand,
  codegraphImpactCommand,
  codegraphReceiptCommand,
  codegraphRefreshCommand,
  codegraphStatusCommand,
  codegraphTestsCommand,
} from './commands/codegraph.js';
import { fleetDoctorCommand } from './commands/fleet.js';
import {
  modelsListCommand,
  modelsProbeCommand,
} from './commands/models.js';
import {
  legacyImportCommand,
  legacyScanCommand,
  parseLegacySourceKind,
} from './commands/legacy.js';
import {
  privacyPreflightCommand,
} from './commands/privacy.js';
import {
  proofAttestCommand,
  proofExplainCommand,
  proofExternalCommand,
  proofVerifyCommand,
} from './commands/proof.js';
import {
  productionBreakGlassCommand,
  productionCanaryCommand,
  productionCouncilCommand,
  productionDoctorCommand,
  productionInitLocalCommand,
  productionPromoteCommand,
} from './commands/production.js';
import {
  protocolAckCommand,
  protocolAdapterFailureCommand,
  protocolAdapterRecoveryCommand,
  protocolConflictCommand,
  protocolDoctorCommand,
  protocolEmitCommand,
  protocolInboxCommand,
  protocolInstrumentationMissingCommand,
  protocolPromoteCommand,
  protocolReplayCommand,
  protocolSendCommand,
} from './commands/protocol.js';
import {
  rllDoctorCommand,
  rllEmitCommand,
  rllSignalsCommand,
  rllStatusCommand,
  rsiCandidateCommand,
} from './commands/rll.js';
import {
  rsiRebuildCommand,
  rsiRecommendCommand,
} from './commands/rsi.js';
import { parseFromTarget, resolveTaskRef, type FromTarget } from './lib/tasks.js';
import type { CodeGraphProviderSelection } from './lib/codegraph/adapter.js';
import type {
  BcrxSubjectFields,
  EpistemicStatus,
  IdentityBindingStatus,
  ProtocolAssuranceContext,
  ProtocolMessageKind,
  PrivacyZone,
  VerificationTransactionStatus,
  VerifierSelectionMethod,
} from './lib/protocol/types.js';
import type { RllEventKind } from './lib/rll/types.js';
import type {
  MessageIntent,
  ReceiptKind,
} from './types.js';

// Resolve version from the shipped package.json so --version stays in
// sync with what npm published. Works in both bundled
// (`dist/cli.js` → `../package.json` = package root) and tsx-dev
// (`src/cli.ts` → `../package.json` = repo root) layouts.
function readPackageVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const raw = readFileSync(url, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

function notImplemented(name: string): () => never {
  return () => {
    process.stderr.write(`${name}: not yet implemented\n`);
    process.exit(2);
  };
}

function parsePhaseId(value: string): PhaseId {
  if (!(PHASE_IDS as readonly string[]).includes(value)) {
    throw new Error(
      `invalid phase '${value}'. Expected one of: ${PHASE_IDS.join(', ')}`,
    );
  }
  return value as PhaseId;
}

function parseCsv(value: string): readonly string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function collectValues(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function parseProtocolKind(value: string): ProtocolMessageKind {
  const allowed = new Set<ProtocolMessageKind>([
    'task_request',
    'agent_observation',
    'agent_proposal',
    'dissent',
    'decision',
    'handoff',
    'tool_result',
    'adapter_failure',
    'adapter_recovery',
    'conflict',
    'rll_signal',
    'receipt_notice',
  ]);
  if (!allowed.has(value as ProtocolMessageKind)) {
    throw new Error(`invalid protocol kind '${value}'`);
  }
  return value as ProtocolMessageKind;
}

function parseMessageIntent(value: string): MessageIntent {
  const allowed = new Set<MessageIntent>([
    'task.request',
    'question',
    'answer',
    'observation',
    'inference',
    'speculation',
    'artifact',
    'review.request',
    'review.finding',
    'challenge',
    'decision',
    'cancel',
    'heartbeat',
    'receipt.notice',
  ]);
  if (!allowed.has(value as MessageIntent)) {
    throw new Error(`invalid message intent '${value}'`);
  }
  return value as MessageIntent;
}

function parseReceiptKind(value: string): ReceiptKind {
  const allowed = new Set<ReceiptKind>([
    'sent',
    'delivered',
    'undeliverable',
    'read',
    'accepted',
    'rejected',
    'completed',
    'failed',
    'challenged',
    'verified',
    'conflict_recorded',
    'instrumentation_missing',
    'proof_unavailable',
  ]);
  if (!allowed.has(value as ReceiptKind)) {
    throw new Error(`invalid receipt kind '${value}'`);
  }
  return value as ReceiptKind;
}

function parseReceiptCsv(value: string): readonly ReceiptKind[] {
  return parseCsv(value).map(parseReceiptKind);
}

function parseAckReceiptKind(
  value: string,
): Extract<ReceiptKind, 'accepted' | 'rejected' | 'completed' | 'failed' | 'challenged'> {
  if (
    value === 'accepted'
    || value === 'rejected'
    || value === 'completed'
    || value === 'failed'
    || value === 'challenged'
  ) {
    return value;
  }
  throw new Error(`invalid ack receipt kind '${value}'`);
}

function parseRllKind(value: string): RllEventKind {
  const allowed = new Set<RllEventKind>([
    'observation',
    'failure',
    'correction',
    'dissent',
    'control_signal',
    'task_growth',
    'rsi_candidate',
    'conflict',
  ]);
  if (!allowed.has(value as RllEventKind)) {
    throw new Error(`invalid RLL kind '${value}'`);
  }
  return value as RllEventKind;
}

function parsePrivacyZone(value: string): PrivacyZone {
  const allowed = new Set<PrivacyZone>([
    'WORKSPACE',
    'LOCAL_ONLY',
    'HOSTED_REGIONAL',
    'ZDR_FRONTIER',
    'BLIND_SUBTASK',
    'SECRET_COMMITMENT_ONLY',
  ]);
  if (!allowed.has(value as PrivacyZone)) {
    throw new Error(`invalid privacy zone '${value}'`);
  }
  return value as PrivacyZone;
}

function parseIdentityBindingStatus(value: string): IdentityBindingStatus {
  const allowed = new Set<IdentityBindingStatus>([
    'unverified',
    'evidence_bound',
    'cryptographically_verified',
  ]);
  if (!allowed.has(value as IdentityBindingStatus)) {
    throw new Error(`invalid identity binding status '${value}'`);
  }
  return value as IdentityBindingStatus;
}

function parseMateriality(value: string): BcrxSubjectFields['materiality'] {
  const allowed = new Set<BcrxSubjectFields['materiality']>([
    'low',
    'medium',
    'high',
    'critical',
  ]);
  if (!allowed.has(value as BcrxSubjectFields['materiality'])) {
    throw new Error(`invalid materiality '${value}'`);
  }
  return value as BcrxSubjectFields['materiality'];
}

function parseVerifierSelectionMethod(value: string): VerifierSelectionMethod {
  const allowed = new Set<VerifierSelectionMethod>([
    'policy_registry',
    'fleet_consensus',
    'operator_assigned',
    'manual_by_implementer',
  ]);
  if (!allowed.has(value as VerifierSelectionMethod)) {
    throw new Error(`invalid verifier selection method '${value}'`);
  }
  return value as VerifierSelectionMethod;
}

function parseVerificationTransactionStatus(value: string): VerificationTransactionStatus {
  const allowed = new Set<VerificationTransactionStatus>([
    'unstarted',
    'prepared',
    'committed',
    'aborted',
  ]);
  if (!allowed.has(value as VerificationTransactionStatus)) {
    throw new Error(`invalid verification transaction status '${value}'`);
  }
  return value as VerificationTransactionStatus;
}

function parseZkFailurePolicy(value: string): 'fail_closed' | 'manual_hold' | 'degrade_to_signature_only_alpha' {
  if (
    value === 'fail_closed'
    || value === 'manual_hold'
    || value === 'degrade_to_signature_only_alpha'
  ) {
    return value;
  }
  throw new Error(`invalid ZK failure policy '${value}'`);
}

function parseEpistemicStatus(value: string): EpistemicStatus {
  const allowed = new Set<EpistemicStatus>([
    'observed',
    'inferred',
    'uncertain',
    'unsupported',
    'contradicted',
  ]);
  if (!allowed.has(value as EpistemicStatus)) {
    throw new Error(`invalid epistemic status '${value}'`);
  }
  return value as EpistemicStatus;
}

function parseCodeGraphProvider(value: string): CodeGraphProviderSelection {
  if (value === 'auto' || value === 'gitnexus' || value === 'fallback') {
    return value;
  }
  throw new Error(`invalid codegraph provider '${value}'`);
}

function parseProtocolAuditMode(value: string): 'tip' | 'full' {
  if (value === 'tip' || value === 'full') return value;
  throw new Error(`invalid protocol audit mode '${value}'`);
}

function parseProtocolDoctorProfile(value: string): 'alpha' | 'production' {
  if (value === 'alpha' || value === 'production') return value;
  throw new Error(`invalid protocol doctor profile '${value}'`);
}

function withProductionFleetOptions(command: Command): Command {
  return command
    .option('--fleet-config <path>', 'fleet config JSON path')
    .option('--v1-url <url>', 'live /v1/models URL or catalog base URL')
    .option('--v1-file <path>', 'V1 catalog snapshot file')
    .option('--consensus-v1-url <urls>', 'comma-separated secondary /v1/models URLs', parseCsv)
    .option('--consensus-v1-file <paths>', 'comma-separated secondary V1 catalog files', parseCsv)
    .option('--min-agreeing-sources <n>', 'minimum V1 sources required for consensus', (value) => Number.parseInt(value, 10))
    .option('--include-hosted', 'include hosted V1 records when they expose direct invocation endpoints')
    .option('--timeout-ms <n>', 'fleet/council timeout override in ms', (value) => Number.parseInt(value, 10));
}

/**
 * Resolve a CLI task argument. Accepts project-mode refs (no slash)
 * unchanged. For single-task refs, expands numeric shorthand
 * (`tick/1` → `tick/1-types`) and validates full-name refs against disk.
 */
function resolveOrExit(slug: string): string {
  try {
    return resolveTaskRef(slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(64);
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('harness')
    .description('AI engineering harness — ticket to reviewed branch')
    .version(readPackageVersion())
    .showHelpAfterError();

  program
    .command('ship')
    .description(
      'One-liner that chains import → plan → run → push → PR. Accepts a GitHub issue URL, a <project>, or <project>/<task>.',
    )
    .argument(
      '<input>',
      'GitHub issue URL, <project>, or <project>/<task>',
    )
    .option('--resume', 'continue after an escalation or interruption')
    .option(
      '--skip <taskNumber>',
      'mark task N as skipped-by-human and continue with the rest',
    )
    .option(
      '--restart <taskNumber>',
      're-run task N from preflight (clears its prior run state)',
    )
    .option(
      '--from <target>',
      're-run starting at <phase>, <task>, or <task>/<phase>',
      parseFromTarget,
    )
    .option('--dry-run', 'print the plan and exit without running')
    .option('--non-interactive', 'never prompt; warn and continue on mismatch')
    .option('--force', 'bypass confirmation prompts (e.g. fresh project run)')
    .action(
      async (
        input: string,
        opts: {
          resume?: boolean;
          skip?: string;
          restart?: string;
          from?: FromTarget;
          dryRun?: boolean;
          nonInteractive?: boolean;
          force?: boolean;
        },
      ) => {
        const args: ShipCommandArgs = {
          input,
          resume: opts.resume === true,
          dryRun: opts.dryRun === true,
          nonInteractive: opts.nonInteractive === true,
          force: opts.force === true,
          ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
          ...(opts.restart !== undefined ? { restart: opts.restart } : {}),
          ...(opts.from !== undefined ? { from: opts.from } : {}),
        };
        const code = await shipCommand(args);
        process.exit(code);
      },
    );

  program
    .command('run')
    .description(
      'Run the pipeline for a single task (<project>/<task>) or every task in a project (<project>).',
    )
    .argument('[task]', '<project>/<task> (single) or <project> (project mode)')
    .option(
      '--stop-after <phaseOrTask>',
      'single-task: stop after the named phase. project: stop after the named task.',
    )
    .option(
      '--from <target>',
      'force start from <phase> (single-task), <task>, or <task>/<phase> (project mode)',
      parseFromTarget,
    )
    .option('--dry-run', 'print the plan and exit without running')
    .option(
      '--resume',
      'single-task: resume the most recent run. project: keep tasks already complete; retry only the rest.',
    )
    .option(
      '--force',
      'project mode: skip the "discard prior state" confirmation prompt',
    )
    .option('--non-interactive', 'never prompt; warn and continue on mismatch')
    .action(
      async (
        task: string | undefined,
        opts: {
          stopAfter?: string;
          from?: FromTarget;
          dryRun?: boolean;
          resume?: boolean;
          force?: boolean;
          nonInteractive?: boolean;
        },
      ) => {
        const resolved = task !== undefined ? resolveOrExit(task) : undefined;
        const args: RunCommandArgs = {
          ...(resolved !== undefined ? { task: resolved } : {}),
          ...(opts.stopAfter !== undefined ? { stopAfter: opts.stopAfter } : {}),
          ...(opts.from !== undefined ? { from: opts.from } : {}),
          dryRun: opts.dryRun === true,
          resume: opts.resume === true,
          force: opts.force === true,
          nonInteractive: opts.nonInteractive === true,
        };
        const code = await runCommand(args);
        process.exit(code);
      },
    );

  program
    .command('resume <task>')
    .description('Alias for `run <task> --resume`. Takes the same flags as run.')
    .option(
      '--from <target>',
      'force start from <phase>, <task>, or <task>/<phase>',
      parseFromTarget,
    )
    .option('--stop-after <phase>', 'stop after the named phase completes')
    .option('--dry-run', 'print the phase plan and exit without running')
    .option('--non-interactive', 'never prompt; warn and continue on mismatch')
    .action(
      async (
        task: string,
        opts: {
          from?: FromTarget;
          stopAfter?: string;
          dryRun?: boolean;
          nonInteractive?: boolean;
        },
      ) => {
        const resolved = resolveOrExit(task);
        if (!resolved.includes('/')) {
          process.stderr.write(
            'resume: project-level resume is not supported. Pass a specific <project>/<task> reference.\n',
          );
          process.exit(64);
        }
        const args: RunCommandArgs = {
          task: resolved,
          resume: true,
          force: false,
          dryRun: opts.dryRun === true,
          nonInteractive: opts.nonInteractive === true,
          ...(opts.stopAfter !== undefined ? { stopAfter: opts.stopAfter } : {}),
          ...(opts.from !== undefined ? { from: opts.from } : {}),
        };
        const code = await runCommand(args);
        process.exit(code);
      },
    );

  program
    .command('init')
    .description('Scaffold .claude/ and harness/ in a fresh repo')
    .option('--framework <framework>', 'react or nextjs', 'nextjs')
    .option('--force', 'overwrite existing files')
    .action(async (opts: { framework?: string; force?: boolean }) => {
      const framework = opts.framework === 'react' ? 'react' : 'nextjs';
      const code = await initCommand({
        framework,
        force: opts.force === true,
      });
      process.exit(code);
    });

  program.command('plan <project>').description('Brief → task breakdown (stub)').action(notImplemented('plan'));
  program.command('import <project>').description('GitHub Issues → task files (stub)').action(notImplemented('import'));
  program.command('patch <task>').description('Scoped patch run (stub)').action(notImplemented('patch'));

  program
    .command('status')
    .description('Show project / task state overview')
    .option('--project <project>', 'filter to a single project')
    .action(async (opts: { project?: string }) => {
      const code = await statusCommand({
        ...(opts.project !== undefined ? { project: opts.project } : {}),
      });
      process.exit(code);
    });

  program
    .command('debug <task>')
    .description('Inspect runs, phases, prompts for a given task')
    .option('--run <id>', 'drill into a specific run')
    .option('--phase <phase>', 'drill into a specific phase of the run', parsePhaseId)
    .action(
      async (
        task: string,
        opts: { run?: string; phase?: PhaseId },
      ) => {
        const resolved = resolveOrExit(task);
        const code = await debugCommand({
          task: resolved,
          ...(opts.run !== undefined ? { run: opts.run } : {}),
          ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
        });
        process.exit(code);
      },
    );

  const models = program
    .command('models')
    .description('Inspect and probe configured model adapters');

  models
    .command('list')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) => {
      const code = await modelsListCommand({
        json: opts.json === true,
      });
      process.exit(code);
    });

  models
    .command('probe [model-or-route]')
    .option('--timeout-ms <n>', 'probe timeout in ms', (value) => Number.parseInt(value, 10))
    .option('--json', 'output JSON')
    .action(async (target: string | undefined, opts: { timeoutMs?: number; json?: boolean }) => {
      const code = await modelsProbeCommand({
        ...(target !== undefined ? { target } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const codegraph = program
    .command('codegraph')
    .description('Inspect and refresh the code graph provider with receipts');

  codegraph
    .command('status')
    .option('--repo-root <path>', 'repo root to inspect')
    .option('--provider <provider>', 'auto, gitnexus, or fallback', parseCodeGraphProvider)
    .option('--json', 'output JSON')
    .action(async (opts: { repoRoot?: string; provider?: CodeGraphProviderSelection; json?: boolean }) => {
      const code = await codegraphStatusCommand({
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  codegraph
    .command('refresh')
    .option('--repo-root <path>', 'repo root to inspect')
    .option('--provider <provider>', 'auto, gitnexus, or fallback', parseCodeGraphProvider)
    .option('--force', 'force provider refresh')
    .option('--include-generated', 'allow generated/context output from provider')
    .option('--json', 'output JSON')
    .action(async (opts: {
      repoRoot?: string;
      provider?: CodeGraphProviderSelection;
      force?: boolean;
      includeGenerated?: boolean;
      json?: boolean;
    }) => {
      const code = await codegraphRefreshCommand({
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        force: opts.force === true,
        sidecarOnly: opts.includeGenerated !== true,
        json: opts.json === true,
      });
      process.exit(code);
    });

  codegraph
    .command('impact')
    .option('--repo-root <path>', 'repo root to inspect')
    .option('--provider <provider>', 'auto, gitnexus, or fallback', parseCodeGraphProvider)
    .option('--path <path>', 'changed path subject')
    .option('--symbol <symbol>', 'changed symbol subject')
    .option('--depth <n>', 'impact depth', (value) => Number.parseInt(value, 10), 2)
    .option('--json', 'output JSON')
    .action(async (opts: {
      repoRoot?: string;
      provider?: CodeGraphProviderSelection;
      path?: string;
      symbol?: string;
      depth?: number;
      json?: boolean;
    }) => {
      const code = await codegraphImpactCommand({
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
        depth: opts.depth ?? 2,
        json: opts.json === true,
      });
      process.exit(code);
    });

  codegraph
    .command('tests')
    .option('--repo-root <path>', 'repo root to inspect')
    .option('--provider <provider>', 'auto, gitnexus, or fallback', parseCodeGraphProvider)
    .option('--path <path>', 'changed path subject')
    .option('--symbol <symbol>', 'changed symbol subject')
    .option('--json', 'output JSON')
    .action(async (opts: {
      repoRoot?: string;
      provider?: CodeGraphProviderSelection;
      path?: string;
      symbol?: string;
      json?: boolean;
    }) => {
      const code = await codegraphTestsCommand({
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(opts.path !== undefined ? { path: opts.path } : {}),
        ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  codegraph
    .command('doctor')
    .option('--repo-root <path>', 'repo root to inspect')
    .option('--provider <provider>', 'auto, gitnexus, or fallback', parseCodeGraphProvider)
    .option('--json', 'output JSON')
    .action(async (opts: { repoRoot?: string; provider?: CodeGraphProviderSelection; json?: boolean }) => {
      const code = await codegraphDoctorCommand({
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  codegraph
    .command('receipt <ref>')
    .option('--repo-root <path>', 'repo root to inspect')
    .option('--json', 'output JSON')
    .action(async (ref: string, opts: { repoRoot?: string; json?: boolean }) => {
      const code = await codegraphReceiptCommand({
        ref,
        ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const protocol = program
    .command('protocol')
    .description('Append and inspect Super Harness v2 protocol sidecars');

  protocol
    .command('send')
    .requiredOption('--run-dir <path>', 'run directory containing bus sidecars')
    .requiredOption('--from <agent>', 'sender agent id')
    .requiredOption('--to <agents>', 'comma-separated recipient agent ids', parseCsv)
    .requiredOption('--intent <intent>', 'message intent', parseMessageIntent)
    .option('--body <jsonOrText>', 'message body JSON or text')
    .option('--thread-id <id>', 'thread id')
    .option('--idempotency-key <key>', 'dedupe key for retry-safe send')
    .option('--deadline <iso>', 'deadline timestamp')
    .option('--required-receipts <kinds>', 'comma-separated required lifecycle receipts', parseReceiptCsv)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      from: string;
      to: readonly string[];
      intent: MessageIntent;
      body?: string;
      threadId?: string;
      idempotencyKey?: string;
      deadline?: string;
      requiredReceipts?: readonly ReceiptKind[];
      json?: boolean;
    }) => {
      const code = await protocolSendCommand({
        runDir: opts.runDir,
        from: opts.from,
        to: opts.to,
        intent: opts.intent,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
        ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
        ...(opts.requiredReceipts !== undefined ? { requiredReceipts: opts.requiredReceipts } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('inbox')
    .requiredOption('--run-dir <path>', 'run directory containing bus sidecars')
    .requiredOption('--agent <agent>', 'recipient agent id')
    .option('--mark-read', 'append read receipts for unread messages')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; agent: string; markRead?: boolean; json?: boolean }) => {
      const code = await protocolInboxCommand({
        runDir: opts.runDir,
        agentId: opts.agent,
        markRead: opts.markRead === true,
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('ack')
    .requiredOption('--run-dir <path>', 'run directory containing bus sidecars')
    .requiredOption('--agent <agent>', 'agent issuing the receipt')
    .requiredOption('--message <id>', 'message id to acknowledge')
    .option('--kind <kind>', 'accepted, rejected, completed, failed, or challenged', parseAckReceiptKind, 'accepted')
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      agent: string;
      message: string;
      kind: Extract<ReceiptKind, 'accepted' | 'rejected' | 'completed' | 'failed' | 'challenged'>;
      json?: boolean;
    }) => {
      const code = await protocolAckCommand({
        runDir: opts.runDir,
        agentId: opts.agent,
        messageId: opts.message,
        kind: opts.kind,
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('replay')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await protocolReplayCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('doctor')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--audit <mode>', 'tip or full sidecar audit', parseProtocolAuditMode)
    .option('--profile <profile>', 'alpha or production readiness profile', parseProtocolDoctorProfile)
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; audit?: 'tip' | 'full'; profile?: 'alpha' | 'production'; json?: boolean }) => {
      const code = await protocolDoctorCommand({
        runDir: opts.runDir,
        ...(opts.audit !== undefined ? { auditMode: opts.audit } : {}),
        ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('promote')
    .description('Hard-gate an alpha run before production promotion')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await protocolPromoteCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('emit')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .requiredOption('--kind <kind>', 'protocol message kind', parseProtocolKind)
    .requiredOption('--from <agent>', 'sender agent id')
    .option('--to <agents>', 'comma-separated receiver agent ids', parseCsv, ['superharness.control'])
    .option('--subject <json>', 'BCRX subject JSON')
    .option('--body <jsonOrText>', 'message body JSON or text')
    .option('--evidence <ids>', 'comma-separated evidence ids', parseCsv)
    .option('--epistemic <status>', 'observed, inferred, uncertain, unsupported, contradicted', parseEpistemicStatus)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      kind: ProtocolMessageKind;
      from: string;
      to: readonly string[];
      subject?: string;
      body?: string;
      evidence?: readonly string[];
      epistemic?: EpistemicStatus;
      json?: boolean;
    }) => {
      const code = await protocolEmitCommand({
        runDir: opts.runDir,
        kind: opts.kind,
        from: opts.from,
        to: opts.to,
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.evidence !== undefined ? { evidenceRefs: opts.evidence } : {}),
        ...(opts.epistemic !== undefined ? { epistemicStatus: opts.epistemic } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('adapter-failure')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .requiredOption('--adapter <id>', 'adapter id')
    .requiredOption('--provider <id>', 'provider id')
    .requiredOption('--error <message>', 'failure message')
    .option('--model <id>', 'model id')
    .option('--command <cmd>', 'command attempted')
    .option('--exit-code <n>', 'process exit code', (value) => Number.parseInt(value, 10))
    .option('--stderr <text>', 'stderr tail')
    .option('--stdout <text>', 'stdout tail')
    .option('--duration-ms <n>', 'duration in ms', (value) => Number.parseInt(value, 10))
    .option('--timed-out', 'adapter timed out')
    .option('--assurance-context <context>', 'alpha or production subject assurance context', parseProtocolDoctorProfile)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      adapter: string;
      provider: string;
      error: string;
      model?: string;
      command?: string;
      exitCode?: number;
      stderr?: string;
      stdout?: string;
      durationMs?: number;
      timedOut?: boolean;
      assuranceContext?: ProtocolAssuranceContext;
      json?: boolean;
    }) => {
      const code = await protocolAdapterFailureCommand({
        runDir: opts.runDir,
        adapterId: opts.adapter,
        providerId: opts.provider,
        error: opts.error,
        ...(opts.model !== undefined ? { modelId: opts.model } : {}),
        ...(opts.command !== undefined ? { command: opts.command } : {}),
        ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
        ...(opts.stderr !== undefined ? { stderr: opts.stderr } : {}),
        ...(opts.stdout !== undefined ? { stdout: opts.stdout } : {}),
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
        timedOut: opts.timedOut === true,
        ...(opts.assuranceContext !== undefined ? { assuranceContext: opts.assuranceContext } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('adapter-recovery')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .requiredOption('--adapter <id>', 'adapter id')
    .requiredOption('--provider <id>', 'provider id')
    .requiredOption('--verifier <agent>', 'independent verifier confirming recovery')
    .requiredOption('--evidence <ids>', 'comma-separated evidence ids proving recovery', parseCsv)
    .option('--model <id>', 'model id')
    .option('--adapter-instance <id>', 'concrete adapter instance id bound by this recovery')
    .option('--adapter-version <version>', 'adapter implementation or deployment version bound by this recovery')
    .option('--recovered-by <agent>', 'agent that repaired or re-enabled the adapter')
    .option('--identity-verifier <agent>', 'distinct verifier for identity-binding evidence')
    .option('--verifier-selection <method>', 'policy_registry, fleet_consensus, operator_assigned, manual_by_implementer', parseVerifierSelectionMethod)
    .option('--verifier-policy <ref>', 'registry, consensus, or operator-assignment policy ref')
    .option('--verifier-trust-anchor <ref>', 'trust anchor for the recovery verifier identity')
    .option('--verifier-attestation <ids>', 'comma-separated attestation evidence refs for recovery verifier', parseCsv)
    .option('--identity-verifier-trust-anchor <ref>', 'trust anchor for the identity verifier')
    .option('--identity-verifier-attestation <ids>', 'comma-separated attestation evidence refs for identity verifier', parseCsv)
    .option('--verification-evidence <ids>', 'comma-separated evidence ids for verifier decision', parseCsv)
    .option('--identity-binding <ids>', 'comma-separated evidence refs proving verifier identity binding', parseCsv)
    .option('--identity-binding-status <status>', 'unverified, evidence_bound, or cryptographically_verified', parseIdentityBindingStatus)
    .option('--transaction-id <id>', 'verify-bind transaction id')
    .option('--transaction-status <status>', 'unstarted, prepared, committed, or aborted', parseVerificationTransactionStatus)
    .option('--transaction-prepared-at <timestamp>', 'verify-bind transaction prepared timestamp')
    .option('--transaction-committed-at <timestamp>', 'verify-bind transaction committed timestamp')
    .option('--resolves-evidence <ids>', 'comma-separated adapter failure evidence ids superseded by this recovery', parseCsv)
    .option('--resolves-subject <ids>', 'comma-separated subject ids superseded by this recovery', parseCsv)
    .option('--note <text>', 'operator-visible recovery note')
    .option('--assurance-context <context>', 'alpha or production subject assurance context', parseProtocolDoctorProfile)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      adapter: string;
      provider: string;
      verifier: string;
      evidence: readonly string[];
      model?: string;
      adapterInstance?: string;
      adapterVersion?: string;
      recoveredBy?: string;
      identityVerifier?: string;
      verifierSelection?: VerifierSelectionMethod;
      verifierPolicy?: string;
      verifierTrustAnchor?: string;
      verifierAttestation?: readonly string[];
      identityVerifierTrustAnchor?: string;
      identityVerifierAttestation?: readonly string[];
      verificationEvidence?: readonly string[];
      identityBinding?: readonly string[];
      identityBindingStatus?: IdentityBindingStatus;
      transactionId?: string;
      transactionStatus?: VerificationTransactionStatus;
      transactionPreparedAt?: string;
      transactionCommittedAt?: string;
      resolvesEvidence?: readonly string[];
      resolvesSubject?: readonly string[];
      note?: string;
      assuranceContext?: ProtocolAssuranceContext;
      json?: boolean;
    }) => {
      const code = await protocolAdapterRecoveryCommand({
        runDir: opts.runDir,
        adapterId: opts.adapter,
        providerId: opts.provider,
        verifierAgentId: opts.verifier,
        recoveryEvidenceRefs: opts.evidence,
        ...(opts.model !== undefined ? { modelId: opts.model } : {}),
        ...(opts.adapterInstance !== undefined ? { adapterInstanceId: opts.adapterInstance } : {}),
        ...(opts.adapterVersion !== undefined ? { adapterVersion: opts.adapterVersion } : {}),
        ...(opts.recoveredBy !== undefined ? { recoveredByAgentId: opts.recoveredBy } : {}),
        ...(opts.identityVerifier !== undefined ? { identityVerifierAgentId: opts.identityVerifier } : {}),
        ...(opts.verifierSelection !== undefined ? { verifierSelectionMethod: opts.verifierSelection } : {}),
        ...(opts.verifierPolicy !== undefined ? { verifierPolicyRef: opts.verifierPolicy } : {}),
        ...(opts.verifierTrustAnchor !== undefined ? { verifierTrustAnchorRef: opts.verifierTrustAnchor } : {}),
        ...(opts.verifierAttestation !== undefined ? { verifierAttestationRefs: opts.verifierAttestation } : {}),
        ...(opts.identityVerifierTrustAnchor !== undefined ? { identityVerifierTrustAnchorRef: opts.identityVerifierTrustAnchor } : {}),
        ...(opts.identityVerifierAttestation !== undefined ? { identityVerifierAttestationRefs: opts.identityVerifierAttestation } : {}),
        ...(opts.verificationEvidence !== undefined ? { verificationEvidenceRefs: opts.verificationEvidence } : {}),
        ...(opts.identityBinding !== undefined ? { identityBindingRefs: opts.identityBinding } : {}),
        ...(opts.identityBindingStatus !== undefined ? { identityBindingStatus: opts.identityBindingStatus } : {}),
        ...(opts.transactionId !== undefined ? { transactionId: opts.transactionId } : {}),
        ...(opts.transactionStatus !== undefined ? { transactionStatus: opts.transactionStatus } : {}),
        ...(opts.transactionPreparedAt !== undefined ? { transactionPreparedAt: opts.transactionPreparedAt } : {}),
        ...(opts.transactionCommittedAt !== undefined ? { transactionCommittedAt: opts.transactionCommittedAt } : {}),
        ...(opts.resolvesEvidence !== undefined ? { resolvesEvidenceIds: opts.resolvesEvidence } : {}),
        ...(opts.resolvesSubject !== undefined ? { resolvesSubjectIds: opts.resolvesSubject } : {}),
        ...(opts.note !== undefined ? { note: opts.note } : {}),
        ...(opts.assuranceContext !== undefined ? { assuranceContext: opts.assuranceContext } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('instrumentation-missing')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .requiredOption('--observer <id>', 'observer or telemetry stream id')
    .requiredOption('--expected-signal <name>', 'signal required before forensic verdict')
    .requiredOption('--reason <text>', 'why instrumentation is missing or insufficient')
    .option('--assurance-context <context>', 'alpha or production subject assurance context', parseProtocolDoctorProfile)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      observer: string;
      expectedSignal: string;
      reason: string;
      assuranceContext?: ProtocolAssuranceContext;
      json?: boolean;
    }) => {
      const code = await protocolInstrumentationMissingCommand({
        runDir: opts.runDir,
        observer: opts.observer,
        expectedSignal: opts.expectedSignal,
        reason: opts.reason,
        ...(opts.assuranceContext !== undefined ? { assuranceContext: opts.assuranceContext } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  protocol
    .command('conflict')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .requiredOption('--conflict-id <id>', 'stable conflict id')
    .requiredOption('--title <text>', 'short conflict title')
    .requiredOption('--description <text>', 'conflict details')
    .option('--severity <level>', 'low, medium, high, critical')
    .option('--evidence <ids>', 'comma-separated evidence ids', parseCsv)
    .option('--implementer <agent>', 'agent that authored/deployed/owned the conflicted change')
    .option('--verifier <agent>', 'independent verifier allowed to close the conflict')
    .option('--identity-verifier <agent>', 'distinct verifier for identity-binding evidence')
    .option('--verifier-selection <method>', 'policy_registry, fleet_consensus, operator_assigned, manual_by_implementer', parseVerifierSelectionMethod)
    .option('--verifier-policy <ref>', 'registry, consensus, or operator-assignment policy ref')
    .option('--verifier-trust-anchor <ref>', 'trust anchor for the recovery verifier identity')
    .option('--verifier-attestation <ids>', 'comma-separated attestation evidence refs for recovery verifier', parseCsv)
    .option('--identity-verifier-trust-anchor <ref>', 'trust anchor for the identity verifier')
    .option('--identity-verifier-attestation <ids>', 'comma-separated attestation evidence refs for identity verifier', parseCsv)
    .option('--verification-evidence <ids>', 'comma-separated evidence ids for independent verification', parseCsv)
    .option('--instrumentation <ids>', 'comma-separated instrumentation proof evidence ids', parseCsv)
    .option('--identity-binding <ids>', 'comma-separated evidence refs proving verifier identity binding', parseCsv)
    .option('--identity-binding-status <status>', 'unverified, evidence_bound, or cryptographically_verified', parseIdentityBindingStatus)
    .option('--resolved', 'mark conflict as resolved')
    .option('--assurance-context <context>', 'alpha or production subject assurance context', parseProtocolDoctorProfile)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      conflictId: string;
      title: string;
      description: string;
      severity?: string;
      evidence?: readonly string[];
      implementer?: string;
      verifier?: string;
      identityVerifier?: string;
      verifierSelection?: VerifierSelectionMethod;
      verifierPolicy?: string;
      verifierTrustAnchor?: string;
      verifierAttestation?: readonly string[];
      identityVerifierTrustAnchor?: string;
      identityVerifierAttestation?: readonly string[];
      verificationEvidence?: readonly string[];
      instrumentation?: readonly string[];
      identityBinding?: readonly string[];
      identityBindingStatus?: IdentityBindingStatus;
      resolved?: boolean;
      assuranceContext?: ProtocolAssuranceContext;
      json?: boolean;
    }) => {
      const code = await protocolConflictCommand({
        runDir: opts.runDir,
        conflictId: opts.conflictId,
        title: opts.title,
        description: opts.description,
        ...(opts.severity !== undefined ? { severity: parseMateriality(opts.severity) } : {}),
        ...(opts.evidence !== undefined ? { evidenceRefs: opts.evidence } : {}),
        ...(opts.implementer !== undefined ? { implementerAgentId: opts.implementer } : {}),
        ...(opts.verifier !== undefined ? { verifierAgentId: opts.verifier } : {}),
        ...(opts.identityVerifier !== undefined ? { identityVerifierAgentId: opts.identityVerifier } : {}),
        ...(opts.verifierSelection !== undefined ? { verifierSelectionMethod: opts.verifierSelection } : {}),
        ...(opts.verifierPolicy !== undefined ? { verifierPolicyRef: opts.verifierPolicy } : {}),
        ...(opts.verifierTrustAnchor !== undefined ? { verifierTrustAnchorRef: opts.verifierTrustAnchor } : {}),
        ...(opts.verifierAttestation !== undefined ? { verifierAttestationRefs: opts.verifierAttestation } : {}),
        ...(opts.identityVerifierTrustAnchor !== undefined ? { identityVerifierTrustAnchorRef: opts.identityVerifierTrustAnchor } : {}),
        ...(opts.identityVerifierAttestation !== undefined ? { identityVerifierAttestationRefs: opts.identityVerifierAttestation } : {}),
        ...(opts.verificationEvidence !== undefined ? { verificationEvidenceRefs: opts.verificationEvidence } : {}),
        ...(opts.instrumentation !== undefined ? { instrumentationRefs: opts.instrumentation } : {}),
        ...(opts.identityBinding !== undefined ? { identityBindingRefs: opts.identityBinding } : {}),
        ...(opts.identityBindingStatus !== undefined ? { identityBindingStatus: opts.identityBindingStatus } : {}),
        resolved: opts.resolved === true,
        ...(opts.assuranceContext !== undefined ? { assuranceContext: opts.assuranceContext } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const rll = program
    .command('rll')
    .description('Record RLL events, derive control signals, and index RSI candidates');

  rll
    .command('status')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await rllStatusCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  rll
    .command('emit')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .requiredOption('--kind <kind>', 'RLL event kind', parseRllKind)
    .requiredOption('--summary <text>', 'event summary')
    .option('--subject <json>', 'BCRX subject JSON')
    .option('--source <id>', 'source agent or adapter id')
    .option('--input-refs <ids>', 'comma-separated input refs', parseCsv)
    .option('--output-refs <ids>', 'comma-separated output refs', parseCsv)
    .option('--confidence <n>', 'confidence 0..1', Number.parseFloat)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      kind: RllEventKind;
      summary: string;
      subject?: string;
      source?: string;
      inputRefs?: readonly string[];
      outputRefs?: readonly string[];
      confidence?: number;
      json?: boolean;
    }) => {
      const code = await rllEmitCommand({
        runDir: opts.runDir,
        kind: opts.kind,
        summary: opts.summary,
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(opts.inputRefs !== undefined ? { inputRefs: opts.inputRefs } : {}),
        ...(opts.outputRefs !== undefined ? { outputRefs: opts.outputRefs } : {}),
        ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  rll
    .command('signals')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await rllSignalsCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  rll
    .command('doctor')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--audit <mode>', 'tip or full RLL audit', parseProtocolAuditMode)
    .option('--profile <profile>', 'alpha or production readiness profile', parseProtocolDoctorProfile)
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; audit?: 'tip' | 'full'; profile?: 'alpha' | 'production'; json?: boolean }) => {
      const code = await rllDoctorCommand({
        runDir: opts.runDir,
        ...(opts.audit !== undefined ? { auditMode: opts.audit } : {}),
        ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  rll
    .command('rsi-candidate')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .requiredOption('--hypothesis <text>', 'candidate improvement hypothesis')
    .requiredOption('--expected-benefit <text>', 'expected benefit')
    .requiredOption('--risk <text>', 'risk statement')
    .option('--subject <json>', 'BCRX subject JSON')
    .option('--evidence <ids>', 'comma-separated evidence ids', parseCsv)
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      hypothesis: string;
      expectedBenefit: string;
      risk: string;
      subject?: string;
      evidence?: readonly string[];
      json?: boolean;
    }) => {
      const code = await rsiCandidateCommand({
        runDir: opts.runDir,
        hypothesis: opts.hypothesis,
        expectedBenefit: opts.expectedBenefit,
        risk: opts.risk,
        ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
        ...(opts.evidence !== undefined ? { evidenceRefs: opts.evidence } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const rsi = program
    .command('rsi')
    .description('Recommend bounded RSI actions from RLL and AgentOps signals');

  rsi
    .command('rebuild')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await rsiRebuildCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  rsi
    .command('recommend')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await rsiRecommendCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  const privacy = program
    .command('privacy')
    .description('Run privacy-zone preflight checks before routing messages');

  privacy
    .command('preflight')
    .requiredOption('--target-zone <zone>', 'target privacy zone', parsePrivacyZone)
    .option('--source-zone <zone>', 'source privacy zone', parsePrivacyZone)
    .option('--text <text>', 'text to check')
    .option('--file <path>', 'file to check')
    .option('--run-dir <path>', 'optional run directory for evidence receipt')
    .option('--json', 'output JSON')
    .action(async (opts: {
      targetZone: PrivacyZone;
      sourceZone?: PrivacyZone;
      text?: string;
      file?: string;
      runDir?: string;
      json?: boolean;
    }) => {
      const code = await privacyPreflightCommand({
        targetZone: opts.targetZone,
        ...(opts.sourceZone !== undefined ? { sourceZone: opts.sourceZone } : {}),
        ...(opts.text !== undefined ? { text: opts.text } : {}),
        ...(opts.file !== undefined ? { file: opts.file } : {}),
        ...(opts.runDir !== undefined ? { runDir: opts.runDir } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const fleet = program
    .command('fleet')
    .description('Inspect configured local/cloud fleet adapters and live model availability');

  const proof = program
    .command('proof')
    .description('Create and verify alpha proof attestations');

  proof
    .command('attest')
    .requiredOption('--statement <text>', 'attestation statement')
    .requiredOption('--public-inputs <jsonOrText>', 'public inputs JSON or text')
    .option('--mock-zk', 'include a deterministic mock-local transcript; not a real SNARK')
    .option('--json', 'output JSON')
    .action(async (opts: {
      statement: string;
      publicInputs: string;
      mockZk?: boolean;
      json?: boolean;
    }) => {
      const code = await proofAttestCommand({
        statement: opts.statement,
        publicInputs: opts.publicInputs,
        mockZk: opts.mockZk === true,
        json: opts.json === true,
      });
      process.exit(code);
    });

  proof
    .command('verify')
    .requiredOption('--file <path>', 'JSON file containing a protocol attestation')
    .option('--json', 'output JSON')
    .action(async (opts: { file: string; json?: boolean }) => {
      const code = await proofVerifyCommand({
        file: opts.file,
        json: opts.json === true,
      });
      process.exit(code);
    });

  proof
    .command('explain')
    .requiredOption('--file <path>', 'JSON file containing a protocol attestation')
    .option('--json', 'output JSON')
    .action(async (opts: { file: string; json?: boolean }) => {
      const code = await proofExplainCommand({
        file: opts.file,
        json: opts.json === true,
      });
      process.exit(code);
    });

  proof
    .command('external')
    .requiredOption('--statement <text>', 'statement to prove')
    .requiredOption('--public-inputs <json>', 'JSON public inputs')
    .option('--command <path>', 'external prover command; defaults to proofs.zkSnarks.command')
    .option('--arg <value>', 'append an external prover argument', collectValues, [])
    .option('--timeout-ms <n>', 'external prover timeout', (value) => Number.parseInt(value, 10))
    .option('--max-output-bytes <n>', 'external prover stdout/stderr output budget', (value) => Number.parseInt(value, 10))
    .option('--max-latency-ms <n>', 'production proof latency budget', (value) => Number.parseInt(value, 10))
    .option('--circuit-id <id>', 'proof circuit id')
    .option('--circuit-version <version>', 'proof circuit version')
    .option('--verifier-ref <ref>', 'verifier or verifying-key reference')
    .option('--setup-hash <hash>', 'trusted setup or proving key hash')
    .option('--failure-policy <policy>', 'fail_closed, manual_hold, or degrade_to_signature_only_alpha', parseZkFailurePolicy)
    .option('--json', 'output JSON')
    .action(async (opts: {
      statement: string;
      publicInputs: string;
      command?: string;
      arg?: readonly string[];
      timeoutMs?: number;
      maxOutputBytes?: number;
      maxLatencyMs?: number;
      circuitId?: string;
      circuitVersion?: string;
      verifierRef?: string;
      setupHash?: string;
      failurePolicy?: ReturnType<typeof parseZkFailurePolicy>;
      json?: boolean;
    }) => {
      const code = await proofExternalCommand({
        statement: opts.statement,
        publicInputs: opts.publicInputs,
        ...(opts.command !== undefined ? { command: opts.command } : {}),
        ...(opts.arg !== undefined && opts.arg.length > 0 ? { args: opts.arg } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
        ...(opts.maxLatencyMs !== undefined ? { maxLatencyMs: opts.maxLatencyMs } : {}),
        ...(opts.circuitId !== undefined ? { circuitId: opts.circuitId } : {}),
        ...(opts.circuitVersion !== undefined ? { circuitVersion: opts.circuitVersion } : {}),
        ...(opts.verifierRef !== undefined ? { verifierRef: opts.verifierRef } : {}),
        ...(opts.setupHash !== undefined ? { setupHash: opts.setupHash } : {}),
        ...(opts.failurePolicy !== undefined ? { failurePolicy: opts.failurePolicy } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const production = program
    .command('production')
    .description('Run production promotion, canary, break-glass, and council gates');

  production
    .command('init-local')
    .requiredOption('--v1-url <url>', 'local live /v1/models URL or catalog base URL')
    .requiredOption('--operator <id>', 'operator id for local production signing and command group')
    .option('--command-group <ids>', 'comma-separated command-group member ids', parseCsv)
    .option('--required-approvals <n>', 'required command-group approvals', (value) => Number.parseInt(value, 10))
    .option('--config-local-file <path>', 'output harness config.local.json path')
    .option('--fleet-config-file <path>', 'output local fleet config path')
    .option('--witness-catalog-file <path>', 'output V1 witness snapshot path')
    .option('--private-key-file <path>', 'output operator Ed25519 PKCS8 private key path')
    .option('--revocation-list-file <path>', 'output revocation list JSON path')
    .option('--zk-prover-file <path>', 'output local external ZK prover shim path')
    .option('--key-valid-days <n>', 'operator signing key lifetime in days', (value) => Number.parseInt(value, 10))
    .option('--timeout-ms <n>', 'V1 snapshot timeout and generated fleet timeout in ms', (value) => Number.parseInt(value, 10))
    .option('--force', 'overwrite existing local bootstrap files')
    .option('--json', 'output JSON')
    .action(async (opts: {
      v1Url: string;
      operator: string;
      commandGroup?: readonly string[];
      requiredApprovals?: number;
      configLocalFile?: string;
      fleetConfigFile?: string;
      witnessCatalogFile?: string;
      privateKeyFile?: string;
      revocationListFile?: string;
      zkProverFile?: string;
      keyValidDays?: number;
      timeoutMs?: number;
      force?: boolean;
      json?: boolean;
    }) => {
      const code = await productionInitLocalCommand({
        v1ModelsUrl: opts.v1Url,
        operatorId: opts.operator,
        ...(opts.commandGroup !== undefined ? { commandGroupMembers: opts.commandGroup } : {}),
        ...(opts.requiredApprovals !== undefined ? { requiredApprovals: opts.requiredApprovals } : {}),
        ...(opts.configLocalFile !== undefined ? { configLocalFile: opts.configLocalFile } : {}),
        ...(opts.fleetConfigFile !== undefined ? { fleetConfigFile: opts.fleetConfigFile } : {}),
        ...(opts.witnessCatalogFile !== undefined ? { witnessCatalogFile: opts.witnessCatalogFile } : {}),
        ...(opts.privateKeyFile !== undefined ? { privateKeyFile: opts.privateKeyFile } : {}),
        ...(opts.revocationListFile !== undefined ? { revocationListFile: opts.revocationListFile } : {}),
        ...(opts.zkProverFile !== undefined ? { zkProverFile: opts.zkProverFile } : {}),
        ...(opts.keyValidDays !== undefined ? { keyValidDays: opts.keyValidDays } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        force: opts.force === true,
        json: opts.json === true,
      });
      process.exit(code);
    });

  withProductionFleetOptions(
    production
      .command('doctor')
      .requiredOption('--run-dir <path>', 'run directory containing sidecars')
      .option('--json', 'output JSON'),
  )
    .action(async (opts: {
      runDir: string;
      fleetConfig?: string;
      v1Url?: string;
      v1File?: string;
      consensusV1Url?: readonly string[];
      consensusV1File?: readonly string[];
      minAgreeingSources?: number;
      includeHosted?: boolean;
      timeoutMs?: number;
      json?: boolean;
    }) => {
      const code = await productionDoctorCommand({
        runDir: opts.runDir,
        ...(opts.fleetConfig !== undefined ? { fleetConfigPath: opts.fleetConfig } : {}),
        ...(opts.v1Url !== undefined ? { v1ModelsUrl: opts.v1Url } : {}),
        ...(opts.v1File !== undefined ? { v1CatalogFile: opts.v1File } : {}),
        ...(opts.consensusV1Url !== undefined ? { consensusV1ModelsUrls: opts.consensusV1Url } : {}),
        ...(opts.consensusV1File !== undefined ? { consensusV1CatalogFiles: opts.consensusV1File } : {}),
        ...(opts.minAgreeingSources !== undefined ? { minAgreeingSources: opts.minAgreeingSources } : {}),
        ...(opts.includeHosted === true ? { includeHosted: true } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  withProductionFleetOptions(
    production
      .command('promote')
      .requiredOption('--run-dir <path>', 'run directory containing sidecars')
      .option('--json', 'output JSON'),
  )
    .action(async (opts: {
      runDir: string;
      fleetConfig?: string;
      v1Url?: string;
      v1File?: string;
      consensusV1Url?: readonly string[];
      consensusV1File?: readonly string[];
      minAgreeingSources?: number;
      includeHosted?: boolean;
      timeoutMs?: number;
      json?: boolean;
    }) => {
      const code = await productionPromoteCommand({
        runDir: opts.runDir,
        ...(opts.fleetConfig !== undefined ? { fleetConfigPath: opts.fleetConfig } : {}),
        ...(opts.v1Url !== undefined ? { v1ModelsUrl: opts.v1Url } : {}),
        ...(opts.v1File !== undefined ? { v1CatalogFile: opts.v1File } : {}),
        ...(opts.consensusV1Url !== undefined ? { consensusV1ModelsUrls: opts.consensusV1Url } : {}),
        ...(opts.consensusV1File !== undefined ? { consensusV1CatalogFiles: opts.consensusV1File } : {}),
        ...(opts.minAgreeingSources !== undefined ? { minAgreeingSources: opts.minAgreeingSources } : {}),
        ...(opts.includeHosted === true ? { includeHosted: true } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  withProductionFleetOptions(
    production
      .command('canary')
      .requiredOption('--run-dir <path>', 'run directory containing sidecars')
      .option('--current-level <n>', 'current canary concurrent-task level', (value) => Number.parseInt(value, 10))
      .option('--green-cycles <n>', 'green replay/rollback cycles observed', (value) => Number.parseInt(value, 10))
      .option('--red-issues <n>', 'red production issues observed', (value) => Number.parseInt(value, 10))
      .option('--missing-telemetry', 'treat canary telemetry as missing')
      .option('--json', 'output JSON'),
  )
    .action(async (opts: {
      runDir: string;
      fleetConfig?: string;
      v1Url?: string;
      v1File?: string;
      consensusV1Url?: readonly string[];
      consensusV1File?: readonly string[];
      minAgreeingSources?: number;
      includeHosted?: boolean;
      timeoutMs?: number;
      currentLevel?: number;
      greenCycles?: number;
      redIssues?: number;
      missingTelemetry?: boolean;
      json?: boolean;
    }) => {
      const code = await productionCanaryCommand({
        runDir: opts.runDir,
        ...(opts.fleetConfig !== undefined ? { fleetConfigPath: opts.fleetConfig } : {}),
        ...(opts.v1Url !== undefined ? { v1ModelsUrl: opts.v1Url } : {}),
        ...(opts.v1File !== undefined ? { v1CatalogFile: opts.v1File } : {}),
        ...(opts.consensusV1Url !== undefined ? { consensusV1ModelsUrls: opts.consensusV1Url } : {}),
        ...(opts.consensusV1File !== undefined ? { consensusV1CatalogFiles: opts.consensusV1File } : {}),
        ...(opts.minAgreeingSources !== undefined ? { minAgreeingSources: opts.minAgreeingSources } : {}),
        ...(opts.includeHosted === true ? { includeHosted: true } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.currentLevel !== undefined ? { currentLevel: opts.currentLevel } : {}),
        ...(opts.greenCycles !== undefined ? { greenCycles: opts.greenCycles } : {}),
        ...(opts.redIssues !== undefined ? { redIssues: opts.redIssues } : {}),
        missingTelemetry: opts.missingTelemetry === true,
        json: opts.json === true,
      });
      process.exit(code);
    });

  withProductionFleetOptions(
    production
      .command('break-glass')
      .requiredOption('--run-dir <path>', 'run directory containing sidecars')
      .requiredOption('--incident <id>', 'incident id')
      .requiredOption('--operator <id>', 'operator approving the break-glass request')
      .requiredOption('--reason <text>', 'reason for break-glass')
      .requiredOption('--blast-radius <text>', 'bounded blast radius')
      .requiredOption('--rollback <text>', 'rollback command or procedure')
      .option('--expires-at <iso>', 'break-glass expiry timestamp')
      .option('--post-hoc-gates <gates>', 'comma-separated post-hoc gates', parseCsv)
      .option('--approvals <ids>', 'comma-separated approving command-group member ids', parseCsv)
      .option('--json', 'output JSON'),
  )
    .action(async (opts: {
      runDir: string;
      incident: string;
      operator: string;
      reason: string;
      blastRadius: string;
      rollback: string;
      expiresAt?: string;
      postHocGates?: readonly string[];
      approvals?: readonly string[];
      fleetConfig?: string;
      v1Url?: string;
      v1File?: string;
      consensusV1Url?: readonly string[];
      consensusV1File?: readonly string[];
      minAgreeingSources?: number;
      includeHosted?: boolean;
      timeoutMs?: number;
      json?: boolean;
    }) => {
      const code = await productionBreakGlassCommand({
        runDir: opts.runDir,
        incidentId: opts.incident,
        operatorId: opts.operator,
        reason: opts.reason,
        blastRadius: opts.blastRadius,
        rollback: opts.rollback,
        ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
        ...(opts.postHocGates !== undefined ? { postHocGates: opts.postHocGates } : {}),
        ...(opts.approvals !== undefined ? { approvals: opts.approvals } : {}),
        ...(opts.fleetConfig !== undefined ? { fleetConfigPath: opts.fleetConfig } : {}),
        ...(opts.v1Url !== undefined ? { v1ModelsUrl: opts.v1Url } : {}),
        ...(opts.v1File !== undefined ? { v1CatalogFile: opts.v1File } : {}),
        ...(opts.consensusV1Url !== undefined ? { consensusV1ModelsUrls: opts.consensusV1Url } : {}),
        ...(opts.consensusV1File !== undefined ? { consensusV1CatalogFiles: opts.consensusV1File } : {}),
        ...(opts.minAgreeingSources !== undefined ? { minAgreeingSources: opts.minAgreeingSources } : {}),
        ...(opts.includeHosted === true ? { includeHosted: true } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  withProductionFleetOptions(
    production
      .command('council')
      .requiredOption('--run-dir <path>', 'run directory containing sidecars')
      .requiredOption('--prompt <text>', 'production council prompt')
      .option('--max-tokens <n>', 'per-model advisory max_tokens override', (value) => Number.parseInt(value, 10))
      .option('--json', 'output JSON'),
  )
    .action(async (opts: {
      runDir: string;
      prompt: string;
      maxTokens?: number;
      fleetConfig?: string;
      v1Url?: string;
      v1File?: string;
      consensusV1Url?: readonly string[];
      consensusV1File?: readonly string[];
      minAgreeingSources?: number;
      includeHosted?: boolean;
      timeoutMs?: number;
      json?: boolean;
    }) => {
      const code = await productionCouncilCommand({
        runDir: opts.runDir,
        prompt: opts.prompt,
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.fleetConfig !== undefined ? { fleetConfigPath: opts.fleetConfig } : {}),
        ...(opts.v1Url !== undefined ? { v1ModelsUrl: opts.v1Url } : {}),
        ...(opts.v1File !== undefined ? { v1CatalogFile: opts.v1File } : {}),
        ...(opts.consensusV1Url !== undefined ? { consensusV1ModelsUrls: opts.consensusV1Url } : {}),
        ...(opts.consensusV1File !== undefined ? { consensusV1CatalogFiles: opts.consensusV1File } : {}),
        ...(opts.minAgreeingSources !== undefined ? { minAgreeingSources: opts.minAgreeingSources } : {}),
        ...(opts.includeHosted === true ? { includeHosted: true } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const legacy = program
    .command('legacy')
    .description('Scan or import legacy BCRX/VCRX packages without inventing receipt semantics');

  legacy
    .command('scan <path>')
    .requiredOption('--kind <kind>', 'bcrx_v1 or vcrx_legacy', parseLegacySourceKind)
    .option('--manifest <path>', 'optional approved source manifest')
    .option('--json', 'output JSON')
    .action(async (path: string, opts: {
      kind: ReturnType<typeof parseLegacySourceKind>;
      manifest?: string;
      json?: boolean;
    }) => {
      const code = await legacyScanCommand({
        path,
        kind: opts.kind,
        ...(opts.manifest !== undefined ? { manifest: opts.manifest } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  legacy
    .command('import-bcrx <path>')
    .requiredOption('--run-dir <path>', 'run directory to receive v2 sidecars')
    .requiredOption('--manifest <path>', 'approved legacy source manifest')
    .option('--json', 'output JSON')
    .action(async (path: string, opts: { runDir: string; manifest: string; json?: boolean }) => {
      const code = await legacyImportCommand({
        runDir: opts.runDir,
        path,
        kind: 'bcrx_v1',
        manifest: opts.manifest,
        json: opts.json === true,
      });
      process.exit(code);
    });

  legacy
    .command('import-vcrx <path>')
    .requiredOption('--run-dir <path>', 'run directory to receive v2 sidecars')
    .requiredOption('--manifest <path>', 'approved legacy source manifest')
    .option('--json', 'output JSON')
    .action(async (path: string, opts: { runDir: string; manifest: string; json?: boolean }) => {
      const code = await legacyImportCommand({
        runDir: opts.runDir,
        path,
        kind: 'vcrx_legacy',
        manifest: opts.manifest,
        json: opts.json === true,
      });
      process.exit(code);
    });

  fleet
    .command('doctor')
    .option('--config <path>', 'fleet config JSON path; used as policy overlay when V1 source is present')
    .option('--v1-url <url>', 'live /v1/models URL or catalog base URL; overrides config source')
    .option('--v1-file <path>', 'V1 catalog snapshot file for offline or fallback diagnosis')
    .option('--consensus-v1-url <urls>', 'comma-separated secondary /v1/models URLs that must agree with primary', parseCsv)
    .option('--consensus-v1-file <paths>', 'comma-separated secondary V1 catalog snapshot files that must agree with primary', parseCsv)
    .option('--min-agreeing-sources <n>', 'minimum V1 sources, including primary, required for consensus', (value) => Number.parseInt(value, 10))
    .option('--include-hosted', 'include hosted V1 records without direct upstream endpoints')
    .option('--chat-smoke', 'run a final-content chat smoke against each configured model')
    .option('--run-dir <path>', 'optional run directory for fleet probe evidence receipt')
    .option('--timeout-ms <n>', 'per-request timeout override', (value) => Number.parseInt(value, 10))
    .option('--json', 'output JSON')
    .action(async (opts: {
      config?: string;
      v1Url?: string;
      v1File?: string;
      consensusV1Url?: readonly string[];
      consensusV1File?: readonly string[];
      minAgreeingSources?: number;
      includeHosted?: boolean;
      chatSmoke?: boolean;
      runDir?: string;
      timeoutMs?: number;
      json?: boolean;
    }) => {
      const code = await fleetDoctorCommand({
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(opts.v1Url !== undefined ? { v1ModelsUrl: opts.v1Url } : {}),
        ...(opts.v1File !== undefined ? { v1CatalogFile: opts.v1File } : {}),
        ...(opts.consensusV1Url !== undefined ? { consensusV1ModelsUrls: opts.consensusV1Url } : {}),
        ...(opts.consensusV1File !== undefined ? { consensusV1CatalogFiles: opts.consensusV1File } : {}),
        ...(opts.minAgreeingSources !== undefined ? { minAgreeingSources: opts.minAgreeingSources } : {}),
        includeHosted: opts.includeHosted === true,
        chatSmoke: opts.chatSmoke === true,
        ...(opts.runDir !== undefined ? { runDir: opts.runDir } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  const agentops = program
    .command('agentops')
    .description('Render AgentOps panels and run advisory fleet reviews')
    .action(() => {
      program.commands.find((command) => command.name() === 'agentops')?.help();
    });

  agentops
    .command('panel')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await agentopsPanelCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  agentops
    .command('replay')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await agentopsReplayCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  agentops
    .command('graph')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await agentopsGraphCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  agentops
    .command('export')
    .requiredOption('--run-dir <path>', 'run directory containing sidecars')
    .option('--json', 'output JSON')
    .action(async (opts: { runDir: string; json?: boolean }) => {
      const code = await agentopsExportCommand({
        runDir: opts.runDir,
        json: opts.json === true,
      });
      process.exit(code);
    });

  agentops
    .command('advise')
    .requiredOption('--run-dir <path>', 'run directory to receive sidecars')
    .requiredOption('--prompt <text>', 'operator/spec prompt to review')
    .option('--config <path>', 'fleet config JSON path; used as policy overlay when V1 source is present')
    .option('--v1-url <url>', 'live /v1/models URL or catalog base URL; overrides config source')
    .option('--v1-file <path>', 'V1 catalog snapshot file for offline or fallback advisory review')
    .option('--consensus-v1-url <urls>', 'comma-separated secondary /v1/models URLs that must agree with primary', parseCsv)
    .option('--consensus-v1-file <paths>', 'comma-separated secondary V1 catalog snapshot files that must agree with primary', parseCsv)
    .option('--min-agreeing-sources <n>', 'minimum V1 sources, including primary, required for consensus', (value) => Number.parseInt(value, 10))
    .option('--include-hosted', 'include hosted V1 records when they expose direct invocation endpoints')
    .option('--timeout-ms <n>', 'per-model advisory timeout override', (value) => Number.parseInt(value, 10))
    .option('--max-tokens <n>', 'per-model advisory max_tokens override', (value) => Number.parseInt(value, 10))
    .option('--min-dissenters <n>', 'minimum dissenting responses required for anti-groupthink', (value) => Number.parseInt(value, 10))
    .option('--assurance-context <context>', 'alpha or production subject assurance context', parseProtocolDoctorProfile)
    .option('--idempotency-key <key>', 'dedupe key for retry-safe advisory dispatch')
    .option('--json', 'output JSON')
    .action(async (opts: {
      runDir: string;
      prompt: string;
      config?: string;
      v1Url?: string;
      v1File?: string;
      consensusV1Url?: readonly string[];
      consensusV1File?: readonly string[];
      minAgreeingSources?: number;
      includeHosted?: boolean;
      timeoutMs?: number;
      maxTokens?: number;
      minDissenters?: number;
      assuranceContext?: ProtocolAssuranceContext;
      idempotencyKey?: string;
      json?: boolean;
    }) => {
      const code = await agentopsAdviseCommand({
        runDir: opts.runDir,
        prompt: opts.prompt,
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(opts.v1Url !== undefined ? { v1ModelsUrl: opts.v1Url } : {}),
        ...(opts.v1File !== undefined ? { v1CatalogFile: opts.v1File } : {}),
        ...(opts.consensusV1Url !== undefined ? { consensusV1ModelsUrls: opts.consensusV1Url } : {}),
        ...(opts.consensusV1File !== undefined ? { consensusV1CatalogFiles: opts.consensusV1File } : {}),
        ...(opts.minAgreeingSources !== undefined ? { minAgreeingSources: opts.minAgreeingSources } : {}),
        includeHosted: opts.includeHosted === true,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.minDissenters !== undefined ? { minDissenters: opts.minDissenters } : {}),
        ...(opts.assuranceContext !== undefined ? { assuranceContext: opts.assuranceContext } : {}),
        ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
        json: opts.json === true,
      });
      process.exit(code);
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`harness: fatal error: ${msg}\n`);
  process.exit(1);
});
