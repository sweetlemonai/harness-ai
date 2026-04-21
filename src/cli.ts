// Thin CLI entry point. Routes subcommands to commands/*.ts. Contains no
// pipeline logic — every command module owns its own argument validation
// and calls into pipeline/runner.ts when it needs to run phases.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { PHASE_IDS, type PhaseId } from './types.js';
import { runCommand, type RunCommandArgs } from './commands/run.js';
import { shipCommand, type ShipCommandArgs } from './commands/ship.js';
import { initCommand } from './commands/init.js';
import { statusCommand } from './commands/status.js';
import { debugCommand } from './commands/debug.js';
import { parseFromTarget, resolveTaskRef, type FromTarget } from './lib/tasks.js';

// Resolve version from the shipped package.json so --version stays in
// sync with what npm published. Works in both bundled
// (`dist/cli.js` → `../package.json` = package root) and tsx-dev
// (`src/cli.ts` → `../package.json` = repo root) layouts.
function readPackageVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const raw = readFileSync(url, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // fall through
  }
  return '0.0.0';
}

function notImplemented(name: string): () => never {
  return () => {
    process.stderr.write(`${name}: not yet implemented\n`);
    process.exit(2);
  };
}

function parsePhaseId(value: string): PhaseId {
  if (!(PHASE_IDS as readonly string[]).includes(value)) {
    throw new Error(
      `invalid phase '${value}'. Expected one of: ${PHASE_IDS.join(', ')}`,
    );
  }
  return value as PhaseId;
}

/**
 * Resolve a CLI task argument. Accepts project-mode refs (no slash)
 * unchanged. For single-task refs, expands numeric shorthand
 * (`tick/1` → `tick/1-types`) and validates full-name refs against disk.
 */
function resolveOrExit(slug: string): string {
  try {
    return resolveTaskRef(slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(64);
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('harness')
    .description('AI engineering harness — ticket to reviewed branch')
    .version(readPackageVersion())
    .showHelpAfterError();

  program
    .command('ship')
    .description(
      'One-liner that chains import → plan → run → push → PR. Accepts a GitHub issue URL, a <project>, or <project>/<task>.',
    )
    .argument(
      '<input>',
      'GitHub issue URL, <project>, or <project>/<task>',
    )
    .option('--resume', 'continue after an escalation or interruption')
    .option(
      '--skip <taskNumber>',
      'mark task N as skipped-by-human and continue with the rest',
    )
    .option(
      '--restart <taskNumber>',
      're-run task N from preflight (clears its prior run state)',
    )
    .option(
      '--from <target>',
      're-run starting at <phase>, <task>, or <task>/<phase>',
      parseFromTarget,
    )
    .option('--dry-run', 'print the plan and exit without running')
    .option('--non-interactive', 'never prompt; warn and continue on mismatch')
    .option('--force', 'bypass confirmation prompts (e.g. fresh project run)')
    .action(
      async (
        input: string,
        opts: {
          resume?: boolean;
          skip?: string;
          restart?: string;
          from?: FromTarget;
          dryRun?: boolean;
          nonInteractive?: boolean;
          force?: boolean;
        },
      ) => {
        const args: ShipCommandArgs = {
          input,
          resume: opts.resume === true,
          dryRun: opts.dryRun === true,
          nonInteractive: opts.nonInteractive === true,
          force: opts.force === true,
          ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
          ...(opts.restart !== undefined ? { restart: opts.restart } : {}),
          ...(opts.from !== undefined ? { from: opts.from } : {}),
        };
        const code = await shipCommand(args);
        process.exit(code);
      },
    );

  program
    .command('run')
    .description(
      'Run the pipeline for a single task (<project>/<task>) or every task in a project (<project>).',
    )
    .argument('[task]', '<project>/<task> (single) or <project> (project mode)')
    .option(
      '--stop-after <phaseOrTask>',
      'single-task: stop after the named phase. project: stop after the named task.',
    )
    .option(
      '--from <target>',
      'force start from <phase> (single-task), <task>, or <task>/<phase> (project mode)',
      parseFromTarget,
    )
    .option('--dry-run', 'print the plan and exit without running')
    .option(
      '--resume',
      'single-task: resume the most recent run. project: keep tasks already complete; retry only the rest.',
    )
    .option(
      '--force',
      'project mode: skip the "discard prior state" confirmation prompt',
    )
    .option('--non-interactive', 'never prompt; warn and continue on mismatch')
    .action(
      async (
        task: string | undefined,
        opts: {
          stopAfter?: string;
          from?: FromTarget;
          dryRun?: boolean;
          resume?: boolean;
          force?: boolean;
          nonInteractive?: boolean;
        },
      ) => {
        const resolved = task !== undefined ? resolveOrExit(task) : undefined;
        const args: RunCommandArgs = {
          ...(resolved !== undefined ? { task: resolved } : {}),
          ...(opts.stopAfter !== undefined ? { stopAfter: opts.stopAfter } : {}),
          ...(opts.from !== undefined ? { from: opts.from } : {}),
          dryRun: opts.dryRun === true,
          resume: opts.resume === true,
          force: opts.force === true,
          nonInteractive: opts.nonInteractive === true,
        };
        const code = await runCommand(args);
        process.exit(code);
      },
    );

  program
    .command('resume <task>')
    .description('Alias for `run <task> --resume`. Takes the same flags as run.')
    .option(
      '--from <target>',
      'force start from <phase>, <task>, or <task>/<phase>',
      parseFromTarget,
    )
    .option('--stop-after <phase>', 'stop after the named phase completes')
    .option('--dry-run', 'print the phase plan and exit without running')
    .option('--non-interactive', 'never prompt; warn and continue on mismatch')
    .action(
      async (
        task: string,
        opts: {
          from?: FromTarget;
          stopAfter?: string;
          dryRun?: boolean;
          nonInteractive?: boolean;
        },
      ) => {
        const resolved = resolveOrExit(task);
        if (!resolved.includes('/')) {
          process.stderr.write(
            'resume: project-level resume is not supported. Pass a specific <project>/<task> reference.\n',
          );
          process.exit(64);
        }
        const args: RunCommandArgs = {
          task: resolved,
          resume: true,
          force: false,
          dryRun: opts.dryRun === true,
          nonInteractive: opts.nonInteractive === true,
          ...(opts.stopAfter !== undefined ? { stopAfter: opts.stopAfter } : {}),
          ...(opts.from !== undefined ? { from: opts.from } : {}),
        };
        const code = await runCommand(args);
        process.exit(code);
      },
    );

  program
    .command('init')
    .description('Scaffold .claude/ and harness/ in a fresh repo')
    .option('--framework <framework>', 'react or nextjs', 'nextjs')
    .option('--force', 'overwrite existing files')
    .action(async (opts: { framework?: string; force?: boolean }) => {
      const framework = opts.framework === 'react' ? 'react' : 'nextjs';
      const code = await initCommand({
        framework,
        force: opts.force === true,
      });
      process.exit(code);
    });

  program.command('plan <project>').description('Brief → task breakdown (stub)').action(notImplemented('plan'));
  program.command('import <project>').description('GitHub Issues → task files (stub)').action(notImplemented('import'));
  program.command('patch <task>').description('Scoped patch run (stub)').action(notImplemented('patch'));

  program
    .command('status')
    .description('Show project / task state overview')
    .option('--project <project>', 'filter to a single project')
    .action(async (opts: { project?: string }) => {
      const code = await statusCommand({
        ...(opts.project !== undefined ? { project: opts.project } : {}),
      });
      process.exit(code);
    });

  program
    .command('debug <task>')
    .description('Inspect runs, phases, prompts for a given task')
    .option('--run <id>', 'drill into a specific run')
    .option('--phase <phase>', 'drill into a specific phase of the run', parsePhaseId)
    .action(
      async (
        task: string,
        opts: { run?: string; phase?: PhaseId },
      ) => {
        const resolved = resolveOrExit(task);
        const code = await debugCommand({
          task: resolved,
          ...(opts.run !== undefined ? { run: opts.run } : {}),
          ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
        });
        process.exit(code);
      },
    );

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`harness: fatal error: ${msg}\n`);
  process.exit(1);
});
