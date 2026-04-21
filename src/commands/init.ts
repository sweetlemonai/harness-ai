// `harness-ai init` — scaffold a fresh repo with .claude/ and harness/
// directories, seeded from package-bundled templates. Framework-specific
// Playwright config is selected via --framework.
//
// Existing files are left alone unless --force is passed; this keeps the
// command idempotent so re-running it after manual edits is safe.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveHarnessPaths } from '../lib/paths.js';

export interface InitCommandArgs {
  readonly framework: 'react' | 'nextjs';
  readonly force: boolean;
}

const DIRS: readonly string[] = [
  '.claude',
  '.claude/context',
  '.claude/standards',
  'harness',
  'harness/tasks',
];

const GITIGNORE_ENTRIES: readonly string[] = [
  '# harness-ai',
  'harness/runs/',
  'harness/analytics/',
  'harness/test-results/',
  'harness/config.local.json',
];

export async function initCommand(args: InitCommandArgs): Promise<number> {
  const paths = resolveHarnessPaths();
  const repoRoot = paths.repoRoot;
  const templatesDir = resolve(paths.packageDefaultsDir, 'templates');

  for (const d of DIRS) {
    mkdirSync(resolve(repoRoot, d), { recursive: true });
  }

  const playwrightTemplate =
    args.framework === 'nextjs'
      ? 'playwright.nextjs.config.ts'
      : 'playwright.react.config.ts';

  const copies: ReadonlyArray<readonly [string, string]> = [
    ['CLAUDE.md.template', '.claude/CLAUDE.md'],
    ['tech-stack.md.template', '.claude/standards/tech-stack.md'],
    ['config.json.template', 'harness/config.json'],
    [playwrightTemplate, 'harness/playwright.config.ts'],
  ];

  for (const [templateName, destRel] of copies) {
    copyTemplate(
      resolve(templatesDir, templateName),
      resolve(repoRoot, destRel),
      args.force,
    );
  }

  appendGitignore(resolve(repoRoot, '.gitignore'));

  process.stdout.write(
    [
      '',
      'harness-ai initialized.',
      '',
      'Next steps:',
      '  1. Edit .claude/CLAUDE.md — describe your project',
      '  2. Fill in .claude/standards/tech-stack.md',
      '  3. Write your first task at harness/tasks/<project>/<N>-<slug>.md',
      '  4. Run: npx harness-ai ship <project>/<task>',
      '',
      `Framework: ${args.framework}`,
      '',
    ].join('\n'),
  );
  return 0;
}

function copyTemplate(src: string, dest: string, force: boolean): void {
  if (existsSync(dest) && !force) {
    process.stdout.write(
      `  skip: ${dest} already exists (use --force to overwrite)\n`,
    );
    return;
  }
  if (!existsSync(src)) {
    process.stderr.write(
      `  error: template missing: ${src} — reinstall @sweetlemonai/harness-ai\n`,
    );
    return;
  }
  const content = readFileSync(src, 'utf8');
  writeFileSync(dest, content, 'utf8');
  process.stdout.write(`  wrote: ${dest}\n`);
}

function appendGitignore(path: string): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const missing = GITIGNORE_ENTRIES.filter((line) => !existing.includes(line));
  if (missing.length === 0) return;
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(path, existing + sep + missing.join('\n') + '\n', 'utf8');
  process.stdout.write(`  updated: ${path}\n`);
}
