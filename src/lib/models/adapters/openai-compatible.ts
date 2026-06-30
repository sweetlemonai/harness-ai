import type {
  ModelAdapter,
  ModelAdapterConfig,
  RawModelInvocationArgs,
  RawModelInvocationResult,
} from '../types.js';
import { runPrivacyPreflight } from '../../privacy/preflight.js';

export function createOpenAiCompatibleAdapter(config: ModelAdapterConfig): ModelAdapter {
  return {
    id: config.id,
    kind: 'openai-compatible',
    invoke(args: RawModelInvocationArgs): Promise<RawModelInvocationResult> {
      return invokeOpenAiCompatible(config, args);
    },
  };
}

async function invokeOpenAiCompatible(
  config: ModelAdapterConfig,
  args: RawModelInvocationArgs,
): Promise<RawModelInvocationResult> {
  const startedAt = Date.now();
  const baseUrl = resolveConfigValue(config.baseUrl, config.baseUrlEnv);
  const model = resolveConfigValue(config.model, config.modelEnv);
  if (baseUrl === null || model === null) {
    return {
      stdout: '',
      stderr: 'openai-compatible adapter requires baseUrl/baseUrlEnv and model/modelEnv',
      exitCode: -1,
      signal: null,
      durationMs: Date.now() - startedAt,
    };
  }
  if (config.privacyZone !== undefined) {
    const privacy = runPrivacyPreflight({
      config: args.ctx.config,
      text: args.prompt,
      targetZone: config.privacyZone,
    });
    if (!privacy.ok) {
      return {
        stdout: '',
        stderr: `privacy preflight blocked ${privacy.sourceZone}->${privacy.targetZone}: ${privacy.findings.map((entry) => entry.ruleId).join(', ')}`,
        exitCode: -1,
        signal: null,
        durationMs: Date.now() - startedAt,
      };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  timer.unref();
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: headersFor(config),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: args.prompt,
          },
        ],
        ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        stdout: '',
        stderr: text,
        exitCode: response.status,
        signal: null,
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      stdout: extractAssistantText(text),
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: timedOut ? -1 : 1,
      signal: timedOut ? 'SIGKILL' : null,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveConfigValue(value: string | undefined, envName: string | undefined): string | null {
  if (value !== undefined && value.length > 0) return value;
  if (envName !== undefined && envName.length > 0) {
    const envValue = process.env[envName];
    if (envValue !== undefined && envValue.length > 0) return envValue;
  }
  return null;
}

function headersFor(config: ModelAdapterConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const apiKey = resolveConfigValue(config.apiKey, config.apiKeyEnv);
  if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function extractAssistantText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{
        message?: {
          content?: unknown;
          reasoning?: unknown;
          reasoning_content?: unknown;
        };
        text?: unknown;
      }>;
    };
    const first = parsed.choices?.[0];
    const content = first?.message?.content;
    if (typeof content === 'string' && content.trim().length > 0) return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          if (part !== null && typeof part === 'object' && 'text' in part) {
            const text = (part as { text?: unknown }).text;
            return typeof text === 'string' ? text : '';
          }
          return '';
        })
        .join('');
      if (parts.trim().length > 0) return parts;
    }
    if (typeof first?.text === 'string' && first.text.trim().length > 0) return first.text;
    if (first?.message?.reasoning !== undefined || first?.message?.reasoning_content !== undefined) {
      throw new Error('openai-compatible response contained reasoning but no assistant content');
    }
    return raw;
  } catch {
    if (raw.trim().startsWith('{')) {
      throw new Error('openai-compatible response did not contain assistant content');
    }
    return raw;
  }
}
