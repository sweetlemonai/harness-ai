import { runCommand } from '../../shell.js';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  RawModelInvocationArgs,
  RawModelInvocationResult,
} from '../types.js';

const DEFAULT_COMMAND = 'openclaw';
const DEFAULT_AGENT_ID = 'forge';

export function createOpenClawAgentAdapter(config: ModelAdapterConfig): ModelAdapter {
  return {
    id: config.id,
    kind: 'openclaw-agent',
    invoke(args: RawModelInvocationArgs): Promise<RawModelInvocationResult> {
      return invokeOpenClawAgent(config, args);
    },
  };
}

async function invokeOpenClawAgent(
  config: ModelAdapterConfig,
  args: RawModelInvocationArgs,
): Promise<RawModelInvocationResult> {
  const command = config.command ?? DEFAULT_COMMAND;
  const agentId = config.agentId ?? DEFAULT_AGENT_ID;
  const sessionId = [
    'harness',
    args.ctx.runPaths.runId,
    String(args.phase).replace(/[^A-Za-z0-9_-]/g, '_'),
    String(args.attempt),
  ].join('-');
  const cliArgs = config.args ?? [
    'agent',
    '--json',
    '--agent',
    agentId,
    '--session-id',
    sessionId,
    '--timeout',
    String(Math.max(1, Math.ceil(args.timeoutMs / 1000))),
    '--message',
    args.prompt,
  ];
  const exec = await runCommand(command, cliArgs, {
    cwd: args.ctx.paths.repoRoot,
    timeoutMs: args.timeoutMs,
  });
  return {
    stdout: exec.stdout,
    stderr: exec.stderr,
    exitCode: exec.exitCode,
    signal: exec.signal,
    durationMs: exec.durationMs,
    timedOut: exec.timedOut,
  };
}
