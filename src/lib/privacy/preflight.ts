import { readFileSync } from 'node:fs';
import type { HarnessConfig } from '../../types.js';
import { stableId } from '../protocol/hash.js';
import type { PrivacyZone } from '../protocol/types.js';

export interface PrivacyPreflightFinding {
  readonly findingId: string;
  readonly severity: 'block' | 'warn';
  readonly ruleId: string;
  readonly summary: string;
  readonly evidence: string;
}

export interface PrivacyPreflightResult {
  readonly ok: boolean;
  readonly sourceZone: PrivacyZone;
  readonly targetZone: PrivacyZone;
  readonly findings: readonly PrivacyPreflightFinding[];
}

export function runPrivacyPreflight(args: {
  readonly config: HarnessConfig;
  readonly text: string;
  readonly sourceZone?: PrivacyZone | undefined;
  readonly targetZone: PrivacyZone;
}): PrivacyPreflightResult {
  const sourceZone = args.sourceZone ?? args.config.privacy.defaultZone;
  const findings: PrivacyPreflightFinding[] = [];
  const hostedTarget = isHostedZone(args.targetZone);

  if (
    hostedTarget &&
    args.config.privacy.preflight.blockHostedMissionGist &&
    containsMissionGist(args.text)
  ) {
    findings.push(finding({
      severity: 'block',
      ruleId: 'hosted_mission_gist',
      summary: 'mission gist appears unsafe for hosted routing',
      evidence: firstMatchingLine(args.text, MISSION_GIST_RE),
    }));
  }

  if (
    hostedTarget &&
    args.config.privacy.preflight.blockHiddenReasoning &&
    containsHiddenReasoning(args.text)
  ) {
    findings.push(finding({
      severity: 'block',
      ruleId: 'hidden_reasoning',
      summary: 'hidden reasoning or internal chain-of-thought appears in payload',
      evidence: firstMatchingLine(args.text, HIDDEN_REASONING_RE),
    }));
  }

  if (containsLikelySecret(args.text)) {
    findings.push(finding({
      severity: 'block',
      ruleId: 'secret_like_payload',
      summary: 'payload contains a secret-like token or private key marker',
      evidence: firstMatchingLine(args.text, SECRET_RE),
    }));
  }

  if (sourceZone === 'LOCAL_ONLY' && hostedTarget) {
    findings.push(finding({
      severity: 'block',
      ruleId: 'local_only_to_hosted',
      summary: 'LOCAL_ONLY source cannot be routed to hosted target',
      evidence: `${sourceZone}->${args.targetZone}`,
    }));
  }

  return {
    ok: findings.every((entry) => entry.severity !== 'block'),
    sourceZone,
    targetZone: args.targetZone,
    findings,
  };
}

export function readPrivacyPreflightText(args: {
  readonly text?: string | undefined;
  readonly file?: string | undefined;
}): string {
  if (args.text !== undefined) return args.text;
  if (args.file !== undefined) return readFileSync(args.file, 'utf8');
  return '';
}

function finding(args: {
  readonly severity: PrivacyPreflightFinding['severity'];
  readonly ruleId: string;
  readonly summary: string;
  readonly evidence: string;
}): PrivacyPreflightFinding {
  return {
    findingId: stableId('privacy_finding', args),
    severity: args.severity,
    ruleId: args.ruleId,
    summary: args.summary,
    evidence: redact(args.evidence),
  };
}

function isHostedZone(zone: PrivacyZone): boolean {
  return zone === 'HOSTED_REGIONAL' || zone === 'ZDR_FRONTIER' || zone === 'BLIND_SUBTASK';
}

const MISSION_GIST_RE =
  /\b(mission gist|soul\.md|internal protocol|system prompt|operator instruction|private strategy)\b/i;
const HIDDEN_REASONING_RE =
  /\b(chain[- ]of[- ]thought|hidden reasoning|private reasoning|scratchpad|internal deliberation)\b/i;
const SECRET_RE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}|ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|api[_-]?key\s*[:=]\s*\S+)/i;

function containsMissionGist(text: string): boolean {
  return MISSION_GIST_RE.test(text);
}

function containsHiddenReasoning(text: string): boolean {
  return HIDDEN_REASONING_RE.test(text);
}

function containsLikelySecret(text: string): boolean {
  return SECRET_RE.test(text);
}

function firstMatchingLine(text: string, pattern: RegExp): string {
  for (const line of text.split(/\r?\n/)) {
    if (pattern.test(line)) return line.trim();
  }
  return '';
}

function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 300);
}
