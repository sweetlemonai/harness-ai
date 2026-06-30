import { AgentContractError } from '../../types.js';

const FENCED_JSON_RE = /```json\s*\r?\n([\s\S]*?)\r?\n```/g;

export function extractLastFencedJson(stdout: string): unknown {
  let lastBody: string | null = null;
  let match: RegExpExecArray | null;
  FENCED_JSON_RE.lastIndex = 0;
  while ((match = FENCED_JSON_RE.exec(stdout)) !== null) {
    lastBody = match[1] ?? null;
  }
  if (lastBody === null) {
    throw new AgentContractError(
      'unknown',
      'no ```json ...``` block found in stdout',
    );
  }
  try {
    return JSON.parse(lastBody);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AgentContractError(
      'unknown',
      `last \`\`\`json block failed to parse: ${reason}`,
    );
  }
}

export function extractPromptTokenCount(contract: unknown): number | null {
  if (contract === null || typeof contract !== 'object') return null;
  const c = contract as Record<string, unknown>;
  const t =
    c.promptTokensActual ??
    c.inputTokens ??
    c.tokensIn ??
    null;
  return typeof t === 'number' ? t : null;
}

export function extractCompletionTokenCount(contract: unknown): number | null {
  if (contract === null || typeof contract !== 'object') return null;
  const c = contract as Record<string, unknown>;
  const t =
    c.completionTokens ??
    c.outputTokens ??
    c.tokensOut ??
    null;
  return typeof t === 'number' ? t : null;
}
