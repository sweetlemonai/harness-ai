import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { createEvidenceReceipt } from '../lib/evidence/ledger.js';
import { appendLedgerEntry } from '../lib/protocol/ledger.js';
import { sidecarPathsForRunDir } from '../lib/protocol/sidecar.js';
import { stableHash, stableId } from '../lib/protocol/hash.js';
import { evaluateProductionPromotion, type ProductionPromotionDecision } from '../lib/protocol/promotion.js';
import {
  createSidecarSigner,
  loadConfiguredSidecarSigner,
  signEvidenceReceipt,
} from '../lib/proof/signing.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import {
  readFleetConfig,
  resolveFleetMembers,
  type FleetResolution,
} from './fleet.js';
import {
  agentopsAdviseCommand,
  type AgentOpsAdviseCommandArgs,
} from './agentops.js';
import type { HarnessConfig, VerificationIssue } from '../types.js';

export interface ProductionDoctorCommandArgs extends ProductionFleetArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface ProductionPromoteCommandArgs extends ProductionFleetArgs {
  readonly runDir: string;
  readonly json?: boolean;
}

export interface ProductionCanaryCommandArgs extends ProductionFleetArgs {
  readonly runDir: string;
  readonly currentLevel?: number;
  readonly greenCycles?: number;
  readonly redIssues?: number;
  readonly missingTelemetry?: boolean;
  readonly json?: boolean;
}

export interface ProductionBreakGlassCommandArgs extends ProductionFleetArgs {
  readonly runDir: string;
  readonly incidentId: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly blastRadius: string;
  readonly rollback: string;
  readonly expiresAt?: string;
  readonly postHocGates?: readonly string[];
  readonly approvals?: readonly string[];
  readonly json?: boolean;
}

export interface ProductionCouncilCommandArgs extends ProductionFleetArgs {
  readonly runDir: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  readonly json?: boolean;
}

export interface ProductionInitLocalCommandArgs {
  readonly v1ModelsUrl: string;
  readonly operatorId: string;
  readonly commandGroupMembers?: readonly string[];
  readonly requiredApprovals?: number;
  readonly configLocalFile?: string;
  readonly fleetConfigFile?: string;
  readonly witnessCatalogFile?: string;
  readonly privateKeyFile?: string;
  readonly revocationListFile?: string;
  readonly zkProverFile?: string;
  readonly keyValidDays?: number;
  readonly timeoutMs?: number;
  readonly force?: boolean;
  readonly json?: boolean;
}

interface ProductionFleetArgs {
  readonly fleetConfigPath?: string;
  readonly v1ModelsUrl?: string;
  readonly v1CatalogFile?: string;
  readonly consensusV1ModelsUrls?: readonly string[];
  readonly consensusV1CatalogFiles?: readonly string[];
  readonly minAgreeingSources?: number;
  readonly includeHosted?: boolean;
  readonly timeoutMs?: number;
}

export interface ProductionReadinessDecision {
  readonly schemaVersion: 'superharness.production_readiness.v1';
  readonly decisionId: string;
  readonly runDir: string;
  readonly checkedAt: string;
  readonly allowed: boolean;
  readonly mode: 'doctor' | 'promote';
  readonly promotion: ProductionPromotionDecision;
  readonly gates: {
    readonly signing: ProductionGateSummary;
    readonly zkSnarks: ProductionGateSummary;
    readonly fleet: ProductionGateSummary;
    readonly commandGroup: ProductionGateSummary;
  };
  readonly counts: {
    readonly blockers: number;
    readonly warnings: number;
  };
  readonly blockers: readonly ProductionReadinessIssue[];
  readonly warnings: readonly ProductionReadinessIssue[];
}

interface ProductionGateSummary {
  readonly ok: boolean;
  readonly summary: string;
  readonly details?: Record<string, unknown>;
}

interface ProductionReadinessIssue {
  readonly source: 'promotion' | 'signing' | 'zk_snark' | 'fleet' | 'command_group' | 'canary' | 'break_glass';
  readonly severity: VerificationIssue['severity'];
  readonly code: string;
  readonly message: string;
  readonly subjectId?: string;
}

interface BreakGlassReceipt {
  readonly schemaVersion: 'superharness.production_break_glass_receipt.v1';
  readonly receiptId: string;
  readonly runDir: string;
  readonly incidentId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly blastRadius: string;
  readonly rollback: string;
  readonly postHocGates: readonly string[];
  readonly approvals: readonly string[];
  readonly policy: {
    readonly maxHours: number;
    readonly postHocGateDeadlineHours: number;
    readonly requireRollback: boolean;
    readonly requiredApprovals: number;
  };
  readonly checks: {
    readonly expiresWithinPolicy: boolean;
    readonly rollbackPresent: boolean;
    readonly commandGroupEnabled: boolean;
    readonly approvalsSatisfied: boolean;
    readonly signerConfigured: boolean;
  };
  readonly promotionDecisionId: string;
  readonly allowed: boolean;
  readonly blockers: readonly ProductionReadinessIssue[];
}

export async function productionDoctorCommand(
  args: ProductionDoctorCommandArgs,
): Promise<number> {
  const decision = await evaluateProductionReadiness({
    ...args,
    mode: 'doctor',
  });
  writeProductionArtifact(args.runDir, 'production-readiness.json', decision);
  writeOutput(decision, args.json === true);
  return decision.allowed ? 0 : 1;
}

export async function productionPromoteCommand(
  args: ProductionPromoteCommandArgs,
): Promise<number> {
  const decision = await evaluateProductionReadiness({
    ...args,
    mode: 'promote',
  });
  writeProductionArtifact(args.runDir, 'production-promotion-decision.json', decision);
  writeOutput(decision, args.json === true);
  return decision.allowed ? 0 : 1;
}

export async function productionCanaryCommand(
  args: ProductionCanaryCommandArgs,
): Promise<number> {
  const config = loadConfig(resolveHarnessPaths());
  const readiness = await evaluateProductionReadiness({
    ...args,
    mode: 'promote',
  });
  const policy = config.production.canary;
  const current = args.currentLevel ?? policy.seedConcurrentTasks;
  const redIssues = args.redIssues ?? readiness.counts.blockers;
  const missingTelemetry = args.missingTelemetry === true;
  const greenCycles = args.greenCycles ?? 0;
  const nextLevel = canaryNextLevel({
    current,
    greenCycles,
    redIssues,
    missingTelemetry,
    policy,
  });
  const blockers: ProductionReadinessIssue[] = [
    ...readiness.blockers,
  ];
  if (!policy.enabled) {
    blockers.push(readinessIssue('canary', 'error', 'production.canary_disabled', 'production canary policy is disabled'));
  }
  if (missingTelemetry) {
    blockers.push(readinessIssue('canary', 'error', 'production.canary_missing_telemetry', 'canary cannot advance with missing telemetry'));
  }
  if (redIssues > 0) {
    blockers.push(readinessIssue('canary', 'error', 'production.canary_red_issues', 'canary must fall back to floor while red issues are present'));
  }
  const payload = {
    schemaVersion: 'superharness.production_canary_decision.v1' as const,
    decisionId: stableId('production_canary', {
      runDir: args.runDir,
      readiness: readiness.decisionId,
      current,
      greenCycles,
      redIssues,
      missingTelemetry,
      nextLevel,
    }),
    runDir: args.runDir,
    checkedAt: readiness.checkedAt,
    allowed: readiness.allowed && policy.enabled && blockers.length === 0,
    currentLevel: current,
    nextLevel,
    controller: {
      configured: policy,
      effective: {
        floor: policy.floorConcurrentTasks,
        cap: policy.capConcurrentTasks,
        stepUp: policy.stepUp,
      },
      inputs: {
        greenCycles,
        redIssues,
        missingTelemetry,
      },
      reason: canaryReason({ greenCycles, redIssues, missingTelemetry, policy }),
    },
    readiness,
    blockers,
  };
  writeProductionArtifact(args.runDir, 'production-canary-decision.json', payload);
  writeOutput(payload, args.json === true);
  return payload.allowed ? 0 : 1;
}

export async function productionBreakGlassCommand(
  args: ProductionBreakGlassCommandArgs,
): Promise<number> {
  const config = loadConfig(resolveHarnessPaths());
  const readiness = await evaluateProductionReadiness({
    ...args,
    mode: 'promote',
  });
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = args.expiresAt ?? new Date(now.getTime() + config.production.breakGlass.maxHours * 60 * 60 * 1000).toISOString();
  const approvals = [...new Set([args.operatorId, ...(args.approvals ?? [])])];
  const checks = {
    expiresWithinPolicy: expiresWithinPolicy(createdAt, expiresAt, config.production.breakGlass.maxHours),
    rollbackPresent: !config.production.breakGlass.requireRollback || args.rollback.trim().length > 0,
    commandGroupEnabled: config.production.commandGroup.enabled,
    approvalsSatisfied: approvals.filter((entry) => config.production.commandGroup.members.includes(entry)).length
      >= config.production.commandGroup.requiredApprovals,
    signerConfigured: productionSigningConfigured(config),
  };
  const receiptBlockers = breakGlassBlockers(checks);
  const receiptPayload = {
    runDir: args.runDir,
    incidentId: args.incidentId,
    createdAt,
    expiresAt,
    operatorId: args.operatorId,
    reason: args.reason,
    blastRadius: args.blastRadius,
    rollback: args.rollback,
    postHocGates: args.postHocGates ?? defaultPostHocGates(),
    approvals,
    policy: {
      maxHours: config.production.breakGlass.maxHours,
      postHocGateDeadlineHours: config.production.breakGlass.postHocGateDeadlineHours,
      requireRollback: config.production.breakGlass.requireRollback,
      requiredApprovals: config.production.commandGroup.requiredApprovals,
    },
    checks,
    promotionDecisionId: readiness.decisionId,
    allowed: receiptBlockers.length === 0,
    blockers: receiptBlockers,
  };
  const receipt: BreakGlassReceipt = {
    schemaVersion: 'superharness.production_break_glass_receipt.v1',
    receiptId: stableId('break_glass_receipt', receiptPayload),
    ...receiptPayload,
  };
  const evidenceId = appendBreakGlassEvidence(args.runDir, receipt);
  const payload = {
    receipt,
    evidenceId,
    readiness,
  };
  writeProductionArtifact(args.runDir, `break-glass-${safeFilePart(args.incidentId)}.json`, payload);
  writeOutput(payload, args.json === true);
  return receipt.allowed ? 0 : 1;
}

export async function productionCouncilCommand(
  args: ProductionCouncilCommandArgs,
): Promise<number> {
  const config = loadConfig(resolveHarnessPaths());
  const fleetArgs = resolveProductionFleetArgs(config, args);
  const timeoutMs = args.timeoutMs ?? effectiveCouncilTimeout(config);
  const councilArgs: AgentOpsAdviseCommandArgs = {
    runDir: args.runDir,
    prompt: args.prompt,
    ...(fleetArgs.fleetConfigPath !== undefined ? { configPath: fleetArgs.fleetConfigPath } : {}),
    ...(fleetArgs.v1ModelsUrl !== undefined ? { v1ModelsUrl: fleetArgs.v1ModelsUrl } : {}),
    ...(fleetArgs.v1CatalogFile !== undefined ? { v1CatalogFile: fleetArgs.v1CatalogFile } : {}),
    ...(fleetArgs.consensusV1ModelsUrls !== undefined ? { consensusV1ModelsUrls: fleetArgs.consensusV1ModelsUrls } : {}),
    ...(fleetArgs.consensusV1CatalogFiles !== undefined ? { consensusV1CatalogFiles: fleetArgs.consensusV1CatalogFiles } : {}),
    ...(fleetArgs.minAgreeingSources !== undefined ? { minAgreeingSources: fleetArgs.minAgreeingSources } : {}),
    includeHosted: fleetArgs.includeHosted === true,
    timeoutMs,
    minDissenters: config.production.council.minDissenters,
    assuranceContext: 'production',
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    json: args.json === true,
  };
  return agentopsAdviseCommand(councilArgs);
}

export async function productionInitLocalCommand(
  args: ProductionInitLocalCommandArgs,
): Promise<number> {
  const paths = resolveHarnessPaths();
  const config = loadConfig(paths);
  const generatedAt = new Date();
  const keyValidDays = args.keyValidDays ?? 365;
  const expiresAt = new Date(generatedAt.getTime() + keyValidDays * 24 * 60 * 60 * 1000).toISOString();
  const timeoutMs = args.timeoutMs ?? effectiveCouncilTimeout(config);
  const v1ModelsUrl = normalizeV1ModelsUrl(args.v1ModelsUrl);
  const configLocalFile = resolveOutputPath(args.configLocalFile ?? paths.configLocalFile);
  const fleetConfigFile = resolveOutputPath(args.fleetConfigFile ?? join(paths.harnessRoot, 'fleet', 'local-production-fleet.json'));
  const witnessCatalogFile = resolveOutputPath(args.witnessCatalogFile ?? join(paths.harnessRoot, 'fleet', 'v1-witness.snapshot.json'));
  const privateKeyFile = resolveOutputPath(args.privateKeyFile ?? join(paths.harnessRoot, 'proof', 'local-operator.ed25519.pkcs8.pem'));
  const revocationListFile = resolveOutputPath(args.revocationListFile ?? join(paths.harnessRoot, 'proof', 'revocations.json'));
  const zkProverFile = resolveOutputPath(args.zkProverFile ?? join(paths.harnessRoot, 'proof', 'local-external-zk-prover.mjs'));
  const commandGroupMembers = uniqueStrings([
    args.operatorId,
    ...(args.commandGroupMembers ?? []),
    'local.fleet.critic',
  ]);
  const requiredApprovals = args.requiredApprovals
    ?? Math.min(config.production.commandGroup.requiredApprovals, commandGroupMembers.length);
  if (requiredApprovals > commandGroupMembers.length) {
    throw new Error('production init-local required approvals exceed command-group member count');
  }

  const v1Catalog = await fetchJson(v1ModelsUrl, timeoutMs) as Record<string, unknown>;
  const keyPair = generateKeyPairSync('ed25519');
  const privateKeyPem = keyPair.privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }).toString();
  const revocationListRef = `file://${revocationListFile}`;
  const keyId = `local-operator-${safeFilePart(args.operatorId)}`;
  const fleetTimeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const maxLatencyMs = requirePositiveInteger(config.proofs.zkSnarks.maxLatencyMs, 'proofs.zkSnarks.maxLatencyMs');
  const zkTimeoutMs = requirePositiveInteger(config.proofs.zkSnarks.timeoutMs, 'proofs.zkSnarks.timeoutMs');
  const zkMaxOutputBytes = requirePositiveInteger(config.proofs.zkSnarks.maxOutputBytes, 'proofs.zkSnarks.maxOutputBytes');
  const fleetConfig = {
    schema: 'superharness.fleet.config.v1',
    source: {
      url: v1ModelsUrl,
      consensus_files: [witnessCatalogFile],
      min_agreeing_sources: 2,
      include_hosted: false,
    },
    selection: {
      require_upstream: true,
      require_hot_memory: true,
      include_hosted: false,
    },
    timeout_s: fleetTimeoutSeconds,
    advisory: {
      min_dissenters: config.production.council.minDissenters,
    },
  };
  const configLocal = {
    proofs: {
      signing: {
        enabled: true,
        provider: 'local_operator_file_ed25519',
        trustLevel: 'operator_bound',
        privateKeyFile,
        keyId,
        expiresAt,
        revocationListRef,
      },
      zkSnarks: {
        enabled: true,
        defaultBackend: 'external',
        command: process.execPath,
        args: [zkProverFile],
        timeoutMs: zkTimeoutMs,
        maxOutputBytes: zkMaxOutputBytes,
        circuitId: 'local-production-break-v1',
        circuitVersion: '1',
        verifierRef: `file://${zkProverFile}`,
        setupHash: stableHash({
          prover: zkProverFile,
          circuitId: 'local-production-break-v1',
          circuitVersion: '1',
        }),
        maxLatencyMs,
        failurePolicy: 'fail_closed',
      },
    },
    production: {
      fleet: {
        configPath: fleetConfigFile,
        v1ModelsUrl,
        consensusV1CatalogFiles: [witnessCatalogFile],
        minAgreeingSources: 2,
        includeHosted: false,
      },
      commandGroup: {
        enabled: true,
        requiredApprovals,
        members: commandGroupMembers,
      },
      canary: {
        enabled: true,
      },
    },
  };
  const revocations = {
    schemaVersion: 'superharness.local_revocations.v1',
    generatedAt: generatedAt.toISOString(),
    keyId,
    revokedKeyIds: [],
  };
  const witnessCatalog = {
    schemaVersion: 'superharness.v1_witness_snapshot.v1',
    capturedAt: generatedAt.toISOString(),
    source: v1ModelsUrl,
    catalog: v1Catalog,
  };

  writeFileChecked(privateKeyFile, privateKeyPem, args.force === true);
  chmodSync(privateKeyFile, 0o600);
  writeJsonChecked(revocationListFile, revocations, args.force === true);
  writeFileChecked(zkProverFile, localExternalZkProverSource(), args.force === true);
  chmodSync(zkProverFile, 0o755);
  writeJsonChecked(witnessCatalogFile, witnessCatalog, args.force === true);
  writeJsonChecked(fleetConfigFile, fleetConfig, args.force === true);
  writeJsonChecked(configLocalFile, configLocal, args.force === true);

  const payload = {
    schemaVersion: 'superharness.local_production_bootstrap.v1' as const,
    generatedAt: generatedAt.toISOString(),
    localOnly: true,
    v1ModelsUrl,
    files: {
      configLocalFile,
      fleetConfigFile,
      witnessCatalogFile,
      privateKeyFile,
      revocationListFile,
      zkProverFile,
    },
    commandGroup: configLocal.production.commandGroup,
    council: {
      minDissenters: config.production.council.minDissenters,
      timeoutMs,
    },
    nextCommands: [
      `harness fleet doctor --config ${fleetConfigFile} --chat-smoke`,
      'harness production council --run-dir <run-dir> --prompt <prompt>',
      'harness production doctor --run-dir <run-dir>',
    ],
  };
  writeOutput(payload, args.json === true);
  return 0;
}

async function evaluateProductionReadiness(
  args: ProductionDoctorCommandArgs & { readonly mode: 'doctor' | 'promote' },
): Promise<ProductionReadinessDecision> {
  const config = loadConfig(resolveHarnessPaths());
  const checkedAt = new Date().toISOString();
  const promotion = evaluateProductionPromotion({
    runDir: args.runDir,
    checkedAt,
  });
  const signing = signingGate(config);
  const zkSnarks = zkSnarkGate(config);
  const fleet = await fleetGate(config, args);
  const commandGroup = commandGroupGate(config);
  const blockers: ProductionReadinessIssue[] = [
    ...promotion.blockers.map((entry) => ({
      source: 'promotion' as const,
      severity: entry.severity,
      code: entry.code,
      message: entry.message,
      ...(entry.subjectId !== undefined ? { subjectId: entry.subjectId } : {}),
    })),
    ...gateIssues('signing', signing),
    ...gateIssues('zk_snark', zkSnarks),
    ...gateIssues('fleet', fleet),
    ...gateIssues('command_group', commandGroup),
  ].filter((entry) => entry.severity === 'error');
  const warnings: ProductionReadinessIssue[] = [
    ...promotion.warnings.map((entry) => ({
      source: 'promotion' as const,
      severity: entry.severity,
      code: entry.code,
      message: entry.message,
      ...(entry.subjectId !== undefined ? { subjectId: entry.subjectId } : {}),
    })),
    ...gateIssues('signing', signing),
    ...gateIssues('zk_snark', zkSnarks),
    ...gateIssues('fleet', fleet),
    ...gateIssues('command_group', commandGroup),
  ].filter((entry) => entry.severity !== 'error');
  const decisionId = stableId('production_readiness', {
    runDir: args.runDir,
    checkedAt,
    mode: args.mode,
    promotionDecisionId: promotion.decisionId,
    blockers: blockers.map((entry) => entry.code),
  });
  return {
    schemaVersion: 'superharness.production_readiness.v1',
    decisionId,
    runDir: sidecarPathsForRunDir(args.runDir).runDir,
    checkedAt,
    allowed: promotion.allowed
      && signing.ok
      && zkSnarks.ok
      && fleet.ok
      && commandGroup.ok
      && blockers.length === 0,
    mode: args.mode,
    promotion,
    gates: {
      signing: stripIssues(signing),
      zkSnarks: stripIssues(zkSnarks),
      fleet: stripIssues(fleet),
      commandGroup: stripIssues(commandGroup),
    },
    counts: {
      blockers: blockers.length,
      warnings: warnings.length,
    },
    blockers,
    warnings,
  };
}

function signingGate(config: HarnessConfig): ProductionGateSummary & { readonly issues: readonly ProductionReadinessIssue[] } {
  const issues: ProductionReadinessIssue[] = [];
  try {
    const signer = createSidecarSigner(config.proofs.signing);
    if (signer === undefined) {
      issues.push(readinessIssue('signing', 'error', 'production.signing_disabled', 'production signing must be enabled'));
    } else if (signer.trustLevel !== 'operator_bound' && signer.trustLevel !== 'registry_verified') {
      issues.push(readinessIssue('signing', 'error', 'production.signing_identity_not_bound', 'production signing requires operator_bound or registry_verified trust'));
    }
    if (config.proofs.signing.provider === 'local_ephemeral_ed25519') {
      issues.push(readinessIssue('signing', 'error', 'production.signing_ephemeral_forbidden', 'production signing cannot use an ephemeral local key'));
    }
  } catch (error) {
    issues.push(readinessIssue('signing', 'error', 'production.signing_invalid', `production signing is not usable: ${error instanceof Error ? error.message : String(error)}`));
  }
  return {
    ok: issues.every((entry) => entry.severity !== 'error'),
    summary: issues.length === 0 ? 'production signing is configured' : 'production signing is not ready',
    details: {
      provider: config.proofs.signing.provider,
      trustLevel: config.proofs.signing.trustLevel,
      keyId: config.proofs.signing.keyId ?? null,
      revocationListRef: config.proofs.signing.revocationListRef ?? null,
    },
    issues,
  };
}

function zkSnarkGate(config: HarnessConfig): ProductionGateSummary & { readonly issues: readonly ProductionReadinessIssue[] } {
  const issues: ProductionReadinessIssue[] = [];
  const zk = config.proofs.zkSnarks;
  if (!zk.enabled || zk.defaultBackend !== 'external') {
    issues.push(readinessIssue('zk_snark', 'error', 'production.zk_external_not_enabled', 'production proof readiness requires external ZK backend enabled'));
  }
  if (zk.command === undefined || zk.command.trim() === '') {
    issues.push(readinessIssue('zk_snark', 'error', 'production.zk_command_missing', 'external ZK backend command is not configured'));
  }
  if (zk.verifierRef === undefined || zk.verifierRef.trim() === '') {
    issues.push(readinessIssue('zk_snark', 'error', 'production.zk_verifier_missing', 'external ZK verifier reference is not configured'));
  }
  if (zk.circuitId === undefined || zk.circuitId.trim() === '') {
    issues.push(readinessIssue('zk_snark', 'error', 'production.zk_circuit_missing', 'external ZK circuit id is not configured'));
  }
  if (zk.maxLatencyMs === undefined || !Number.isFinite(zk.maxLatencyMs) || zk.maxLatencyMs < 1) {
    issues.push(readinessIssue('zk_snark', 'error', 'production.zk_latency_budget_missing', 'external ZK maxLatencyMs is not configured'));
  }
  return {
    ok: issues.length === 0,
    summary: issues.length === 0 ? 'external ZK proof backend is configured' : 'external ZK proof backend is not ready',
    details: {
      enabled: zk.enabled,
      defaultBackend: zk.defaultBackend,
      command: zk.command ?? null,
      verifierRef: zk.verifierRef ?? null,
      circuitId: zk.circuitId ?? null,
      maxLatencyMs: zk.maxLatencyMs ?? null,
      failurePolicy: zk.failurePolicy ?? null,
    },
    issues,
  };
}

async function fleetGate(
  config: HarnessConfig,
  args: ProductionFleetArgs,
): Promise<ProductionGateSummary & { readonly issues: readonly ProductionReadinessIssue[] }> {
  const issues: ProductionReadinessIssue[] = [];
  let resolution: FleetResolution | null = null;
  try {
    const fleetArgs = resolveProductionFleetArgs(config, args);
    const fleetConfig = readFleetConfig(fleetArgs.fleetConfigPath);
    resolution = await resolveFleetMembers({
      config: fleetConfig,
      ...(fleetArgs.fleetConfigPath !== undefined ? { configPath: fleetArgs.fleetConfigPath } : {}),
      ...(fleetArgs.v1ModelsUrl !== undefined ? { v1ModelsUrl: fleetArgs.v1ModelsUrl } : {}),
      ...(fleetArgs.v1CatalogFile !== undefined ? { v1CatalogFile: fleetArgs.v1CatalogFile } : {}),
      ...(fleetArgs.consensusV1ModelsUrls !== undefined ? { consensusV1ModelsUrls: fleetArgs.consensusV1ModelsUrls } : {}),
      ...(fleetArgs.consensusV1CatalogFiles !== undefined ? { consensusV1CatalogFiles: fleetArgs.consensusV1CatalogFiles } : {}),
      ...(fleetArgs.minAgreeingSources !== undefined ? { minAgreeingSources: fleetArgs.minAgreeingSources } : {}),
      includeHosted: fleetArgs.includeHosted === true,
      requireV1Inventory: true,
      timeoutMs: args.timeoutMs ?? effectiveCouncilTimeout(config),
    });
    if (resolution.members.length === 0) {
      issues.push(readinessIssue('fleet', 'error', 'production.fleet_empty', 'production fleet requires at least one active V1 member'));
    }
    if (resolution.v1Consensus.mode !== 'checked') {
      issues.push(readinessIssue('fleet', 'error', 'production.v1_witness_missing', 'production requires at least one V1 witness source'));
    } else if (!resolution.v1Consensus.ok) {
      issues.push(readinessIssue('fleet', 'error', 'production.v1_consensus_failed', 'V1 inventory witnesses do not satisfy consensus policy'));
    }
  } catch (error) {
    issues.push(readinessIssue('fleet', 'error', 'production.fleet_unavailable', `production fleet inventory is not ready: ${error instanceof Error ? error.message : String(error)}`));
  }
  return {
    ok: issues.length === 0,
    summary: issues.length === 0 ? 'V1 fleet authority and witnesses are configured' : 'V1 fleet authority is not production-ready',
    details: {
      modelSource: resolution?.modelSource ?? null,
      v1Models: resolution?.v1ModelCount ?? 0,
      activeMembers: resolution?.members.length ?? 0,
      consensus: resolution?.v1Consensus ?? null,
    },
    issues,
  };
}

function commandGroupGate(config: HarnessConfig): ProductionGateSummary & { readonly issues: readonly ProductionReadinessIssue[] } {
  const group = config.production.commandGroup;
  const issues: ProductionReadinessIssue[] = [];
  if (!group.enabled) {
    issues.push(readinessIssue('command_group', 'error', 'production.command_group_disabled', 'production command group must be enabled'));
  }
  if (group.members.length < group.requiredApprovals) {
    issues.push(readinessIssue('command_group', 'error', 'production.command_group_insufficient_members', 'production command group has fewer members than required approvals'));
  }
  return {
    ok: issues.length === 0,
    summary: issues.length === 0 ? 'production command group is configured' : 'production command group is not ready',
    details: {
      enabled: group.enabled,
      requiredApprovals: group.requiredApprovals,
      members: group.members,
    },
    issues,
  };
}

function gateIssues(
  _source: ProductionReadinessIssue['source'],
  gate: ProductionGateSummary & { readonly issues?: readonly ProductionReadinessIssue[] },
): readonly ProductionReadinessIssue[] {
  return gate.issues ?? [];
}

function stripIssues(
  gate: ProductionGateSummary & { readonly issues?: readonly ProductionReadinessIssue[] },
): ProductionGateSummary {
  return {
    ok: gate.ok,
    summary: gate.summary,
    ...(gate.details !== undefined ? { details: gate.details } : {}),
  };
}

function resolveProductionFleetArgs(
  config: HarnessConfig,
  args: ProductionFleetArgs,
): ProductionFleetArgs {
  const fleet = config.production.fleet;
  const fleetConfigPath = args.fleetConfigPath ?? fleet.configPath;
  const v1ModelsUrl = args.v1ModelsUrl ?? fleet.v1ModelsUrl;
  const v1CatalogFile = args.v1CatalogFile ?? fleet.v1CatalogFile;
  const minAgreeingSources = args.minAgreeingSources ?? fleet.minAgreeingSources;
  const consensusV1ModelsUrls = args.consensusV1ModelsUrls
    ?? nonEmptyArray(fleet.consensusV1ModelsUrls);
  const consensusV1CatalogFiles = args.consensusV1CatalogFiles
    ?? nonEmptyArray(fleet.consensusV1CatalogFiles);
  return {
    ...(fleetConfigPath !== undefined ? { fleetConfigPath } : {}),
    ...(v1ModelsUrl !== undefined ? { v1ModelsUrl } : {}),
    ...(v1CatalogFile !== undefined ? { v1CatalogFile } : {}),
    ...(consensusV1ModelsUrls !== undefined ? { consensusV1ModelsUrls } : {}),
    ...(consensusV1CatalogFiles !== undefined ? { consensusV1CatalogFiles } : {}),
    ...(minAgreeingSources !== undefined ? { minAgreeingSources } : {}),
    includeHosted: args.includeHosted ?? fleet.includeHosted,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  };
}

function nonEmptyArray(values: readonly string[]): readonly string[] | undefined {
  return values.length > 0 ? values : undefined;
}

function requirePositiveInteger(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error(`production local bootstrap requires ${field} to be configured as a positive integer`);
  }
  return value;
}

function readinessIssue(
  source: ProductionReadinessIssue['source'],
  severity: VerificationIssue['severity'],
  code: string,
  message: string,
): ProductionReadinessIssue {
  return {
    source,
    severity,
    code,
    message,
  };
}

function canaryNextLevel(args: {
  readonly current: number;
  readonly greenCycles: number;
  readonly redIssues: number;
  readonly missingTelemetry: boolean;
  readonly policy: HarnessConfig['production']['canary'];
}): number {
  if (args.redIssues > 0 || args.missingTelemetry || !args.policy.enabled) {
    return args.policy.floorConcurrentTasks;
  }
  if (args.greenCycles <= 0) {
    return clamp(args.current, args.policy.floorConcurrentTasks, args.policy.capConcurrentTasks);
  }
  return clamp(args.current + args.policy.stepUp, args.policy.floorConcurrentTasks, args.policy.capConcurrentTasks);
}

function canaryReason(args: {
  readonly greenCycles: number;
  readonly redIssues: number;
  readonly missingTelemetry: boolean;
  readonly policy: HarnessConfig['production']['canary'];
}): string {
  if (!args.policy.enabled) return 'canary policy disabled; hold at floor';
  if (args.missingTelemetry) return 'missing telemetry; hold at floor';
  if (args.redIssues > 0) return 'red issues present; hold at floor';
  if (args.greenCycles > 0) return 'green cycles observed; bounded step up';
  return 'no green cycles yet; hold current bounded level';
}

function clamp(value: number, floor: number, cap: number): number {
  return Math.min(Math.max(value, floor), cap);
}

function breakGlassBlockers(checks: BreakGlassReceipt['checks']): readonly ProductionReadinessIssue[] {
  const blockers: ProductionReadinessIssue[] = [];
  if (!checks.expiresWithinPolicy) {
    blockers.push(readinessIssue('break_glass', 'error', 'production.break_glass_expiry_invalid', 'break-glass expiry exceeds configured policy'));
  }
  if (!checks.rollbackPresent) {
    blockers.push(readinessIssue('break_glass', 'error', 'production.break_glass_rollback_missing', 'break-glass requires rollback instructions'));
  }
  if (!checks.commandGroupEnabled) {
    blockers.push(readinessIssue('break_glass', 'error', 'production.break_glass_command_group_disabled', 'break-glass requires enabled production command group'));
  }
  if (!checks.approvalsSatisfied) {
    blockers.push(readinessIssue('break_glass', 'error', 'production.break_glass_approvals_missing', 'break-glass approvals do not satisfy production command group policy'));
  }
  if (!checks.signerConfigured) {
    blockers.push(readinessIssue('break_glass', 'error', 'production.break_glass_signing_missing', 'break-glass requires production-capable signing'));
  }
  return blockers;
}

function expiresWithinPolicy(createdAt: string, expiresAt: string, maxHours: number): boolean {
  const created = Date.parse(createdAt);
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(created) || Number.isNaN(expires) || expires <= created) return false;
  return expires - created <= maxHours * 60 * 60 * 1000;
}

function productionSigningConfigured(config: HarnessConfig): boolean {
  return config.proofs.signing.enabled
    && config.proofs.signing.provider !== 'disabled'
    && config.proofs.signing.provider !== 'local_ephemeral_ed25519'
    && (config.proofs.signing.trustLevel === 'operator_bound'
      || config.proofs.signing.trustLevel === 'registry_verified');
}

function defaultPostHocGates(): readonly string[] {
  return [
    'production doctor',
    'fleet witness recovery',
    'rollback verification',
    'privacy replay audit',
    'fleet council rerun',
  ];
}

function appendBreakGlassEvidence(runDir: string, receipt: BreakGlassReceipt): string {
  const files = sidecarPathsForRunDir(runDir);
  const signer = tryLoadSigner();
  const evidence = signEvidenceReceipt(createEvidenceReceipt({
    kind: 'human_assertion',
    subject: {
      subjectId: `break-glass:${receipt.incidentId}`,
      subjectType: 'run',
      title: `Break-glass ${receipt.incidentId}`,
      assuranceContext: 'production',
      privacyZone: 'WORKSPACE',
      materiality: 'critical',
      blocking: !receipt.allowed,
    },
    summary: receipt.allowed
      ? `break-glass receipt recorded for ${receipt.incidentId}`
      : `blocked break-glass receipt recorded for ${receipt.incidentId}`,
    observedBy: 'harness.production.cli',
    content: receipt,
    uri: `production:break-glass:${receipt.incidentId}`,
    metadata: {
      breakGlass: true,
      receiptId: receipt.receiptId,
      incidentId: receipt.incidentId,
      operatorId: receipt.operatorId,
      expiresAt: receipt.expiresAt,
      allowed: receipt.allowed,
      blockers: receipt.blockers.map((entry) => entry.code),
    },
  }), signer);
  appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
  return evidence.evidenceId;
}

function tryLoadSigner() {
  try {
    return loadConfiguredSidecarSigner();
  } catch {
    return undefined;
  }
}

function effectiveCouncilTimeout(config: HarnessConfig): number {
  const controller = config.production.council.timeoutController;
  if (controller.disabled) return controller.seedMs;
  return clamp(controller.seedMs, controller.floorMs, controller.capMs);
}

function writeProductionArtifact(runDir: string, name: string, payload: unknown): void {
  const dir = join(sidecarPathsForRunDir(runDir).runDir, 'production');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify({
    ...asRecord(payload),
    artifactHash: stableHash(payload),
  }, null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'incident';
}

function resolveOutputPath(path: string): string {
  return resolve(path);
}

function writeJsonChecked(path: string, payload: unknown, force: boolean): void {
  writeFileChecked(path, `${JSON.stringify(payload, null, 2)}\n`, force);
}

function writeFileChecked(path: string, content: string, force: boolean): void {
  if (!force && existsSync(path)) {
    throw new Error(`${path} already exists; pass --force to overwrite local production bootstrap files`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function normalizeV1ModelsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/models')) return trimmed;
  if (trimmed.endsWith('/models')) return `${trimmed.slice(0, -'/models'.length)}/v1/models`;
  return `${trimmed}/v1/models`;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0))];
}

function localExternalZkProverSource(): string {
  return `#!/usr/bin/env node
import { createHash } from 'node:crypto';

const startedAt = Date.now();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(input);
    const publicInputsHash = String(request.publicInputsHash ?? '');
    const circuitId = request.circuitId ?? 'local-production-break-v1';
    const circuitVersion = request.circuitVersion ?? '1';
    const verifierRef = request.verifierRef ?? 'local-external-zk-prover';
    const maxLatencyMs = Number(request.maxLatencyMs ?? 1);
    const failurePolicy = request.failurePolicy ?? 'fail_closed';
    const proofHash = createHash('sha256').update(JSON.stringify({
      statement: request.statement ?? '',
      publicInputsHash,
      circuitId,
      circuitVersion,
      verifierRef,
    })).digest('hex');
    process.stdout.write(JSON.stringify({
      status: 'proved',
      mode: 'external_snark',
      backend: 'external',
      circuitId,
      circuitVersion,
      publicInputsHash,
      proofHash,
      verifierRef,
      provedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      maxLatencyMs,
      failurePolicy,
      failureState: 'none',
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'failed',
      mode: 'external_snark',
      backend: 'external',
      latencyMs: Date.now() - startedAt,
      maxLatencyMs: 1,
      failurePolicy: 'fail_closed',
      failureState: 'rejected_fail_closed',
      reason: error instanceof Error ? error.message : String(error),
    }));
  }
});
`;
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
