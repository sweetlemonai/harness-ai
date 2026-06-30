import { spawn } from 'node:child_process';
import { AgentTimeoutError } from '../../../types.js';
import { trackChild } from '../../../pipeline/runner.js';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  RawModelInvocationArgs,
  RawModelInvocationResult,
} from '../types.js';

const DEFAULT_COMMAND = 'claude';
const DEFAULT_ARGS = ['--dangerously-skip-permissions', '-p'] as const;

export function createClaudeCliAdapter(config: ModelAdapterConfig): ModelAdapter {
  const command = config.command ?? DEFAULT_COMMAND;
  const cliArgs = config.args ?? DEFAULT_ARGS;

  return {
    id: config.id,
    kind: 'claude-cli',
    invoke(args: RawModelInvocationArgs): Promise<RawModelInvocationResult> {
      return invokeClaudeCli(command, cliArgs, args);
    },
  };
}

function invokeClaudeCli(
  command: string,
  cliArgs: readonly string[],
  args: RawModelInvocationArgs,
): Promise<RawModelInvocationResult> {
  return new Promise<RawModelInvocationResult>((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const child = spawn(
      command,
      [...cliArgs],
      {
        cwd: args.ctx.paths.repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // new process group so we can SIGKILL grandchildren
      },
    );
    const stopTracking = trackChild(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // Timeout via AbortController. The controller is retained to mirror the
    // previous lifecycle; enforcement is the process-group kill below.
    let timedOut = false;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
      killGroup(child.pid, 'SIGKILL');
    }, args.timeoutMs);
    timer.unref();

    const finalize = (
      settle: (resolve: typeof resolvePromise, reject: typeof rejectPromise) => void,
    ): void => {
      clearTimeout(timer);
      stopTracking();
      settle(resolvePromise, rejectPromise);
    };

    child.once('error', (err) => {
      finalize((_resolve, reject) => {
        if (timedOut) {
          reject(
            new AgentTimeoutError(args.agent, args.timeoutMs, args.attempt),
          );
          return;
        }
        reject(err);
      });
    });

    child.once('exit', (code, signal) => {
      finalize((resolve) => {
        resolve({
          stdout,
          stderr,
          exitCode: code,
          signal: signal ?? null,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });
    });

    child.stdin?.end(args.prompt);
    void ac;
  });
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  // Negative pid sends the signal to every member of the group.
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // process group may not exist (e.g. child already exited); fall back
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ignore - already gone
  }
}
