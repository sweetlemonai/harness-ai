import type {
  ModelAdapter,
  ModelAdapterConfig,
  RawModelInvocationArgs,
  RawModelInvocationResult,
} from '../types.js';

type FakeLocalMode = 'success' | 'timeout' | 'malformed-json' | 'refusal';

export function createFakeLocalAdapter(config: ModelAdapterConfig): ModelAdapter {
  return {
    id: config.id,
    kind: 'fake-local',
    invoke(args: RawModelInvocationArgs): Promise<RawModelInvocationResult> {
      return invokeFakeLocal(config, args);
    },
  };
}

async function invokeFakeLocal(
  config: ModelAdapterConfig,
  args: RawModelInvocationArgs,
): Promise<RawModelInvocationResult> {
  const startedAt = Date.now();
  const mode = fakeLocalMode(config);

  if (mode === 'timeout') {
    await delay(args.timeoutMs);
    return {
      stdout: '',
      stderr: 'fake-local-v1 timed out',
      exitCode: null,
      signal: 'SIGKILL',
      durationMs: Date.now() - startedAt,
      timedOut: true,
    };
  }

  if (mode === 'malformed-json') {
    return {
      stdout: 'fake-local-v1 malformed response\n```json\n{not-json\n```',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - startedAt,
    };
  }

  if (mode === 'refusal') {
    return {
      stdout: [
        'fake-local-v1 refusal',
        '```json',
        JSON.stringify({
          status: 'refused',
          reason: 'fake-local deterministic refusal',
          promptTokensActual: args.estimatedTokens,
          completionTokens: 0,
        }),
        '```',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    stdout: [
      'fake-local-v1 success',
      '```json',
      JSON.stringify({
        status: 'ok',
        adapter: config.id,
        agent: args.agent,
        phase: String(args.phase),
        attempt: args.attempt,
        promptTokensActual: args.estimatedTokens,
        completionTokens: 0,
      }),
      '```',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
    signal: null,
    durationMs: Date.now() - startedAt,
  };
}

function fakeLocalMode(config: ModelAdapterConfig): FakeLocalMode {
  const args = config.args ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--mode=')) {
      return parseMode(arg.slice('--mode='.length));
    }
    if (arg === '--mode') {
      return parseMode(args[i + 1]);
    }
  }
  return parseMode(process.env.HARNESS_FAKE_LOCAL_MODE);
}

function parseMode(value: string | undefined): FakeLocalMode {
  switch (value) {
    case 'timeout':
    case 'malformed-json':
    case 'refusal':
    case 'success':
      return value;
    default:
      return 'success';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
