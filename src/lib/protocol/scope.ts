import {
  PRIVACY_ZONES,
  type PrivacyZone,
  type ScopeRef,
  type VerificationIssue,
  type Visibility,
} from '../../types.js';
import { stableId } from './hash.js';
import { issue } from './verify.js';

const DEFAULT_PRIVACY_ZONE: PrivacyZone = 'WORKSPACE';
const DEFAULT_VISIBILITY: Visibility = 'internal';

export function createScopeRef(args: {
  readonly runId: string;
  readonly workspaceId: string;
  readonly tenantId?: string;
  readonly tenantMode?: boolean;
  readonly privacyZone?: PrivacyZone;
  readonly visibility?: Visibility;
}): ScopeRef {
  const tenantMode = args.tenantMode ?? args.tenantId !== undefined;
  const privacyZone = args.privacyZone ?? DEFAULT_PRIVACY_ZONE;
  const visibility = args.visibility ?? DEFAULT_VISIBILITY;
  const scopeBase = {
    runId: args.runId,
    workspaceId: args.workspaceId,
    tenantId: args.tenantId ?? null,
    tenantMode,
    privacyZone,
    visibility,
  };
  return {
    scopeId: stableId('scope', scopeBase),
    runId: args.runId,
    workspaceId: args.workspaceId,
    ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
    tenantMode,
    privacyZone,
    visibility,
  };
}

export function validateScopeRef(scope: ScopeRef): readonly VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  if (scope.runId.trim() === '') {
    issues.push(issue('error', 'scope.run_id_missing', 'scope.runId must be non-empty', {
      subjectId: scope.scopeId,
    }));
  }
  if (scope.workspaceId.trim() === '') {
    issues.push(issue('error', 'scope.workspace_id_missing', 'scope.workspaceId must be non-empty', {
      subjectId: scope.scopeId,
    }));
  }
  if (scope.tenantMode && scope.tenantId === undefined) {
    issues.push(issue('error', 'scope.tenant_id_missing', 'tenantMode scopes require tenantId', {
      subjectId: scope.scopeId,
    }));
  }
  if (!PRIVACY_ZONES.includes(scope.privacyZone)) {
    issues.push(issue('error', 'scope.privacy_zone_invalid', 'scope privacyZone is not recognized', {
      subjectId: scope.scopeId,
    }));
  }
  const expected = createScopeRef({
    runId: scope.runId,
    workspaceId: scope.workspaceId,
    ...(scope.tenantId !== undefined ? { tenantId: scope.tenantId } : {}),
    tenantMode: scope.tenantMode,
    privacyZone: scope.privacyZone,
    visibility: scope.visibility,
  }).scopeId;
  if (scope.scopeId !== expected) {
    issues.push(issue('error', 'scope.id_mismatch', 'scopeId does not match canonical scope fields', {
      subjectId: scope.scopeId,
    }));
  }
  return issues;
}

export function assertScopeRef(scope: ScopeRef): void {
  const issues = validateScopeRef(scope);
  if (issues.length > 0) {
    throw new Error(issues.map((entry) => entry.message).join('; '));
  }
}
