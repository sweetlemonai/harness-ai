import type { VerificationIssue, VerificationReport } from '../../types.js';

export function createVerificationReport(args: {
  readonly subject: string;
  readonly issues?: readonly VerificationIssue[];
  readonly headHash?: string | undefined;
  readonly checkedAt?: string | undefined;
}): VerificationReport {
  const issues = args.issues ?? [];
  return {
    ok: issues.every((issue) => issue.severity !== 'error'),
    subject: args.subject,
    checkedAt: args.checkedAt ?? new Date().toISOString(),
    ...(args.headHash !== undefined ? { headHash: args.headHash } : {}),
    issueCount: issues.length,
    issues,
  };
}

export function issue(
  severity: VerificationIssue['severity'],
  code: string,
  message: string,
  extras: { readonly subjectId?: string | undefined; readonly line?: number | undefined } = {},
): VerificationIssue {
  return {
    severity,
    code,
    message,
    ...(extras.subjectId !== undefined ? { subjectId: extras.subjectId } : {}),
    ...(extras.line !== undefined ? { line: extras.line } : {}),
  };
}
