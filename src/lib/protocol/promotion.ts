import { auditBusProjections, readBusEnvelopes, readLifecycleReceipts } from '../collaboration/localJsonlBus.js';
import type { EvidenceReceipt } from '../evidence/types.js';
import { doctorProtocol, doctorProtocolSidecars } from './doctor.js';
import { stableId } from './hash.js';
import { readLedgerEntries } from './ledger.js';
import { sidecarPathsForRunDir } from './sidecar.js';
import type { VerificationIssue } from '../../types.js';
import { stableHash } from './hash.js';
import { issue } from './verify.js';

export interface PromotionBlocker {
  readonly source: 'alpha_sidecars' | 'production_sidecars' | 'production_bus' | 'bus_projections' | 'agentops_panel';
  readonly severity: VerificationIssue['severity'];
  readonly code: string;
  readonly message: string;
  readonly subjectId?: string;
  readonly line?: number;
}

export interface ProductionPromotionDecision {
  readonly schemaVersion: 'superharness.production_promotion.v2';
  readonly decisionId: string;
  readonly runDir: string;
  readonly checkedAt: string;
  readonly fromContext: 'alpha';
  readonly targetContext: 'production';
  readonly allowed: boolean;
  readonly guard: {
    readonly profile: 'production';
    readonly enforcedBy: 'production_promotion_guard';
    readonly callerProfileOverrideAllowed: false;
  };
  readonly counts: {
    readonly blockers: number;
    readonly warnings: number;
    readonly alphaSidecarIssues: number;
    readonly productionSidecarIssues: number;
    readonly productionBusIssues: number;
    readonly busProjectionIssues: number;
    readonly agentopsPanelIssues: number;
  };
  readonly checks: {
    readonly alphaSidecarsOk: boolean;
    readonly productionSidecarsOk: boolean;
    readonly productionBusOk: boolean;
    readonly busProjectionsOk: boolean;
    readonly agentopsPanelOk: boolean;
  };
  readonly blockers: readonly PromotionBlocker[];
  readonly warnings: readonly PromotionBlocker[];
}

export function evaluateProductionPromotion(args: {
  readonly runDir: string;
  readonly checkedAt?: string;
}): ProductionPromotionDecision {
  const files = sidecarPathsForRunDir(args.runDir);
  const checkedAt = args.checkedAt ?? new Date().toISOString();
  const alphaSidecars = doctorProtocolSidecars({
    runDir: files.runDir,
    auditMode: 'full',
    profile: 'alpha',
  });
  const productionSidecars = doctorProtocolSidecars({
    runDir: files.runDir,
    auditMode: 'full',
    profile: 'production',
  });
  const productionBus = doctorProtocol({
    messages: readBusEnvelopes(files.runDir),
    receipts: readLifecycleReceipts(files.runDir),
    profile: 'production',
  });
  const busProjections = auditBusProjections(files.runDir);
  const agentopsPanelIssues = detectOperationalBlockers(files.evidenceFile);
  const allIssues = [
    ...classifyIssues('alpha_sidecars', alphaSidecars.report.issues),
    ...classifyIssues('production_sidecars', productionSidecars.report.issues),
    ...classifyIssues('production_bus', productionBus.issues),
    ...classifyIssues('bus_projections', busProjections.issues),
    ...classifyIssues('agentops_panel', agentopsPanelIssues),
  ];
  const blockers = allIssues.filter((entry) => entry.severity === 'error');
  const warnings = allIssues.filter((entry) => !blockers.includes(entry));
  const allowed = alphaSidecars.ok
    && productionSidecars.ok
    && productionBus.ok
    && busProjections.ok
    && agentopsPanelIssues.every((entry) => entry.severity !== 'error')
    && blockers.length === 0;
  return {
    schemaVersion: 'superharness.production_promotion.v2',
    decisionId: stableId('promotion', {
      runDir: files.runDir,
      checkedAt,
      targetContext: 'production',
      blockers: blockers.map((entry) => ({
        source: entry.source,
        severity: entry.severity,
        code: entry.code,
        subjectId: entry.subjectId ?? null,
        line: entry.line ?? null,
      })),
    }),
    runDir: files.runDir,
    checkedAt,
    fromContext: 'alpha',
    targetContext: 'production',
    allowed,
    guard: {
      profile: 'production',
      enforcedBy: 'production_promotion_guard',
      callerProfileOverrideAllowed: false,
    },
    counts: {
      blockers: blockers.length,
      warnings: warnings.length,
      alphaSidecarIssues: alphaSidecars.report.issues.length,
      productionSidecarIssues: productionSidecars.report.issues.length,
      productionBusIssues: productionBus.issues.length,
      busProjectionIssues: busProjections.issues.length,
      agentopsPanelIssues: agentopsPanelIssues.length,
    },
    checks: {
      alphaSidecarsOk: alphaSidecars.ok,
      productionSidecarsOk: productionSidecars.ok,
      productionBusOk: productionBus.ok,
      busProjectionsOk: busProjections.ok,
      agentopsPanelOk: agentopsPanelIssues.every((entry) => entry.severity !== 'error'),
    },
    blockers,
    warnings,
  };
}

function detectOperationalBlockers(evidenceFile: string): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const openBlockers = new Map<string, EvidenceReceipt>();
  for (const evidence of readLedgerEntries<EvidenceReceipt>(evidenceFile)) {
    const recoveryIssue = recoveryValidationIssue(evidence);
    if (recoveryIssue !== null) issues.push(recoveryIssue);

    if (isValidRecoveryEvidence(evidence)) {
      if (!recoveryResolvesOpenBlocker(evidence, openBlockers)) {
        issues.push(issue('error', 'agentops_panel.adapter_recovery_target_mismatch', 'adapter recovery does not cite the currently open failure evidence it would clear', {
          subjectId: evidence.evidenceId,
        }));
        continue;
      }
      for (const key of recoveryTargetKeys(evidence)) {
        openBlockers.delete(key);
      }
      continue;
    }

    if (evidence.kind === 'implementation_conflict' && evidence.metadata.resolved === true) {
      const closureIssue = conflictClosureValidationIssue(evidence);
      if (closureIssue !== null) {
        issues.push(closureIssue);
        openBlockers.set(blockerKey(evidence), evidence);
      } else {
        openBlockers.delete(blockerKey(evidence));
        if (nonEmptyString(evidence.subject.supersedesSubjectId)) {
          openBlockers.delete(`subject:${evidence.subject.supersedesSubjectId}`);
        }
      }
      continue;
    }

    if (isBlockingEvidence(evidence)) {
      openBlockers.set(blockerKey(evidence), evidence);
      openBlockers.set(`evidence:${evidence.evidenceId}`, evidence);
    }
  }
  const uniqueOpenBlockers = new Map([...openBlockers.values()].map((entry) => [entry.evidenceId, entry]));
  for (const evidence of uniqueOpenBlockers.values()) {
    if (evidence.kind === 'adapter_failure') {
      issues.push(issue('error', 'agentops_panel.adapter_failure_open', 'production promotion is blocked by recorded adapter failure evidence without a later verified recovery', {
        subjectId: evidence.evidenceId,
      }));
    } else if (evidence.kind === 'implementation_conflict') {
      issues.push(issue('error', 'agentops_panel.implementation_conflict_open', 'production promotion is blocked by unresolved implementation conflict evidence', {
        subjectId: evidence.evidenceId,
      }));
    } else {
      issues.push(issue('error', 'agentops_panel.blocking_evidence_open', 'production promotion is blocked by unresolved blocking evidence', {
        subjectId: evidence.evidenceId,
      }));
    }
  }
  return issues;
}

function isBlockingEvidence(evidence: EvidenceReceipt): boolean {
  if (evidence.kind === 'adapter_failure') return evidence.metadata.resolved !== true;
  if (evidence.kind === 'implementation_conflict') {
    return evidence.metadata.resolved !== true
      || evidence.metadata.blocking === true
      || evidence.subject.blocking === true;
  }
  return evidence.subject.blocking === true || evidence.metadata.blocking === true;
}

function isValidRecoveryEvidence(evidence: EvidenceReceipt): boolean {
  if (evidence.kind !== 'adapter_recovery') return false;
  return evidence.metadata.recovered === true
    && evidence.metadata.blocking !== true
    && evidence.metadata.independentVerificationSatisfied === true
    && evidence.metadata.identityBindingStatus === 'cryptographically_verified'
    && stringArray(evidence.metadata.recoveryEvidenceRefs).length > 0
    && stringArray(evidence.metadata.verificationEvidenceRefs).length > 0
    && stringArray(evidence.metadata.identityBindingRefs).length > 0
    && stringArray(evidence.metadata.resolvesEvidenceIds).length > 0
    && nonEmptyString(evidence.metadata.adapterInstanceId)
    && nonEmptyString(evidence.metadata.adapterVersion)
    && nonEmptyString(evidence.metadata.verifierTrustAnchorRef)
    && nonEmptyString(evidence.metadata.identityVerifierTrustAnchorRef)
    && stringArray(evidence.metadata.verifierAttestationRefs).length > 0
    && stringArray(evidence.metadata.identityVerifierAttestationRefs).length > 0
    && evidence.metadata.transactionStatus === 'committed'
    && nonEmptyString(evidence.metadata.transactionId)
    && nonEmptyString(evidence.metadata.bindingPayloadHash)
    && bindingPayloadHashMatches(evidence)
    && timestampOrderValid(evidence.metadata.transactionPreparedAt, evidence.metadata.transactionCommittedAt)
    && distinctAgents(evidence.metadata.recoveredBy, evidence.metadata.verifierAgentId)
    && distinctAgents(evidence.metadata.recoveredBy, evidence.metadata.identityVerifierAgentId)
    && distinctAgents(evidence.metadata.verifierAgentId, evidence.metadata.identityVerifierAgentId)
    && recoveryTargetKeys(evidence).length > 0;
}

function recoveryResolvesOpenBlocker(
  evidence: EvidenceReceipt,
  openBlockers: ReadonlyMap<string, EvidenceReceipt>,
): boolean {
  const resolvedEvidenceIds = new Set(stringArray(evidence.metadata.resolvesEvidenceIds));
  if (resolvedEvidenceIds.size === 0) return false;
  for (const key of recoveryTargetKeys(evidence)) {
    const blocker = openBlockers.get(key);
    if (blocker !== undefined && resolvedEvidenceIds.has(blocker.evidenceId)) {
      return true;
    }
  }
  return false;
}

function recoveryValidationIssue(evidence: EvidenceReceipt): VerificationIssue | null {
  if (evidence.kind !== 'adapter_recovery') return null;
  if (isValidRecoveryEvidence(evidence)) return null;
  return issue('error', 'agentops_panel.adapter_recovery_invalid', 'adapter recovery evidence cannot clear a blocker without target failure evidence, adapter instance/version, committed verify-bind transaction, verification refs, trust-anchored verifier identities, distinct verifiers, cryptographic identity binding, and a target', {
    subjectId: evidence.evidenceId,
  });
}

function conflictClosureValidationIssue(evidence: EvidenceReceipt): VerificationIssue | null {
  if (evidence.kind !== 'implementation_conflict' || evidence.metadata.resolved !== true) return null;
  const cryptographicallyBound = evidence.metadata.identityBindingStatus === 'cryptographically_verified'
    || evidence.subject.identityBindingStatus === 'cryptographically_verified';
  if (
    evidence.metadata.independentVerificationSatisfied === true
    && evidence.subject.verificationStatus === 'independently_verified'
    && cryptographicallyBound
    && stringArray(evidence.metadata.verificationEvidenceRefs).length > 0
    && stringArray(evidence.metadata.identityBindingRefs).length > 0
    && nonEmptyString(evidence.metadata.verifierTrustAnchorRef)
    && nonEmptyString(evidence.metadata.identityVerifierTrustAnchorRef)
    && stringArray(evidence.metadata.verifierAttestationRefs).length > 0
    && stringArray(evidence.metadata.identityVerifierAttestationRefs).length > 0
    && evidence.metadata.transactionStatus === 'committed'
    && nonEmptyString(evidence.metadata.transactionId)
    && nonEmptyString(evidence.metadata.bindingPayloadHash)
    && distinctAgents(evidence.metadata.implementerAgentId, evidence.metadata.verifierAgentId)
    && distinctAgents(evidence.metadata.implementerAgentId, evidence.metadata.identityVerifierAgentId)
    && distinctAgents(evidence.metadata.verifierAgentId, evidence.metadata.identityVerifierAgentId)
  ) {
    return null;
  }
  return issue('error', 'agentops_panel.implementation_conflict_resolution_invalid', 'implementation conflict closure lacks independent verification evidence, committed verify-bind transaction, trust-anchored verifier identity refs, distinct verifiers, or cryptographic verifier identity binding', {
    subjectId: evidence.evidenceId,
  });
}

function blockerKey(evidence: EvidenceReceipt): string {
  if (evidence.kind === 'adapter_failure' || evidence.kind === 'adapter_recovery') {
    return adapterBlockerKey(evidence);
  }
  if (evidence.kind === 'implementation_conflict' && nonEmptyString(evidence.metadata.conflictId)) {
    return `conflict:${evidence.metadata.conflictId}`;
  }
  return `subject:${evidence.subject.subjectId}`;
}

function adapterBlockerKey(evidence: EvidenceReceipt): string {
  return [
    'adapter',
    stringValue(evidence.metadata.adapterId) ?? evidence.subject.subjectId,
    stringValue(evidence.metadata.providerId) ?? '',
    stringValue(evidence.metadata.modelId) ?? '',
  ].join(':');
}

function recoveryTargetKeys(evidence: EvidenceReceipt): readonly string[] {
  const keys = new Set<string>();
  keys.add(adapterBlockerKey(evidence));
  for (const subjectId of stringArray(evidence.metadata.resolvesSubjectIds)) {
    keys.add(`subject:${subjectId}`);
  }
  for (const evidenceId of stringArray(evidence.metadata.resolvesEvidenceIds)) {
    keys.add(`evidence:${evidenceId}`);
  }
  if (nonEmptyString(evidence.subject.supersedesSubjectId)) {
    keys.add(`subject:${evidence.subject.supersedesSubjectId}`);
  }
  return [...keys];
}

function bindingPayloadHashMatches(evidence: EvidenceReceipt): boolean {
  const expected = stableHash({
    schemaVersion: 'superharness.adapter_recovery_binding.v2',
    adapterId: stringValue(evidence.metadata.adapterId) ?? '',
    providerId: stringValue(evidence.metadata.providerId) ?? '',
    modelId: stringValue(evidence.metadata.modelId) ?? null,
    adapterInstanceId: stringValue(evidence.metadata.adapterInstanceId) ?? '',
    adapterVersion: stringValue(evidence.metadata.adapterVersion) ?? '',
    recoveredBy: stringValue(evidence.metadata.recoveredBy) ?? '',
    verifierAgentId: stringValue(evidence.metadata.verifierAgentId) ?? '',
    identityVerifierAgentId: stringValue(evidence.metadata.identityVerifierAgentId) ?? '',
    verifierTrustAnchorRef: stringValue(evidence.metadata.verifierTrustAnchorRef) ?? '',
    identityVerifierTrustAnchorRef: stringValue(evidence.metadata.identityVerifierTrustAnchorRef) ?? '',
    recoveryEvidenceRefs: stringArray(evidence.metadata.recoveryEvidenceRefs),
    verificationEvidenceRefs: stringArray(evidence.metadata.verificationEvidenceRefs),
    identityBindingRefs: stringArray(evidence.metadata.identityBindingRefs),
    resolvesEvidenceIds: stringArray(evidence.metadata.resolvesEvidenceIds),
    resolvesSubjectIds: stringArray(evidence.metadata.resolvesSubjectIds),
  });
  return evidence.metadata.bindingPayloadHash === expected;
}

function timestampOrderValid(preparedAt: unknown, committedAt: unknown): boolean {
  if (!validIsoTimestamp(preparedAt) || !validIsoTimestamp(committedAt)) return false;
  return Date.parse(committedAt) >= Date.parse(preparedAt);
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !Number.isNaN(Date.parse(value));
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => nonEmptyString(entry))
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function distinctAgents(left: unknown, right: unknown): boolean {
  const leftValue = stringValue(left);
  const rightValue = stringValue(right);
  return leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue;
}

function classifyIssues(
  source: PromotionBlocker['source'],
  issues: readonly VerificationIssue[],
): readonly PromotionBlocker[] {
  return issues.map((entry) => ({
    source,
    severity: entry.severity,
    code: entry.code,
    message: entry.message,
    ...(entry.subjectId !== undefined ? { subjectId: entry.subjectId } : {}),
    ...(entry.line !== undefined ? { line: entry.line } : {}),
  }));
}
