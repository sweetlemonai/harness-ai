import { readFileSync } from 'node:fs';
import { createEvidenceReceipt } from '../lib/evidence/ledger.js';
import {
  loadConfiguredSidecarSigner,
  signEvidenceReceipt,
} from '../lib/proof/signing.js';
import { appendLedgerEntry } from '../lib/protocol/ledger.js';
import { sidecarPathsForRunDir } from '../lib/protocol/sidecar.js';

export interface FleetDoctorCommandArgs {
  readonly configPath?: string;
  readonly v1ModelsUrl?: string;
  readonly v1CatalogFile?: string;
  readonly consensusV1ModelsUrls?: readonly string[];
  readonly consensusV1CatalogFiles?: readonly string[];
  readonly includeHosted?: boolean;
  readonly chatSmoke?: boolean;
  readonly runDir?: string;
  readonly timeoutMs?: number;
  readonly minAgreeingSources?: number;
  readonly json?: boolean;
}

export interface FleetConfig {
  readonly schema?: string;
  readonly source?: FleetSourceConfig;
  readonly selection?: FleetSelectionConfig;
  readonly panel?: readonly FleetMemberOverlay[];
  readonly overrides?: Record<string, FleetMemberOverlay>;
  readonly disabled_models?: readonly string[];
  readonly exclude_models?: readonly string[];
  readonly timeout_s?: number;
  readonly max_tokens?: number;
  readonly temperature?: number;
}

interface FleetSourceConfig {
  readonly kind?: string;
  readonly url?: string;
  readonly v1_url?: string;
  readonly models_url?: string;
  readonly file?: string;
  readonly catalog_file?: string;
  readonly fallback_file?: string;
  readonly consensus_urls?: readonly string[];
  readonly consensus_files?: readonly string[];
  readonly secondary_urls?: readonly string[];
  readonly secondary_files?: readonly string[];
  readonly min_agreeing_sources?: number;
  readonly include_hosted?: boolean;
}

interface FleetSelectionConfig {
  readonly require_upstream?: boolean;
  readonly include_hosted?: boolean;
  readonly require_hot_memory?: boolean;
  readonly include_models?: readonly string[];
  readonly exclude_models?: readonly string[];
  readonly include_sources?: readonly string[];
  readonly exclude_sources?: readonly string[];
}

interface FleetMemberOverlay {
  readonly id?: string;
  readonly name?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly request_model?: string;
  readonly v1_model_id?: string;
  readonly max_tokens?: number;
  readonly timeout_s?: number;
  readonly temperature?: number;
  readonly disable_thinking_prompt?: boolean;
  readonly disabled?: boolean;
  readonly deprecated?: boolean;
}

export interface FleetMemberConfig {
  readonly name: string;
  readonly endpoint: string;
  readonly model: string;
  readonly modelCandidates: readonly string[];
  readonly v1ModelId?: string;
  readonly nodeId?: string;
  readonly inventorySource?: string;
  readonly max_tokens?: number;
  readonly timeout_s?: number;
  readonly temperature?: number;
  readonly disable_thinking_prompt?: boolean;
}

interface FleetMemberDoctorResult {
  readonly name: string;
  readonly endpoint: string;
  readonly model: string;
  readonly requestedModel: string;
  readonly modelCandidates: readonly string[];
  readonly v1ModelId?: string;
  readonly nodeId?: string;
  readonly inventorySource?: string;
  readonly modelsEndpoint: string;
  readonly chatEndpoint: string;
  readonly reachable: boolean;
  readonly configuredModelPresent: boolean;
  readonly availableModelIds: readonly string[];
  readonly missingConfiguredModel: boolean;
  readonly error?: string;
  readonly chatSmoke?: ChatSmokeResult;
}

interface ChatSmokeResult {
  readonly ok: boolean;
  readonly status: 'ok' | 'empty' | 'reasoning_only' | 'error';
  readonly contentLength: number;
  readonly contentPreview: string;
  readonly reasoningPresent: boolean;
  readonly finishReason?: string;
  readonly completionTokens?: number;
  readonly error?: string;
}

interface V1CatalogRecord {
  readonly id: string;
  readonly providerModelId?: string;
  readonly hfModelId?: string;
  readonly model?: string;
  readonly name?: string;
  readonly nodeId?: string;
  readonly upstream?: string;
  readonly source?: string;
  readonly hotMemory: boolean;
  readonly raw: Record<string, unknown>;
}

interface FleetSourceResolution {
  readonly kind: 'v1_url' | 'v1_file';
  readonly uri: string;
  readonly fallbackFile?: string;
}

interface FleetInventory {
  readonly sourceKind: 'v1_url' | 'v1_file';
  readonly uri: string;
  readonly baseUrl?: string;
  readonly catalog: Record<string, unknown>;
}

interface V1ConsensusSourceSummary {
  readonly kind: 'v1_url' | 'v1_file';
  readonly uri: string;
  readonly v1ModelCount: number;
  readonly activeModelCount: number;
  readonly activeModelIds: readonly string[];
}

interface V1ConsensusUnavailableSource {
  readonly kind: 'v1_url' | 'v1_file';
  readonly uri: string;
  readonly error: string;
}

interface V1ConsensusDisagreement {
  readonly modelId: string;
  readonly presentIn: readonly string[];
  readonly missingFrom: readonly string[];
}

interface V1ConsensusCheck {
  readonly mode: 'not_configured' | 'checked';
  readonly ok: boolean;
  readonly requiredAgreeingSources: number;
  readonly sourcesChecked: number;
  readonly sources: readonly V1ConsensusSourceSummary[];
  readonly unavailableSources: readonly V1ConsensusUnavailableSource[];
  readonly disagreements: readonly V1ConsensusDisagreement[];
}

export interface FleetResolution {
  readonly modelSource: {
    readonly kind: 'v1_url' | 'v1_file' | 'config_panel';
    readonly uri?: string;
    readonly baseUrl?: string;
  };
  readonly members: readonly FleetMemberConfig[];
  readonly v1ModelCount: number;
  readonly skippedNoUpstream: number;
  readonly skippedDisabled: number;
  readonly configuredAbsentFromV1: readonly ConfiguredAbsentFromV1[];
  readonly v1Consensus: V1ConsensusCheck;
}

interface ConfiguredAbsentFromV1 {
  readonly source: 'panel' | 'overrides';
  readonly key: string;
  readonly name?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly disabled: boolean;
}

export async function fleetDoctorCommand(
  args: FleetDoctorCommandArgs,
): Promise<number> {
  const config = readFleetConfig(args.configPath);
  const timeoutMs = args.timeoutMs ?? secondsToMs(config.timeout_s ?? 30);
  const resolution = await resolveFleetMembers({
    config,
    ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
    ...(args.v1ModelsUrl !== undefined ? { v1ModelsUrl: args.v1ModelsUrl } : {}),
    ...(args.v1CatalogFile !== undefined ? { v1CatalogFile: args.v1CatalogFile } : {}),
    ...(args.consensusV1ModelsUrls !== undefined ? { consensusV1ModelsUrls: args.consensusV1ModelsUrls } : {}),
    ...(args.consensusV1CatalogFiles !== undefined ? { consensusV1CatalogFiles: args.consensusV1CatalogFiles } : {}),
    ...(args.includeHosted !== undefined ? { includeHosted: args.includeHosted } : {}),
    ...(args.minAgreeingSources !== undefined ? { minAgreeingSources: args.minAgreeingSources } : {}),
    timeoutMs,
  });
  const results = await Promise.all(resolution.members.map((member) => doctorMember({
    member,
    config,
    timeoutMs,
    chatSmoke: args.chatSmoke === true,
  })));
  const missingConfiguredModels = results.filter((entry) => entry.missingConfiguredModel);
  const unreachable = results.filter((entry) => !entry.reachable);
  const smokeFailures = results.filter((entry) => entry.chatSmoke !== undefined && !entry.chatSmoke.ok);
  const availableButUnconfigured = summarizeAvailableButUnconfigured(results);
  const activeConfiguredAbsentFromV1 = resolution.configuredAbsentFromV1.filter((entry) => !entry.disabled);
  const emptyActiveRoster = resolution.modelSource.kind !== 'config_panel' && results.length === 0;
  const payload = {
    configPath: args.configPath ?? null,
    modelSource: resolution.modelSource,
    panelSize: results.length,
    ok: !emptyActiveRoster
      && missingConfiguredModels.length === 0
      && unreachable.length === 0
      && smokeFailures.length === 0
      && activeConfiguredAbsentFromV1.length === 0
      && resolution.v1Consensus.ok,
    policy: {
      activeRosterAuthority: 'v1_models_inventory',
      configRole: 'policy_overlay_not_inventory',
      localModelBudgets: 'latency_urgency_guardrails_not_token_spend_caps',
    },
    counts: {
      v1Models: resolution.v1ModelCount,
      activeMembers: results.length,
      emptyActiveRoster: emptyActiveRoster ? 1 : 0,
      skippedNoUpstream: resolution.skippedNoUpstream,
      skippedDisabled: resolution.skippedDisabled,
      unreachable: unreachable.length,
      missingConfiguredModels: missingConfiguredModels.length,
      smokeFailures: smokeFailures.length,
      availableButUnconfigured: availableButUnconfigured.length,
      configuredAbsentFromV1: activeConfiguredAbsentFromV1.length,
      v1ConsensusDisagreements: resolution.v1Consensus.disagreements.length,
      v1ConsensusUnavailableSources: resolution.v1Consensus.unavailableSources.length,
    },
    v1Consensus: resolution.v1Consensus,
    configuredAbsentFromV1: activeConfiguredAbsentFromV1,
    availableButUnconfigured,
    results,
  };
  let evidenceId: string | null = null;
  if (args.runDir !== undefined) {
    evidenceId = writeFleetProbeEvidence(args.runDir, payload);
  }
  writeOutput({ ...payload, evidenceId }, args.json === true);
  return payload.ok ? 0 : 1;
}

function writeFleetProbeEvidence(
  runDir: string,
  payload: {
    readonly configPath: string | null;
    readonly modelSource: {
      readonly kind: 'v1_url' | 'v1_file' | 'config_panel';
      readonly uri?: string;
      readonly baseUrl?: string;
    };
    readonly panelSize: number;
    readonly ok: boolean;
    readonly counts: {
      readonly v1Models: number;
      readonly activeMembers: number;
      readonly emptyActiveRoster: number;
      readonly skippedNoUpstream: number;
      readonly skippedDisabled: number;
      readonly unreachable: number;
      readonly missingConfiguredModels: number;
      readonly smokeFailures: number;
      readonly availableButUnconfigured: number;
      readonly configuredAbsentFromV1: number;
      readonly v1ConsensusDisagreements: number;
      readonly v1ConsensusUnavailableSources: number;
    };
  },
): string {
  const files = sidecarPathsForRunDir(runDir);
  const evidence = signEvidenceReceipt(createEvidenceReceipt({
    kind: 'fleet_probe',
    subject: {
      subjectId: `fleet:${payload.modelSource.kind}:${payload.modelSource.uri ?? payload.configPath ?? 'unconfigured'}`,
      subjectType: 'model',
      title: 'fleet doctor probe',
      assuranceContext: 'alpha',
      privacyZone: 'WORKSPACE',
      materiality: payload.ok ? 'medium' : 'critical',
    },
    summary: payload.ok ? 'fleet doctor passed' : 'fleet doctor found drift',
    observedBy: 'harness.fleet.cli',
    content: payload,
    metadata: {
      modelSource: payload.modelSource.kind,
      panelSize: payload.panelSize,
      v1Models: payload.counts.v1Models,
      activeMembers: payload.counts.activeMembers,
      emptyActiveRoster: payload.counts.emptyActiveRoster,
      skippedNoUpstream: payload.counts.skippedNoUpstream,
      skippedDisabled: payload.counts.skippedDisabled,
      unreachable: payload.counts.unreachable,
      missingConfiguredModels: payload.counts.missingConfiguredModels,
      smokeFailures: payload.counts.smokeFailures,
      availableButUnconfigured: payload.counts.availableButUnconfigured,
      configuredAbsentFromV1: payload.counts.configuredAbsentFromV1,
      v1ConsensusDisagreements: payload.counts.v1ConsensusDisagreements,
      v1ConsensusUnavailableSources: payload.counts.v1ConsensusUnavailableSources,
    },
  }), loadConfiguredSidecarSigner());
  appendLedgerEntry(files.evidenceFile, evidence as unknown as Record<string, unknown>);
  return evidence.evidenceId;
}

export function readFleetConfig(path: string | undefined): FleetConfig {
  if (path === undefined) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as FleetConfig;
  if (parsed.panel !== undefined && !Array.isArray(parsed.panel)) {
    throw new Error(`fleet config ${path} panel must be an array when present`);
  }
  if (
    parsed.overrides !== undefined
    && (parsed.overrides === null || typeof parsed.overrides !== 'object' || Array.isArray(parsed.overrides))
  ) {
    throw new Error(`fleet config ${path} overrides must be an object when present`);
  }
  return parsed;
}

export async function resolveFleetMembers(args: {
  readonly config: FleetConfig;
  readonly configPath?: string;
  readonly v1ModelsUrl?: string;
  readonly v1CatalogFile?: string;
  readonly consensusV1ModelsUrls?: readonly string[];
  readonly consensusV1CatalogFiles?: readonly string[];
  readonly includeHosted?: boolean;
  readonly minAgreeingSources?: number;
  readonly requireV1Inventory?: boolean;
  readonly timeoutMs: number;
}): Promise<FleetResolution> {
  const source = resolveV1Source(args);
  if (source !== null) {
    const inventory = await loadV1Inventory(source, args.timeoutMs);
    const consensus = await checkV1Consensus({
      primary: inventory,
      sources: resolveConsensusSources(args.config, args.consensusV1ModelsUrls, args.consensusV1CatalogFiles),
      timeoutMs: args.timeoutMs,
      ...((args.minAgreeingSources ?? args.config.source?.min_agreeing_sources) !== undefined
        ? { minAgreeingSources: (args.minAgreeingSources ?? args.config.source?.min_agreeing_sources)! }
        : {}),
    });
    const resolution = resolveFleetMembersFromV1Catalog(
      inventory.catalog,
      args.config,
      {
        kind: inventory.sourceKind,
        uri: inventory.uri,
        ...(inventory.baseUrl !== undefined ? { baseUrl: inventory.baseUrl } : {}),
      },
      args.includeHosted,
      consensus,
    );
    if (args.requireV1Inventory === true && resolution.members.length === 0) {
      throw new Error('production fleet resolution requires at least one active V1 model with an upstream');
    }
    return resolution;
  }
  if (args.requireV1Inventory === true) {
    throw new Error('production fleet resolution requires a V1 model inventory source');
  }
  return resolveFleetMembersFromConfigPanel(args.config, args.configPath);
}

function resolveV1Source(args: {
  readonly config: FleetConfig;
  readonly v1ModelsUrl?: string;
  readonly v1CatalogFile?: string;
}): FleetSourceResolution | null {
  if (args.v1ModelsUrl !== undefined) {
    return { kind: 'v1_url', uri: normalizeV1ModelsUrl(args.v1ModelsUrl) };
  }
  if (args.v1CatalogFile !== undefined) {
    return { kind: 'v1_file', uri: args.v1CatalogFile };
  }
  const source = args.config.source;
  const sourceUrl = source?.url ?? source?.v1_url ?? source?.models_url;
  if (sourceUrl !== undefined && sourceUrl.trim().length > 0) {
    return {
      kind: 'v1_url',
      uri: normalizeV1ModelsUrl(sourceUrl),
      ...(source?.fallback_file !== undefined ? { fallbackFile: source.fallback_file } : {}),
    };
  }
  const sourceFile = source?.file ?? source?.catalog_file ?? source?.fallback_file;
  if (sourceFile !== undefined && sourceFile.trim().length > 0) {
    return { kind: 'v1_file', uri: sourceFile };
  }
  return null;
}

async function loadV1Inventory(source: FleetSourceResolution, timeoutMs: number): Promise<FleetInventory> {
  if (source.kind === 'v1_file') {
    const parsed = JSON.parse(readFileSync(source.uri, 'utf8')) as Record<string, unknown>;
    return inventoryFromParsedCatalog(source.kind, source.uri, parsed);
  }
  try {
    const parsed = await fetchJson(source.uri, timeoutMs) as Record<string, unknown>;
    return inventoryFromParsedCatalog(source.kind, source.uri, parsed);
  } catch (err) {
    if (source.fallbackFile !== undefined && source.fallbackFile.trim().length > 0) {
      const parsed = JSON.parse(readFileSync(source.fallbackFile, 'utf8')) as Record<string, unknown>;
      return inventoryFromParsedCatalog('v1_file', source.fallbackFile, parsed);
    }
    throw err;
  }
}

function resolveConsensusSources(
  config: FleetConfig,
  urls: readonly string[] | undefined,
  files: readonly string[] | undefined,
): readonly FleetSourceResolution[] {
  const source = config.source;
  const configuredUrls = [
    ...(source?.consensus_urls ?? []),
    ...(source?.secondary_urls ?? []),
  ];
  const configuredFiles = [
    ...(source?.consensus_files ?? []),
    ...(source?.secondary_files ?? []),
  ];
  return [
    ...(urls ?? configuredUrls).map((url) => ({
      kind: 'v1_url' as const,
      uri: normalizeV1ModelsUrl(url),
    })),
    ...(files ?? configuredFiles).map((file) => ({
      kind: 'v1_file' as const,
      uri: file,
    })),
  ];
}

async function checkV1Consensus(args: {
  readonly primary: FleetInventory;
  readonly sources: readonly FleetSourceResolution[];
  readonly timeoutMs: number;
  readonly minAgreeingSources?: number;
}): Promise<V1ConsensusCheck> {
  if (args.sources.length === 0) return noV1ConsensusCheck();
  const sources: V1ConsensusSourceSummary[] = [
    summarizeV1Inventory(args.primary),
  ];
  const unavailableSources: V1ConsensusUnavailableSource[] = [];
  for (const source of args.sources) {
    try {
      sources.push(summarizeV1Inventory(await loadV1Inventory(source, args.timeoutMs)));
    } catch (err) {
      unavailableSources.push({
        kind: source.kind,
        uri: source.uri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const requiredAgreeingSources = Math.max(
    2,
    args.minAgreeingSources ?? sources.length + unavailableSources.length,
  );
  const disagreements = compareV1SourceSummaries(sources);
  return {
    mode: 'checked',
    ok: unavailableSources.length === 0
      && sources.length >= requiredAgreeingSources
      && disagreements.length === 0,
    requiredAgreeingSources,
    sourcesChecked: sources.length,
    sources,
    unavailableSources,
    disagreements,
  };
}

function noV1ConsensusCheck(): V1ConsensusCheck {
  return {
    mode: 'not_configured',
    ok: true,
    requiredAgreeingSources: 1,
    sourcesChecked: 1,
    sources: [],
    unavailableSources: [],
    disagreements: [],
  };
}

function summarizeV1Inventory(inventory: FleetInventory): V1ConsensusSourceSummary {
  const records = recordsFromV1Catalog(inventory.catalog);
  const activeModelIds = records
    .filter((record) => record.hotMemory)
    .map((record) => record.id)
    .sort();
  return {
    kind: inventory.sourceKind,
    uri: inventory.uri,
    v1ModelCount: records.length,
    activeModelCount: activeModelIds.length,
    activeModelIds,
  };
}

function compareV1SourceSummaries(
  sources: readonly V1ConsensusSourceSummary[],
): readonly V1ConsensusDisagreement[] {
  if (sources.length < 2) return [];
  const allIds = new Set<string>();
  for (const source of sources) {
    for (const id of source.activeModelIds) allIds.add(id);
  }
  const disagreements: V1ConsensusDisagreement[] = [];
  for (const modelId of [...allIds].sort()) {
    const presentIn = sources
      .filter((source) => source.activeModelIds.includes(modelId))
      .map((source) => source.uri);
    if (presentIn.length === sources.length) continue;
    disagreements.push({
      modelId,
      presentIn,
      missingFrom: sources
        .filter((source) => !source.activeModelIds.includes(modelId))
        .map((source) => source.uri),
    });
  }
  return disagreements;
}

function inventoryFromParsedCatalog(
  sourceKind: 'v1_url' | 'v1_file',
  uri: string,
  parsed: Record<string, unknown>,
): FleetInventory {
  const catalog = isRecord(parsed.catalog) ? parsed.catalog : parsed;
  return {
    sourceKind,
    uri,
    catalog,
    ...(typeof parsed.base_url === 'string' && parsed.base_url.trim().length > 0
      ? { baseUrl: parsed.base_url.trim() }
      : {}),
  };
}

export function resolveFleetMembersFromV1CatalogForTest(
  catalog: Record<string, unknown>,
  config: FleetConfig,
): FleetResolution {
  return resolveFleetMembersFromV1Catalog(
    catalog,
    config,
    { kind: 'v1_file', uri: 'test-v1-catalog' },
    false,
    noV1ConsensusCheck(),
  );
}

function resolveFleetMembersFromV1Catalog(
  catalog: Record<string, unknown>,
  config: FleetConfig,
  modelSource: {
    readonly kind: 'v1_url' | 'v1_file';
    readonly uri: string;
    readonly baseUrl?: string;
  },
  includeHostedOverride: boolean | undefined,
  v1Consensus: V1ConsensusCheck,
): FleetResolution {
  const records = recordsFromV1Catalog(catalog);
  const overlayIndex = buildOverlayIndex(config);
  const includeHosted = includeHostedOverride
    ?? config.selection?.include_hosted
    ?? config.source?.include_hosted
    ?? false;
  const requireUpstream = config.selection?.require_upstream ?? !includeHosted;
  const requireHotMemory = config.selection?.require_hot_memory ?? true;
  const includeModels = normalizedSet(config.selection?.include_models);
  const excludeModels = normalizedSet([
    ...(config.selection?.exclude_models ?? []),
    ...(config.exclude_models ?? []),
    ...(config.disabled_models ?? []),
  ]);
  const includeSources = normalizedSet(config.selection?.include_sources);
  const excludeSources = normalizedSet(config.selection?.exclude_sources);
  const members: FleetMemberConfig[] = [];
  const seen = new Set<string>();
  let skippedNoUpstream = 0;
  let skippedDisabled = 0;

  for (const record of records) {
    const keys = recordKeys(record);
    const sourceKey = normalizeKey(record.source ?? '');
    if (requireHotMemory && !record.hotMemory) {
      skippedDisabled += 1;
      continue;
    }
    if (includeSources.size > 0 && !includeSources.has(sourceKey)) {
      skippedDisabled += 1;
      continue;
    }
    if (excludeSources.has(sourceKey)) {
      skippedDisabled += 1;
      continue;
    }
    if (includeModels.size > 0 && !hasSetIntersection(includeModels, keys)) {
      skippedDisabled += 1;
      continue;
    }
    if (hasSetIntersection(excludeModels, keys)) {
      skippedDisabled += 1;
      continue;
    }
    const overlay = overlayForRecord(overlayIndex, record);
    if (overlay?.disabled === true || overlay?.deprecated === true) {
      skippedDisabled += 1;
      continue;
    }
    const endpoint = normalizeEndpoint(record.upstream ?? overlay?.endpoint ?? '');
    if (endpoint.length === 0 && requireUpstream) {
      skippedNoUpstream += 1;
      continue;
    }
    if (endpoint.length === 0) {
      skippedNoUpstream += 1;
      continue;
    }
    const modelCandidates = uniqueStrings([
      overlay?.model,
      overlay?.request_model,
      record.hfModelId,
      record.providerModelId,
      record.model,
      record.name,
      record.id,
    ]);
    const primaryModel = modelCandidates[0];
    if (primaryModel === undefined) {
      skippedDisabled += 1;
      continue;
    }
    const dedupeKey = `${endpoint}\n${primaryModel}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    members.push({
      name: overlay?.name ?? record.nodeId ?? record.id,
      endpoint,
      model: primaryModel,
      modelCandidates,
      v1ModelId: record.id,
      ...(record.nodeId !== undefined ? { nodeId: record.nodeId } : {}),
      ...(record.source !== undefined ? { inventorySource: record.source } : {}),
      ...(overlay?.max_tokens !== undefined ? { max_tokens: overlay.max_tokens } : {}),
      ...(overlay?.timeout_s !== undefined ? { timeout_s: overlay.timeout_s } : {}),
      ...(overlay?.temperature !== undefined ? { temperature: overlay.temperature } : {}),
      ...(overlay?.disable_thinking_prompt !== undefined ? { disable_thinking_prompt: overlay.disable_thinking_prompt } : {}),
    });
  }

  return {
    modelSource,
    members,
    v1ModelCount: records.length,
    skippedNoUpstream,
    skippedDisabled,
    configuredAbsentFromV1: configuredAbsentFromV1(config, records),
    v1Consensus,
  };
}

function resolveFleetMembersFromConfigPanel(config: FleetConfig, configPath: string | undefined): FleetResolution {
  if (!Array.isArray(config.panel) || config.panel.length === 0) {
    throw new Error('fleet doctor requires --v1-url/--v1-file or a config source; legacy panel-only configs require a non-empty panel array');
  }
  const members = config.panel.map((member) => {
    if (member.name === undefined || member.endpoint === undefined || member.model === undefined) {
      throw new Error('legacy panel member requires name, endpoint, and model');
    }
    return {
      name: member.name,
      endpoint: normalizeEndpoint(member.endpoint),
      model: member.model,
      modelCandidates: uniqueStrings([member.model, member.request_model]),
      ...(member.v1_model_id !== undefined ? { v1ModelId: member.v1_model_id } : {}),
      ...(member.max_tokens !== undefined ? { max_tokens: member.max_tokens } : {}),
      ...(member.timeout_s !== undefined ? { timeout_s: member.timeout_s } : {}),
      ...(member.temperature !== undefined ? { temperature: member.temperature } : {}),
      ...(member.disable_thinking_prompt !== undefined ? { disable_thinking_prompt: member.disable_thinking_prompt } : {}),
    } satisfies FleetMemberConfig;
  });
  return {
    modelSource: {
      kind: 'config_panel',
      ...(configPath !== undefined ? { uri: configPath } : {}),
    },
    members,
    v1ModelCount: 0,
    skippedNoUpstream: 0,
    skippedDisabled: 0,
    configuredAbsentFromV1: [],
    v1Consensus: noV1ConsensusCheck(),
  };
}

async function doctorMember(args: {
  readonly member: FleetMemberConfig;
  readonly config: FleetConfig;
  readonly timeoutMs: number;
  readonly chatSmoke: boolean;
}): Promise<FleetMemberDoctorResult> {
  const endpoints = endpointsFor(args.member.endpoint);
  try {
    const modelsResponse = await fetchJson(endpoints.modelsEndpoint, args.timeoutMs);
    const availableModelIds = modelIdsFromResponse(modelsResponse);
    const selectedModel = selectAvailableModel(args.member, availableModelIds);
    const configuredModelPresent = selectedModel !== null;
    const requestedModel = selectedModel ?? args.member.model;
    const base = {
      name: args.member.name,
      endpoint: args.member.endpoint,
      model: requestedModel,
      requestedModel,
      modelCandidates: args.member.modelCandidates,
      ...(args.member.v1ModelId !== undefined ? { v1ModelId: args.member.v1ModelId } : {}),
      ...(args.member.nodeId !== undefined ? { nodeId: args.member.nodeId } : {}),
      ...(args.member.inventorySource !== undefined ? { inventorySource: args.member.inventorySource } : {}),
      modelsEndpoint: endpoints.modelsEndpoint,
      chatEndpoint: endpoints.chatEndpoint,
      reachable: true,
      configuredModelPresent,
      availableModelIds,
      missingConfiguredModel: !configuredModelPresent,
    };
    if (!args.chatSmoke || !configuredModelPresent) {
      return base;
    }
    const smokeMember = { ...args.member, model: requestedModel };
    return {
      ...base,
      chatSmoke: await chatSmoke({
        member: smokeMember,
        config: args.config,
        chatEndpoint: endpoints.chatEndpoint,
        timeoutMs: args.timeoutMs,
      }),
    };
  } catch (err) {
    return {
      name: args.member.name,
      endpoint: args.member.endpoint,
      model: args.member.model,
      requestedModel: args.member.model,
      modelCandidates: args.member.modelCandidates,
      ...(args.member.v1ModelId !== undefined ? { v1ModelId: args.member.v1ModelId } : {}),
      ...(args.member.nodeId !== undefined ? { nodeId: args.member.nodeId } : {}),
      ...(args.member.inventorySource !== undefined ? { inventorySource: args.member.inventorySource } : {}),
      modelsEndpoint: endpoints.modelsEndpoint,
      chatEndpoint: endpoints.chatEndpoint,
      reachable: false,
      configuredModelPresent: false,
      availableModelIds: [],
      missingConfiguredModel: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function chatSmoke(args: {
  readonly member: FleetMemberConfig;
  readonly config: FleetConfig;
  readonly chatEndpoint: string;
  readonly timeoutMs: number;
}): Promise<ChatSmokeResult> {
  try {
    const userPrompt = args.member.disable_thinking_prompt === true
      ? '/no_think\nReturn exactly: HARNESS_FLEET_OK'
      : 'Return exactly: HARNESS_FLEET_OK';
    const response = await fetchJson(args.chatEndpoint, args.timeoutMs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: args.member.model,
        messages: [
          {
            role: 'system',
            content: 'Return the requested final answer in assistant content. Do not place the final answer only in reasoning fields.',
          },
          {
            role: 'user',
            content: userPrompt,
          },
        ],
        max_tokens: args.member.max_tokens ?? args.config.max_tokens ?? 1800,
        temperature: args.member.temperature ?? args.config.temperature ?? 0,
        stream: false,
      }),
    });
    const extracted = extractAssistantContent(response);
    return {
      ok: extracted.content.trim().length > 0,
      status: extracted.status,
      contentLength: extracted.content.length,
      contentPreview: extracted.content.slice(0, 300),
      reasoningPresent: extracted.reasoningPresent,
      ...(extracted.finishReason !== undefined ? { finishReason: extracted.finishReason } : {}),
      ...(extracted.completionTokens !== undefined ? { completionTokens: extracted.completionTokens } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      contentLength: 0,
      contentPreview: '',
      reasoningPresent: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function endpointsFor(endpoint: string): {
  readonly modelsEndpoint: string;
  readonly chatEndpoint: string;
} {
  const root = endpoint
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/v1\/models\/?$/, '')
    .replace(/\/models\/?$/, '')
    .replace(/\/+$/, '');
  return {
    modelsEndpoint: `${root}/v1/models`,
    chatEndpoint: `${root}/v1/chat/completions`,
  };
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, {
      ...init,
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

function modelIdsFromResponse(response: unknown): readonly string[] {
  const records = response as {
    readonly data?: readonly unknown[];
    readonly models?: readonly unknown[];
  };
  const values = [...(records.data ?? []), ...(records.models ?? [])];
  const ids = new Set<string>();
  for (const value of values) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as {
      readonly id?: unknown;
      readonly model?: unknown;
      readonly name?: unknown;
      readonly aliases?: readonly unknown[];
    };
    for (const candidate of [record.id, record.model, record.name]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) ids.add(candidate);
    }
    for (const alias of record.aliases ?? []) {
      if (typeof alias === 'string' && alias.trim().length > 0) ids.add(alias);
    }
  }
  return [...ids].sort();
}

function recordsFromV1Catalog(catalog: Record<string, unknown>): readonly V1CatalogRecord[] {
  const rawData = Array.isArray(catalog.data) ? catalog.data : [];
  const records: V1CatalogRecord[] = [];
  for (const raw of rawData) {
    if (!isRecord(raw)) continue;
    const id = textValue(raw.id);
    if (id === undefined) continue;
    const providerModelId = textValue(raw.provider_model_id);
    const hfModelId = textValue(raw.hf_model_id);
    const model = textValue(raw.model);
    const name = textValue(raw.name);
    const nodeId = textValue(raw.node_id);
    const upstream = textValue(raw.upstream);
    const source = textValue(raw.source);
    records.push({
      id,
      ...(providerModelId !== undefined ? { providerModelId } : {}),
      ...(hfModelId !== undefined ? { hfModelId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(nodeId !== undefined ? { nodeId } : {}),
      ...(upstream !== undefined ? { upstream } : {}),
      ...(source !== undefined ? { source } : {}),
      hotMemory: raw.hot_memory !== false,
      raw,
    });
  }
  return records;
}

function buildOverlayIndex(config: FleetConfig): Map<string, FleetMemberOverlay> {
  const overlays = new Map<string, FleetMemberOverlay>();
  for (const [key, overlay] of Object.entries(config.overrides ?? {})) {
    overlays.set(normalizeKey(key), overlay);
  }
  for (const member of config.panel ?? []) {
    for (const key of overlayKeys(member)) {
      if (!overlays.has(key)) overlays.set(key, member);
    }
  }
  return overlays;
}

function overlayForRecord(
  overlays: Map<string, FleetMemberOverlay>,
  record: V1CatalogRecord,
): FleetMemberOverlay | undefined {
  for (const key of recordKeys(record)) {
    const overlay = overlays.get(key);
    if (overlay !== undefined) return overlay;
  }
  return undefined;
}

function configuredAbsentFromV1(
  config: FleetConfig,
  records: readonly V1CatalogRecord[],
): readonly ConfiguredAbsentFromV1[] {
  const liveKeys = new Set<string>();
  for (const record of records) {
    for (const key of recordKeys(record)) liveKeys.add(key);
  }
  const absent: ConfiguredAbsentFromV1[] = [];
  for (const member of config.panel ?? []) {
    const keys = overlayKeys(member);
    if (keys.length === 0 || keys.some((key) => liveKeys.has(key))) continue;
    absent.push({
      source: 'panel',
      key: keys[0] ?? member.name ?? member.model ?? 'unknown-panel-member',
      ...(member.name !== undefined ? { name: member.name } : {}),
      ...(member.endpoint !== undefined ? { endpoint: member.endpoint } : {}),
      ...(member.model !== undefined ? { model: member.model } : {}),
      disabled: member.disabled === true || member.deprecated === true,
    });
  }
  for (const [key, member] of Object.entries(config.overrides ?? {})) {
    const keys = [normalizeKey(key), ...overlayKeys(member)];
    if (keys.some((candidate) => liveKeys.has(candidate))) continue;
    absent.push({
      source: 'overrides',
      key,
      ...(member.name !== undefined ? { name: member.name } : {}),
      ...(member.endpoint !== undefined ? { endpoint: member.endpoint } : {}),
      ...(member.model !== undefined ? { model: member.model } : {}),
      disabled: member.disabled === true || member.deprecated === true,
    });
  }
  return absent;
}

function overlayKeys(member: FleetMemberOverlay): readonly string[] {
  return uniqueStrings([
    member.id,
    member.v1_model_id,
    member.model,
    member.request_model,
    member.name,
    member.endpoint,
    member.endpoint !== undefined && member.model !== undefined
      ? `${normalizeEndpoint(member.endpoint)}\n${member.model}`
      : undefined,
  ]).map(normalizeKey);
}

function recordKeys(record: V1CatalogRecord): ReadonlySet<string> {
  return normalizedSet([
    record.id,
    record.providerModelId,
    record.hfModelId,
    record.model,
    record.name,
    record.nodeId,
    record.upstream,
    record.upstream !== undefined ? normalizeEndpoint(record.upstream) : undefined,
    record.upstream !== undefined ? `${normalizeEndpoint(record.upstream)}\n${record.id}` : undefined,
    record.upstream !== undefined && record.providerModelId !== undefined
      ? `${normalizeEndpoint(record.upstream)}\n${record.providerModelId}`
      : undefined,
    record.upstream !== undefined && record.hfModelId !== undefined
      ? `${normalizeEndpoint(record.upstream)}\n${record.hfModelId}`
      : undefined,
  ]);
}

function selectAvailableModel(member: FleetMemberConfig, availableModelIds: readonly string[]): string | null {
  const available = new Set(availableModelIds);
  for (const candidate of member.modelCandidates) {
    if (available.has(candidate)) return candidate;
  }
  return available.has(member.model) ? member.model : null;
}

function extractAssistantContent(response: unknown): {
  readonly status: ChatSmokeResult['status'];
  readonly content: string;
  readonly reasoningPresent: boolean;
  readonly finishReason?: string;
  readonly completionTokens?: number;
} {
  const parsed = response as {
    readonly choices?: ReadonlyArray<{
      readonly finish_reason?: unknown;
      readonly message?: {
        readonly content?: unknown;
        readonly reasoning?: unknown;
        readonly reasoning_content?: unknown;
      };
      readonly text?: unknown;
    }>;
    readonly usage?: {
      readonly completion_tokens?: unknown;
    };
  };
  const first = parsed.choices?.[0];
  const message = first?.message;
  const content = contentToText(message?.content ?? first?.text);
  const reasoningPresent = message?.reasoning !== undefined || message?.reasoning_content !== undefined;
  const base = {
    content,
    reasoningPresent,
    ...(typeof first?.finish_reason === 'string' ? { finishReason: first.finish_reason } : {}),
    ...(typeof parsed.usage?.completion_tokens === 'number' ? { completionTokens: parsed.usage.completion_tokens } : {}),
  };
  if (content.trim().length > 0) return { ...base, status: 'ok' };
  if (reasoningPresent) return { ...base, status: 'reasoning_only' };
  return { ...base, status: 'empty' };
}

function contentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (part !== null && typeof part === 'object' && 'text' in part) {
        const text = (part as { readonly text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}

function summarizeAvailableButUnconfigured(
  results: readonly FleetMemberDoctorResult[],
): ReadonlyArray<{
  readonly endpoint: string;
  readonly model: string;
}> {
  const configured = new Set(results.map((entry) => `${entry.endpoint}\n${entry.model}`));
  const missing: Array<{ endpoint: string; model: string }> = [];
  for (const result of results) {
    for (const id of result.availableModelIds) {
      const key = `${result.endpoint}\n${id}`;
      if (!configured.has(key)) missing.push({ endpoint: result.endpoint, model: id });
    }
  }
  return missing;
}

function normalizeV1ModelsUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/models')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

function normalizeEndpoint(value: string): string {
  return value
    .trim()
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/v1\/models\/?$/, '')
    .replace(/\/models\/?$/, '')
    .replace(/\/+$/, '');
}

function normalizedSet(values: readonly (string | undefined)[] | undefined): ReadonlySet<string> {
  const output = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeKey(value ?? '');
    if (normalized.length > 0) output.add(normalized);
  }
  return output;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStrings(values: readonly (string | undefined | false)[]): readonly string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = normalizeKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function hasSetIntersection(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function secondsToMs(seconds: number): number {
  return Math.max(1, Math.ceil(seconds * 1000));
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
