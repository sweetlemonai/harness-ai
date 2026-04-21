// All shared types and error classes for the harness.
// This file is foundational: nothing in src/ may be imported here, and
// every other module imports from here. Locked after initial write.

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

export const STATE_SCHEMA_VERSION = 1 as const;
export const RUN_SCHEMA_VERSION = 1 as const;
export const EVENT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Task identity
// ---------------------------------------------------------------------------

export interface TaskRef {
  readonly project: string;
  readonly task: string;
}

export const TASK_TYPES = ['ui', 'logic', 'e2e', 'data'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export interface TaskFrontmatter {
  readonly type: TaskType;
  readonly hasDesign: boolean;
  readonly project: string;
  readonly depends: readonly string[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CoreLibraryEntry {
  readonly name: string;
  readonly docs: string;
}

export interface HarnessConfig {
  readonly retries: {
    readonly agent: number;
    readonly gate: number;
    readonly e2e: number;
  };
  readonly timeouts: {
    readonly buildAgentMs: number;
    readonly otherAgentMs: number;
    readonly gateMs: number;
    readonly gracefulShutdownMs: number;
  };
  readonly context: {
    readonly maxFiles: number;
    readonly maxTokens: number;
  };
  readonly agents: {
    readonly maxPromptTokens: number;
  };
  readonly gates: {
    readonly visualDiffThreshold: number;
    readonly visualDiffBlock: boolean;
    readonly minAcceptanceCriteria: number;
  };
  readonly retention: {
    readonly keepRunLogsForDays: number;
    readonly keepRunFolderForDays: number;
  };
  readonly analytics: {
    readonly rotationStrategy: 'monthly';
  };
  readonly coreLibraries: readonly CoreLibraryEntry[];
  readonly requirements: {
    readonly minNodeVersion: string;
    readonly minClaudeCodeVersion: string;
  };
  /**
   * Git publishing behaviour for the git phase. Both default false so
   * `harness run` never pushes or opens a PR silently. `harness ship`
   * enables both internally before invoking the pipeline.
   */
  readonly git: {
    readonly push: boolean;
    readonly createPR: boolean;
  };
  /**
   * Global on/off switches for optional phases. When a flag is false the
   * phase is skipped regardless of capabilities.
   */
  readonly phases: {
    readonly e2e: boolean;
  };
}

// ---------------------------------------------------------------------------
// Paths
//
// Every absolute path the harness needs is resolved once at startup by
// lib/paths.ts and handed to the rest of the system as HarnessPaths.
// No other module constructs paths.
// ---------------------------------------------------------------------------

export interface HarnessPaths {
  readonly repoRoot: string;
  readonly harnessRoot: string;
  readonly packageRoot: string;
  readonly packageDefaultsDir: string;

  readonly configFile: string;
  readonly configLocalFile: string;
  readonly packageConfigFile: string;
  readonly configSchemaFile: string;

  readonly claudeRoot: string;
  readonly claudeMdFile: string;

  readonly packageAgentsDir: string;
  readonly packageContextDir: string;
  readonly packageStandardsDir: string;
  readonly packageSkillsDir: string;

  readonly briefsDir: string;
  readonly tasksDir: string;
  readonly analyticsDir: string;

  readonly srcDir: string;
  readonly playwrightConfig: string;
}

export interface TaskPaths {
  readonly ref: TaskRef;
  readonly taskFile: string;
  readonly workspaceDir: string;
  readonly e2eDir: string;
  readonly runsDir: string;
  readonly dependencyGraphFile: string;
  readonly currentRunSymlink: string;
  readonly lockFile: string;
}

export interface RunPaths {
  readonly runId: string;
  readonly runDir: string;
  readonly stateFile: string;
  readonly runMetaFile: string;
  readonly eventsFile: string;
  readonly logFile: string;
  readonly escalationFile: string;
  readonly interruptedFile: string;
  readonly snapshotsDir: string;
  readonly promptsDir: string;
  readonly outputsDir: string;
  readonly reportsDir: string;
}

// ---------------------------------------------------------------------------
// Phase model
// ---------------------------------------------------------------------------

export const PHASE_IDS = [
  'preflight',
  'design',
  'spec',
  'context',
  'build',
  'reconcile',
  'hardGates',
  'qa',
  'e2e',
  'softGates',
  'prAssembly',
  'git',
] as const;
export type PhaseId = (typeof PHASE_IDS)[number];

export type PhaseStatus = 'complete' | 'skipped' | 'escalate';

export interface EscalationDetail {
  readonly phase: PhaseId;
  readonly reason: string;
  readonly details: string;
  readonly humanAction?: string;
}

export interface PhaseResult<O = PhaseOutputs[PhaseId]> {
  readonly status: PhaseStatus;
  readonly durationMs: number;
  readonly attempts: number;
  readonly outputs: O;
  readonly escalation?: EscalationDetail;
}

export interface Phase<Id extends PhaseId = PhaseId> {
  readonly name: Id;
  shouldRun(ctx: RunContext): boolean;
  run(ctx: RunContext): Promise<PhaseResult<PhaseOutputs[Id]>>;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface TaskCapabilities {
  readonly hasUI: boolean;
  readonly hasTests: boolean;
  readonly hasStories: boolean;
  readonly hasDesign: boolean;
  readonly isE2ETask: boolean;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const MANIFEST_ACTIONS = ['create', 'modify', 'no-touch'] as const;
export type ManifestAction = (typeof MANIFEST_ACTIONS)[number];

export const MANIFEST_KINDS = ['impl', 'test', 'story'] as const;
export type ManifestKind = (typeof MANIFEST_KINDS)[number];

export interface ManifestEntry {
  readonly path: string;
  readonly action: ManifestAction;
  readonly kind: ManifestKind;
  readonly read?: boolean;
}

export interface ParsedManifest {
  readonly entries: readonly ManifestEntry[];
}

export interface NoTouchViolation {
  readonly path: string;
  readonly kind: 'logic' | 'read';
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Gate results
// ---------------------------------------------------------------------------

export interface GateResult {
  readonly passed: boolean;
  readonly failingFiles: readonly string[];
  readonly errors: readonly string[];
  readonly durationMs: number;
}

export interface VisualDiffEntry {
  readonly story: string;
  readonly delta: number;
  readonly baselinePath: string;
  readonly actualPath: string;
  readonly diffPath: string | null;
}

export interface VisualDiffResult {
  readonly passed: boolean;
  readonly firstRun: boolean;
  readonly entries: readonly VisualDiffEntry[];
  readonly threshold: number;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// QA outputs
// ---------------------------------------------------------------------------

export interface TestidAddition {
  readonly file: string;
  readonly ids: readonly string[];
}

// ---------------------------------------------------------------------------
// Soft-gate outputs
// ---------------------------------------------------------------------------

export type Severity = 'high' | 'medium' | 'low';
export type SoftGateStatus = 'PASS' | 'WARN';

export interface SoftGateFinding {
  readonly severity: Severity;
  readonly file: string;
  readonly message: string;
  readonly line?: number;
}

export interface SoftGateReport {
  readonly status: SoftGateStatus;
  readonly findings: readonly SoftGateFinding[];
}

// ---------------------------------------------------------------------------
// Reconciliation outputs
// ---------------------------------------------------------------------------

export const RECONCILE_STATUSES = ['CLEAN', 'NOTE', 'FIX', 'ESCALATE'] as const;
export type ReconcileStatus = (typeof RECONCILE_STATUSES)[number];

export interface ReconcileIssue {
  readonly kind: 'ambiguity' | 'contradiction';
  readonly specClause: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Typed phase outputs
//
// Every phase returns a strongly-typed output object; PhaseOutputs maps
// each PhaseId to its output shape. Never use Record<string, unknown>.
// ---------------------------------------------------------------------------

export interface PreflightOutputs {
  readonly branch: string;
  readonly freshRun: boolean;
}

export interface DesignOutputs {
  readonly designSpecPath: string;
}

export interface SpecOutputs {
  readonly capabilities: TaskCapabilities;
  readonly manifestEntries: readonly ManifestEntry[];
  readonly specPath: string;
  readonly manifestPath: string;
}

export interface ContextOutputs {
  readonly contextPath: string;
  readonly filesIncluded: readonly string[];
  readonly filesDropped: readonly { readonly path: string; readonly sizeBytes: number }[];
}

export interface BuildOutputs {
  readonly filesWritten: readonly string[];
  readonly noTouchViolations: readonly NoTouchViolation[];
  readonly correctionAttempts: number;
}

export interface ReconcileOutputs {
  readonly status: ReconcileStatus;
  readonly fixAttempts: number;
  readonly issues: readonly ReconcileIssue[];
}

export interface HardGateOutputs {
  readonly tsc: GateResult;
  readonly eslint: GateResult;
  readonly vitest: GateResult | null;
  readonly storybook: GateResult | null;
  readonly visualDiff: VisualDiffResult | null;
  readonly correctionAttempts: number;
}

export interface QAOutputs {
  readonly testsWritten: readonly string[];
  readonly testidAdditions: readonly TestidAddition[];
}

export interface E2EOutputs {
  readonly passed: boolean;
  readonly flaky: boolean;
  readonly correctionAttempts: number;
}

export interface SoftGateOutputs {
  readonly standards: SoftGateReport | null;
  readonly accessibility: SoftGateReport | null;
  readonly performance: SoftGateReport | null;
  readonly security: SoftGateReport | null;
}

export interface PRAssemblyOutputs {
  readonly commitMessagePath: string;
  readonly prDescriptionPath: string;
}

export interface GitOutputs {
  readonly branch: string;
  readonly commitShas: readonly string[];
  readonly stagedFileCount: number;
  /** True when `config.git.push` was true and the push succeeded. */
  readonly pushed: boolean;
  /** PR URL when `config.git.createPR` was true and `gh pr create` succeeded. */
  readonly prUrl: string | null;
}

export interface PhaseOutputs {
  readonly preflight: PreflightOutputs;
  readonly design: DesignOutputs;
  readonly spec: SpecOutputs;
  readonly context: ContextOutputs;
  readonly build: BuildOutputs;
  readonly reconcile: ReconcileOutputs;
  readonly hardGates: HardGateOutputs;
  readonly qa: QAOutputs;
  readonly e2e: E2EOutputs;
  readonly softGates: SoftGateOutputs;
  readonly prAssembly: PRAssemblyOutputs;
  readonly git: GitOutputs;
}

// ---------------------------------------------------------------------------
// Run state (state.json)
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'running'
  | 'complete'
  | 'escalated'
  | 'interrupted'
  | 'failed'
  /**
   * The human explicitly asked `harness ship ... --skip <task>` for this
   * task. Treated as `complete` for dependency resolution but rendered
   * distinctly in summaries and PR description.
   */
  | 'skipped-by-human';

export interface RunState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly status: RunStatus;
  readonly currentPhase: PhaseId | null;
  readonly completedPhases: readonly PhaseId[];
  readonly skippedPhases: readonly PhaseId[];
  readonly startedAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Run metadata (run.json)
// ---------------------------------------------------------------------------

export interface RunFlags {
  readonly resume: boolean;
  readonly patchParent: TaskRef | null;
  readonly nonInteractive: boolean;
  readonly stopAfter?: PhaseId;
  readonly resumeFrom?: PhaseId;
  readonly dryRun?: boolean;
}

export interface RunMetadata {
  readonly schemaVersion: typeof RUN_SCHEMA_VERSION;
  readonly runId: string;
  readonly project: string;
  readonly task: string;
  readonly branch: string;
  readonly startedAt: string;
  readonly flags: RunFlags;
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

export interface LockFile {
  readonly pid: number;
  readonly runId: string;
  readonly startedAt: string;
}

// ---------------------------------------------------------------------------
// Logger contract
//
// Dual-stream: every call writes to terminal AND to events.jsonl.
// The implementation lives in lib/logger.ts; the contract lives here.
// ---------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export const EVENT_TYPES = [
  'phase_start',
  'phase_end',
  'agent_call',
  'gate',
  'correction_attempt',
  'escalation',
  'interruption',
  'capability_inferred',
  'manifest_validated',
  'token_cap_applied',
  'snapshot_taken',
  'lock_acquired',
  'lock_released',
  'info',
  'warn',
  'error',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface LogEventBase {
  readonly schemaVersion: typeof EVENT_SCHEMA_VERSION;
  readonly ts: string;
  readonly runId: string;
  readonly project: string;
  readonly task: string;
  readonly type: EventType;
  readonly message?: string;
}

export type LogEvent = LogEventBase & Record<string, unknown>;

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  success(message: string, extra?: Record<string, unknown>): void;
  event(type: EventType, fields: Record<string, unknown>): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// RunContext — the one object that flows through every phase.
// Phases read capabilities, paths, config, and accumulated outputs from here.
// Mutation is scoped: runner.ts writes outputs after each phase completes.
// ---------------------------------------------------------------------------

export interface RunContext {
  readonly config: HarnessConfig;
  readonly paths: HarnessPaths;
  readonly taskPaths: TaskPaths;
  readonly runPaths: RunPaths;
  readonly logger: Logger;
  readonly task: TaskRef;
  readonly branch: string;
  readonly taskFrontmatter: TaskFrontmatter;
  capabilities: TaskCapabilities | null;
  readonly outputs: Partial<PhaseOutputs>;
  readonly flags: RunFlags;
  shuttingDown(): boolean;
}

// ---------------------------------------------------------------------------
// Error classes
//
// Every expected failure mode has its own class. No `new Error("string")`
// in production code. Catch blocks narrow via instanceof and never guess.
// ---------------------------------------------------------------------------

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EscalationError extends HarnessError {
  readonly phase: PhaseId;
  readonly reason: string;
  readonly details: string;
  readonly humanAction: string | undefined;

  constructor(detail: EscalationDetail) {
    super(`[${detail.phase}] ${detail.reason}`);
    this.phase = detail.phase;
    this.reason = detail.reason;
    this.details = detail.details;
    this.humanAction = detail.humanAction;
  }
}

export class RetryExhaustedError extends HarnessError {
  readonly phase: PhaseId;
  readonly attempts: number;
  readonly lastError: string;

  constructor(phase: PhaseId, attempts: number, lastError: string) {
    super(`Retry exhausted in phase ${phase} after ${attempts} attempts`);
    this.phase = phase;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export class ManifestValidationError extends HarnessError {
  readonly layer: 1 | 2 | 3;
  readonly violations: readonly string[];

  constructor(layer: 1 | 2 | 3, violations: readonly string[]) {
    super(`Manifest validation failed at layer ${layer}: ${violations.join('; ')}`);
    this.layer = layer;
    this.violations = violations;
  }
}

export class ConfigValidationError extends HarnessError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`Config validation failed at ${field}: ${message}`);
    this.field = field;
  }
}

export class LockError extends HarnessError {
  readonly existingPid: number;
  readonly existingRunId: string;

  constructor(existingPid: number, existingRunId: string) {
    super(`Lock held by pid ${existingPid} (run ${existingRunId})`);
    this.existingPid = existingPid;
    this.existingRunId = existingRunId;
  }
}

export class SchemaVersionError extends HarnessError {
  readonly file: string;
  readonly expected: number;
  readonly found: number;

  constructor(file: string, expected: number, found: number) {
    super(`Schema version mismatch in ${file}: expected ${expected}, found ${found}`);
    this.file = file;
    this.expected = expected;
    this.found = found;
  }
}

export class AgentTimeoutError extends HarnessError {
  readonly agent: string;
  readonly timeoutMs: number;
  readonly attempt: number;

  constructor(agent: string, timeoutMs: number, attempt: number) {
    super(`Agent ${agent} timed out after ${timeoutMs}ms (attempt ${attempt})`);
    this.agent = agent;
    this.timeoutMs = timeoutMs;
    this.attempt = attempt;
  }
}

export class AgentContractError extends HarnessError {
  readonly agent: string;
  readonly reason: string;

  constructor(agent: string, reason: string) {
    super(`Agent ${agent} violated its output contract: ${reason}`);
    this.agent = agent;
    this.reason = reason;
  }
}

export class SecretsDetectedError extends HarnessError {
  readonly files: readonly string[];
  readonly patterns: readonly string[];

  constructor(files: readonly string[], patterns: readonly string[]) {
    super(`Secrets detected in: ${files.join(', ')}`);
    this.files = files;
    this.patterns = patterns;
  }
}

export class CyclicDependencyError extends HarnessError {
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`Cyclic dependency: ${cycle.join(' -> ')}`);
    this.cycle = cycle;
  }
}

export class BranchConflictError extends HarnessError {
  readonly branch: string;
  readonly existingRunId: string;

  constructor(branch: string, existingRunId: string) {
    super(`Branch conflict: ${branch} belongs to run ${existingRunId}`);
    this.branch = branch;
    this.existingRunId = existingRunId;
  }
}

export class SignalInterruptError extends HarnessError {
  readonly signal: 'SIGINT' | 'SIGTERM';

  constructor(signal: 'SIGINT' | 'SIGTERM') {
    super(`Interrupted by ${signal}`);
    this.signal = signal;
  }
}

export class PreflightCheckError extends HarnessError {
  readonly check: string;

  constructor(check: string, message: string) {
    super(`Preflight check '${check}' failed: ${message}`);
    this.check = check;
  }
}
