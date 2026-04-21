# Harness-AI Packaging — Implementation Plan

Comprehensive, file-by-file plan to finish converting LemonHarness into the `@sweetlemonai/harness-ai` npm package, with support for both React+Vite and Next.js projects.

This doc is designed to be executable by Claude Code (or yourself) one task at a time. Each task is self-contained and independently verifiable.

---

## Table of contents

1. [Current state — what's done](#1-current-state)
2. [Architecture summary](#2-architecture-summary)
3. [Framework-agnosticism analysis](#3-framework-agnosticism)
4. [Task list — remaining work](#4-task-list)
5. [Task 1: Path resolution refactor](#5-task-1-path-resolution-refactor)
6. [Task 2: Update phase call sites](#6-task-2-update-phase-call-sites)
7. [Task 3: Config loader refactor](#7-task-3-config-loader-refactor)
8. [Task 4: `init` command](#8-task-4-init-command)
9. [Task 5: Templates](#9-task-5-templates)
10. [Task 6: Framework-specific Playwright configs](#10-task-6-framework-specific-playwright-configs)
11. [Task 7: Build + verification](#11-task-7-build-verification)
12. [Task 8: README + MIGRATION + .npmignore](#12-task-8-docs)
13. [Task 9: Publish](#13-task-9-publish)
14. [Verification checklist](#14-verification-checklist)
15. [Open questions / decisions deferred](#15-open-questions)

---

## 1. Current state

**Done (by me, in `/home/claude/harness-ai/`):**

- Directory restructured to package layout:
  ```
  harness-ai/
  ├── src/              (harness TypeScript source — unchanged)
  ├── defaults/
  │   ├── config.json   (stripped of @medplum references)
  │   ├── config.schema.json
  │   ├── playwright.config.ts  (still Vite-specific — Task 6)
  │   └── .claude/
  │       ├── agents/   (16 files — bundled as package defaults)
  │       ├── skills/   (6 files — bundled as package defaults)
  │       └── standards/ (7 files — bundled as package defaults)
  ├── package.json      (fresh — @sweetlemonai/harness-ai, bin, files, etc.)
  ├── tsconfig.json     (fresh)
  └── tsup.config.ts    (fresh)
  ```
- `defaults/.claude/templates/` directory created (empty — Task 5 fills it).
- All framework-agnostic shareable content now lives under `defaults/`.

**Not done:** Everything below. None of the code has been touched yet — `src/` still behaves as if it lives at `<repo>/harness/` alongside `<repo>/.claude/`.

---

## 2. Architecture summary

### Before (LemonHarness)

```
<repo>/
├── .claude/                  ← all agents, skills, standards, CLAUDE.md
├── harness/                  ← committed harness code + config + tasks
│   ├── src/
│   ├── config.json
│   ├── config.schema.json
│   ├── playwright.config.ts
│   └── tasks/
└── src/                      ← the React/Vite app
```

### After (harness-ai)

```
<repo>/
├── .claude/
│   ├── CLAUDE.md             ← per-repo (required)
│   ├── context/              ← per-repo domain docs
│   ├── standards/
│   │   └── tech-stack.md     ← per-repo (required, filled in)
│   ├── agents/               ← per-repo OVERRIDES (optional)
│   ├── skills/               ← per-repo OVERRIDES (optional)
│   └── standards/<other>.md  ← per-repo OVERRIDES (optional)
│
├── harness/
│   ├── config.json           ← per-repo overrides (optional)
│   ├── config.local.json     ← gitignored local overrides
│   └── tasks/<project>/...   ← tickets + generated artefacts
│
├── node_modules/
│   └── @sweetlemonai/
│       └── harness-ai/
│           ├── dist/         ← compiled CLI
│           └── defaults/     ← bundled agents, skills, standards, schema
│
├── package.json              ← includes @sweetlemonai/harness-ai as devDep
└── src/                      ← the user's app (React OR Next.js)
```

### Resolution rules

| Asset | Resolution order |
|---|---|
| Agent file (e.g. `spec.agent.md`) | `<repo>/.claude/agents/<file>` → package `defaults/.claude/agents/<file>` → error |
| Skill file | `<repo>/.claude/skills/<file>` → package `defaults/.claude/skills/<file>` → error |
| Standard file | Merged: package defaults + repo (repo wins on filename conflict) |
| Context file | Merged: package defaults (none by default) + repo |
| `CLAUDE.md` | `<repo>/.claude/CLAUDE.md` only. Required — error if missing. |
| `tech-stack.md` | `<repo>/.claude/standards/tech-stack.md` only. Required — error if missing. |
| `config.json` | Package `defaults/config.json` base, overlaid by `<repo>/harness/config.json` (if present), overlaid by `<repo>/harness/config.local.json` (if present) |
| `config.schema.json` | Package only — not user-editable |
| `playwright.config.ts` | `<repo>/harness/playwright.config.ts` (copied in by `init`) |

### Running the CLI

- User runs `npx harness-ai <command>` or `pnpm harness <command>` from repo root.
- `process.cwd()` = repo root. This replaces the current "walk up looking for harness/" logic.

---

## 3. Framework-agnosticism

### What's framework-specific in the current harness code

**Almost nothing.** Audit result:

| Area | Framework-specific? | Handling |
|---|---|---|
| `hardGates.ts` | No — gates are `tsc` + `eslint` + auto-detected `vitest` + `storybook` | Works for React, Vite, Next.js, any TS project |
| `build.ts`, `spec.ts`, `context.ts`, etc. | No — consume agent output, no framework API calls | Works for anything |
| `shell.ts` — vitest helper | Expects vitest CLI output format | Works if user uses vitest |
| `projectPr.ts` line 389 | Mentions "@testing-library/react" in a prose string | Harmless for Next.js (which uses @testing-library/react too) |
| `defaults/playwright.config.ts` | **YES — hardcodes Vite port 5173** | **Task 6: provide framework-aware templates** |
| `.claude/agents/*.md` | Generic workflow descriptions | Audit confirmed — no React-specific instructions |
| `.claude/skills/*.md` | Generic skill docs | Audit confirmed — framework-neutral |
| `.claude/standards/tech-stack.md` | Template with empty fields | User fills per-project |

### What user-facing content is framework-specific

This is content the user writes per-project and is NOT part of the package:

- `.claude/CLAUDE.md` — framework conventions, component patterns, routing rules
- `.claude/context/*.md` — framework-specific deep docs (e.g., "Next.js App Router patterns")
- `.claude/standards/tech-stack.md` — framework name, packages, versions

**Verdict:** the harness package is framework-agnostic. Framework support is entirely a matter of what the user puts in their repo's `.claude/` directory. The one exception is `playwright.config.ts`, which Task 6 addresses with framework-specific templates.

---

## 4. Task list

Tasks in dependency order. Each is ≤ 2 hours of focused work. Run them sequentially.

| # | Task | Files touched | Time |
|---|---|---|---|
| 1 | Path resolution refactor (core) | `src/lib/paths.ts`, `src/types.ts` | 1.5h |
| 2 | Update phase call sites to use resolver | ~15 files across `src/pipeline/phases/` and `src/commands/` | 1.5h |
| 3 | Config loader: package default + repo overlay | `src/lib/config.ts` | 0.5h |
| 4 | `init` command | `src/commands/init.ts` (new), `src/cli.ts` | 1.5h |
| 5 | Templates | `defaults/templates/*` | 1h |
| 6 | Framework-specific Playwright configs | `defaults/templates/playwright.*.config.ts` | 0.5h |
| 7 | Build + verification | `tsup.config.ts` (tweaks), `tsconfig.json` | 0.5h |
| 8 | README + MIGRATION + .npmignore | 3 new files | 1h |
| 9 | Publish to npm | GitHub Actions or manual | 0.5h |

**Total: ~8.5 hours of focused work.**

---

## 5. Task 1: Path resolution refactor

### Goal

Replace the "walk up from `src/lib/paths.ts` looking for `harness/`" logic with:

- Repo root = `process.cwd()`.
- Package root = resolved from this module's URL (works whether installed via npm or linked via `pnpm link`).
- New `HarnessPaths` fields for package-default asset locations.
- New `resolveClaudeAsset(paths, 'category/name.md')` helper implementing repo → package fallback.
- New `listClaudeAssets(paths, 'category')` helper returning merged list (used for `collectStandardsSections`).

### 5.1 Update `src/types.ts`

In `HarnessPaths` interface, **add** these fields (don't remove existing ones yet — Task 2 will clean up):

```typescript
export interface HarnessPaths {
  readonly repoRoot: string;
  readonly harnessRoot: string;         // <repo>/harness
  readonly packageRoot: string;         // the installed npm package root (or source during dev)
  readonly packageDefaultsDir: string;  // <packageRoot>/defaults

  readonly configFile: string;                // <repo>/harness/config.json  (may not exist)
  readonly configLocalFile: string;           // <repo>/harness/config.local.json  (may not exist)
  readonly packageConfigFile: string;         // <packageRoot>/defaults/config.json  (always exists)
  readonly configSchemaFile: string;          // <packageRoot>/defaults/config.schema.json

  readonly claudeRoot: string;                // <repo>/.claude
  readonly claudeAgentsDir: string;           // <repo>/.claude/agents
  readonly claudeContextDir: string;          // <repo>/.claude/context
  readonly claudeStandardsDir: string;        // <repo>/.claude/standards
  readonly claudeSkillsDir: string;           // <repo>/.claude/skills
  readonly claudeMdFile: string;              // <repo>/.claude/CLAUDE.md

  readonly packageAgentsDir: string;          // <packageRoot>/defaults/.claude/agents
  readonly packageContextDir: string;         // <packageRoot>/defaults/.claude/context
  readonly packageStandardsDir: string;       // <packageRoot>/defaults/.claude/standards
  readonly packageSkillsDir: string;          // <packageRoot>/defaults/.claude/skills

  readonly briefsDir: string;                 // <repo>/harness/briefs
  readonly tasksDir: string;                  // <repo>/harness/tasks
  readonly analyticsDir: string;              // <repo>/harness/analytics

  readonly srcDir: string;                    // <repo>/src
  readonly playwrightConfig: string;          // <repo>/harness/playwright.config.ts
}
```

### 5.2 Rewrite `src/lib/paths.ts`

Replace `findHarnessRoot` / `resolveHarnessRoot` / `resolveHarnessPaths` with:

```typescript
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Package root — where the installed npm package lives.
//
// This file ends up at <packageRoot>/dist/cli.js (built) OR
// <packageRoot>/src/lib/paths.ts (source). Walk up until we find
// package.json with name "@sweetlemonai/harness-ai".
// ---------------------------------------------------------------------------

function resolvePackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = resolve(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(require('node:fs').readFileSync(pkg, 'utf8'));
        if (json?.name === '@sweetlemonai/harness-ai') return realpathSync(dir);
      } catch {
        // ignore, keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate @sweetlemonai/harness-ai package root from module at ${fileURLToPath(import.meta.url)}`,
  );
}

// ---------------------------------------------------------------------------
// Repo root = process.cwd(). User runs harness-ai from their repo root.
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  return realpathSync(process.cwd());
}

export function resolveHarnessPaths(): HarnessPaths {
  const repoRoot = resolveRepoRoot();
  const packageRoot = resolvePackageRoot();
  const harnessRoot = resolve(repoRoot, 'harness');
  const claudeRoot = resolve(repoRoot, '.claude');
  const packageDefaultsDir = resolve(packageRoot, 'defaults');

  return {
    repoRoot,
    harnessRoot,
    packageRoot,
    packageDefaultsDir,

    configFile: resolve(harnessRoot, 'config.json'),
    configLocalFile: resolve(harnessRoot, 'config.local.json'),
    packageConfigFile: resolve(packageDefaultsDir, 'config.json'),
    configSchemaFile: resolve(packageDefaultsDir, 'config.schema.json'),

    claudeRoot,
    claudeAgentsDir: resolve(claudeRoot, 'agents'),
    claudeContextDir: resolve(claudeRoot, 'context'),
    claudeStandardsDir: resolve(claudeRoot, 'standards'),
    claudeSkillsDir: resolve(claudeRoot, 'skills'),
    claudeMdFile: resolve(claudeRoot, 'CLAUDE.md'),

    packageAgentsDir: resolve(packageDefaultsDir, '.claude/agents'),
    packageContextDir: resolve(packageDefaultsDir, '.claude/context'),
    packageStandardsDir: resolve(packageDefaultsDir, '.claude/standards'),
    packageSkillsDir: resolve(packageDefaultsDir, '.claude/skills'),

    briefsDir: resolve(harnessRoot, 'briefs'),
    tasksDir: resolve(harnessRoot, 'tasks'),
    analyticsDir: resolve(harnessRoot, 'analytics'),

    srcDir: resolve(repoRoot, 'src'),
    playwrightConfig: resolve(harnessRoot, 'playwright.config.ts'),
  };
}
```

### 5.3 Add resolver helpers

Append to `src/lib/paths.ts`:

```typescript
/**
 * Resolve a `.claude/` asset path. Repo takes priority, package default is
 * the fallback. Throws if neither exists.
 *
 * @param paths  Resolved harness paths
 * @param relativePath  Path relative to `.claude/`, e.g. "agents/spec.agent.md"
 */
export function resolveClaudeAsset(
  paths: HarnessPaths,
  relativePath: string,
): string {
  const repoPath = resolve(paths.claudeRoot, relativePath);
  if (existsSync(repoPath)) return repoPath;
  const pkgPath = resolve(paths.packageDefaultsDir, '.claude', relativePath);
  if (existsSync(pkgPath)) return pkgPath;
  throw new Error(
    `Asset not found at repo (${repoPath}) or package (${pkgPath})`,
  );
}

/**
 * List merged assets from a .claude/ subdirectory. Returns { name, path }
 * entries where repo files take priority over package files with the
 * same basename. Used for bulk reads (e.g. all standards).
 */
export function listClaudeAssets(
  paths: HarnessPaths,
  category: 'agents' | 'context' | 'standards' | 'skills',
): ReadonlyArray<{ readonly name: string; readonly path: string }> {
  const packageDir = resolve(paths.packageDefaultsDir, '.claude', category);
  const repoDir = resolve(paths.claudeRoot, category);
  const byName = new Map<string, string>();

  for (const dir of [packageDir, repoDir]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const full = resolve(dir, name);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      byName.set(name, full); // later overwrites earlier → repo wins
    }
  }

  return [...byName.entries()].map(([name, path]) => ({ name, path }));
}
```

### 5.4 Verify

```bash
cd harness-ai
pnpm typecheck
# Expected: ONLY errors from call sites still using old path semantics.
# Those are fixed in Task 2.
```

---

## 6. Task 2: Update phase call sites

Every phase file that reads from `ctx.paths.claude*Dir` needs updating.

### 6.1 File list + line numbers

| File | Current code | Replace with |
|---|---|---|
| `src/pipeline/phases/preflight.ts:176` | `resolve(ctx.paths.claudeAgentsDir, name)` | `resolveClaudeAsset(ctx.paths, \`agents/${name}\`)` (wrap in try/catch — missing → error with clear message listing both searched paths) |
| `src/pipeline/phases/preflight.ts:194-198` | `existsSync(ctx.paths.claudeMdFile)` | Unchanged — CLAUDE.md is repo-only, correctly errors if missing |
| `src/pipeline/phases/spec.ts:215` | `resolve(ctx.paths.claudeAgentsDir, 'spec.agent.md')` | `resolveClaudeAsset(ctx.paths, 'agents/spec.agent.md')` |
| `src/pipeline/phases/context.ts:149` | `resolve(ctx.paths.claudeAgentsDir, 'context.agent.md')` | `resolveClaudeAsset(ctx.paths, 'agents/context.agent.md')` |
| `src/pipeline/phases/context.ts:363-387` | `collectStandardsSections` reads `claudeStandardsDir` + `claudeContextDir` | Rewrite to use `listClaudeAssets(ctx.paths, 'standards')` + `listClaudeAssets(ctx.paths, 'context')`, read each file's content, preserve `${basename(dir)}/${name}` section name format |
| `src/pipeline/phases/design.ts:142` | `resolve(ctx.paths.claudeAgentsDir, 'designer.agent.md')` | `resolveClaudeAsset(ctx.paths, 'agents/designer.agent.md')` |
| `src/pipeline/phases/qa.ts:146` | `resolve(ctx.paths.claudeAgentsDir, 'qa.agent.md')` | `resolveClaudeAsset(ctx.paths, 'agents/qa.agent.md')` |
| `src/pipeline/phases/reconcile.ts:252, 310` | `resolve(ctx.paths.claudeAgentsDir, 'reconciliation.agent.md')`, `'coding.agent.md'` | `resolveClaudeAsset(ctx.paths, 'agents/reconciliation.agent.md')` and `'agents/coding.agent.md'` |
| `src/pipeline/phases/build.ts:390` | `readFileSync(resolve(ctx.paths.claudeAgentsDir, filename), 'utf8')` | `readFileSync(resolveClaudeAsset(ctx.paths, \`agents/${filename}\`), 'utf8')` |
| `src/pipeline/phases/hardGates.ts:316` | `readFile(resolve(ctx.paths.claudeAgentsDir, 'coding.agent.md'))` | `readFile(resolveClaudeAsset(ctx.paths, 'agents/coding.agent.md'))` |
| `src/pipeline/phases/e2e.ts:411` | Same pattern | Same |
| `src/pipeline/phases/softGates.ts:143` | `resolve(ctx.paths.claudeAgentsDir, \`${name}.agent.md\`)` | `resolveClaudeAsset(ctx.paths, \`agents/${name}.agent.md\`)` |
| `src/pipeline/phases/prAssembly.ts:114` | Same | Same |
| `src/lib/projectPr.ts:245` | Same | Same |
| `src/commands/ship.ts:429` | `resolve(paths.claudeAgentsDir, 'task-breaker.agent.md')` | `resolveClaudeAsset(paths, 'agents/task-breaker.agent.md')` |

### 6.2 Rewrite `collectStandardsSections` in `context.ts`

```typescript
import { listClaudeAssets } from '../../lib/paths.js';

function collectStandardsSections(ctx: RunContext): StandardSection[] {
  const standards = listClaudeAssets(ctx.paths, 'standards');
  const contexts = listClaudeAssets(ctx.paths, 'context');
  const out: StandardSection[] = [];
  for (const { name, path } of standards) {
    out.push({ name: `standards/${name}`, content: readFileSync(path, 'utf8') });
  }
  for (const { name, path } of contexts) {
    out.push({ name: `context/${name}`, content: readFileSync(path, 'utf8') });
  }
  return out;
}
```

### 6.3 Update `preflight.checkAgentFiles` for clearer errors

```typescript
function checkAgentFiles(ctx: RunContext): void {
  for (const name of REQUIRED_AGENTS) {
    let p: string;
    try {
      p = resolveClaudeAsset(ctx.paths, `agents/${name}`);
    } catch (err) {
      throw new PreflightCheckError(
        'agent-files',
        `agent file '${name}' missing at both repo (.claude/agents/) and package defaults. Original: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const content = readFileSync(p, 'utf8');
    if (content.trim().length === 0) {
      throw new PreflightCheckError('agent-files', `agent file is empty: ${p}`);
    }
  }
}
```

### 6.4 Verify

```bash
pnpm typecheck  # expected: clean
```

---

## 7. Task 3: Config loader refactor

### 7.1 Update `src/lib/config.ts`

Change `loadConfig` to build config as: **package default → repo overrides → local overrides**.

```typescript
export function loadConfig(paths: HarnessPaths): HarnessConfig {
  // 1. Package default (always exists)
  const packageDefault = readJsonFile(paths.packageConfigFile, 'package defaults/config.json');

  // 2. Repo overrides (may not exist — user ran init but didn't customize)
  const repoOverrides = existsSync(paths.configFile)
    ? readJsonFile(paths.configFile, 'harness/config.json')
    : null;

  // 3. Local gitignored overrides
  const localOverrides = existsSync(paths.configLocalFile)
    ? readJsonFile(paths.configLocalFile, 'harness/config.local.json')
    : null;

  let merged = packageDefault;
  if (repoOverrides) merged = deepMergeObjects(merged, repoOverrides);
  if (localOverrides) merged = deepMergeObjects(merged, localOverrides);

  const schema = readJsonFile(paths.configSchemaFile, 'config.schema.json');
  const validator = compileValidator(schema);
  if (!validator(merged)) throw firstValidationError(validator.errors);

  return merged as unknown as HarnessConfig;
}
```

Edit `runCli()` at the bottom of the file similarly — it uses `resolveHarnessPaths()` which now handles package root automatically.

### 7.2 Verify

```bash
pnpm typecheck
```

---

## 8. Task 4: `init` command

### 8.1 Create `src/commands/init.ts`

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveHarnessPaths } from '../lib/paths.js';

export interface InitCommandArgs {
  readonly framework: 'react' | 'nextjs';
  readonly force: boolean;
}

const DIRS = [
  '.claude',
  '.claude/context',
  '.claude/standards',
  'harness',
  'harness/tasks',
];

const GITIGNORE_ENTRIES = [
  '# harness-ai',
  'harness/runs/',
  'harness/analytics/',
  'harness/test-results/',
  'harness/config.local.json',
];

export async function initCommand(args: InitCommandArgs): Promise<void> {
  const paths = resolveHarnessPaths();
  const repoRoot = paths.repoRoot;

  // 1. Create directory tree
  for (const d of DIRS) mkdirSync(resolve(repoRoot, d), { recursive: true });

  // 2. Copy templates
  const templatesDir = resolve(paths.packageDefaultsDir, 'templates');
  copyTemplate(
    resolve(templatesDir, 'CLAUDE.md.template'),
    resolve(repoRoot, '.claude/CLAUDE.md'),
    args.force,
  );
  copyTemplate(
    resolve(templatesDir, 'tech-stack.md.template'),
    resolve(repoRoot, '.claude/standards/tech-stack.md'),
    args.force,
  );
  copyTemplate(
    resolve(templatesDir, 'config.json.template'),
    resolve(repoRoot, 'harness/config.json'),
    args.force,
  );

  // Framework-specific playwright config
  const playwrightTemplate =
    args.framework === 'nextjs'
      ? 'playwright.nextjs.config.ts'
      : 'playwright.react.config.ts';
  copyTemplate(
    resolve(templatesDir, playwrightTemplate),
    resolve(repoRoot, 'harness/playwright.config.ts'),
    args.force,
  );

  // 3. Update .gitignore
  appendGitignore(resolve(repoRoot, '.gitignore'));

  // 4. Print next steps
  const next = [
    '',
    'harness-ai initialized.',
    '',
    'Next steps:',
    '  1. Edit .claude/CLAUDE.md — describe your project',
    '  2. Fill in .claude/standards/tech-stack.md',
    '  3. Write your first task at harness/tasks/<project>/<N>-<slug>.md',
    `  4. Run: npx harness-ai ship <project>/<task>`,
    '',
    `Framework: ${args.framework}`,
    '',
  ].join('\n');
  process.stdout.write(next);
}

function copyTemplate(src: string, dest: string, force: boolean): void {
  if (existsSync(dest) && !force) {
    process.stdout.write(`  skip: ${dest} already exists (use --force to overwrite)\n`);
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
  const sep = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  writeFileSync(path, existing + sep + missing.join('\n') + '\n', 'utf8');
  process.stdout.write(`  updated: ${path}\n`);
}
```

### 8.2 Wire into `src/cli.ts`

Add after the `ship` command registration:

```typescript
program
  .command('init')
  .description('Scaffold .claude/ and harness/ in a fresh repo')
  .option('--framework <framework>', 'react or nextjs', 'nextjs')
  .option('--force', 'overwrite existing files')
  .action(async (opts) => {
    const framework = opts.framework === 'react' ? 'react' : 'nextjs';
    await initCommand({ framework, force: Boolean(opts.force) });
  });
```

### 8.3 Verify

```bash
pnpm typecheck
pnpm build
cd /tmp && mkdir test-init && cd test-init
node /path/to/harness-ai/dist/cli.js init --framework nextjs
ls -la .claude/ harness/ .gitignore
```

---

## 9. Task 5: Templates

Create in `defaults/templates/`:

### 9.1 `CLAUDE.md.template`

```markdown
# <Project Name>

## What This Is

<One-paragraph description of what this project is and what you're building.>

This repo uses the AI harness (`@sweetlemonai/harness-ai`) to deliver
features. The harness drives Claude Code agents through a pipeline
and enforces quality gates. When working inside this repo, follow the
patterns documented in the context files below — they are the source
of truth for how code should be structured.

---

## Required reading before writing any code

Read these files in full before touching any source file:

1. `.claude/standards/tech-stack.md` — the locked list of approved packages.
2. `.claude/standards/coding.md` — naming, structure, patterns.
3. `.claude/standards/testing.md` — test requirements for every task.
4. `.claude/context/<project-specific>.md` — domain knowledge (add files as needed).

---

## Tech Stack

See `.claude/standards/tech-stack.md` for the canonical list.

---

## Project Structure

```
src/
  <describe your directory layout here>
```

---

## Non-negotiable rules

<List any rules that MUST be followed.>

- <example: TypeScript strict mode — no any, ever>
- <example: no useMemo / useCallback — React 19 compiler handles it>
- <example: all data fetching goes through hooks in src/hooks/>

---

## What not to do

<List anti-patterns the agents must avoid.>

- <example: Do not write API clients inline in components>
- <example: Do not use class components>
```

### 9.2 `tech-stack.md.template`

```markdown
---
standard: tech-stack
version: 1.0
updated: <YYYY-MM-DD>
---

# Standard: tech-stack

## How to use this file
- Source of truth for all technology decisions
- Every agent reads this before installing any package
- Any new dependency must be added here before use

## Frontend
- Framework: <e.g. Next.js 15 App Router>
- Styling: <e.g. Tailwind CSS v4 + shadcn/ui>
- State management: <e.g. React state, URL state, Server Actions>
- Routing: <e.g. App Router file-based>
- Forms: <e.g. React Hook Form + Zod>
- Testing: <e.g. Vitest + @testing-library/react + Playwright>
- Build tool: <e.g. Next.js built-in (Turbopack)>

## Backend
- Runtime: <e.g. Node 20 via Next.js>
- Framework: <e.g. Next.js Route Handlers + Server Actions>
- ORM: <e.g. Drizzle>
- Authentication: <e.g. Auth.js v5>
- API style: <e.g. Server Actions for mutations, Route Handlers for reads>
- Testing: <e.g. Vitest>

## Database
- Primary database: <e.g. PostgreSQL via Neon>
- Caching: <e.g. Next.js cache + React cache>
- Search: <e.g. Postgres full-text, or skip>
- File storage: <e.g. Vercel Blob, or skip>

## DevOps / infrastructure
- Hosting: <e.g. Vercel>
- CI/CD: <e.g. Vercel + GitHub Actions>
- Environment management: <e.g. .env.local + Vercel env vars>
- Monitoring: <e.g. Vercel Analytics + PostHog>
- Error tracking: <e.g. Sentry, or skip>

## Approved packages

| Package | Version | Purpose |
|---------|---------|---------|
|         |         |         |

## Forbidden packages

| Package | Reason |
|---------|--------|
|         |        |

## Adding a new dependency
1. Check if existing approved package solves the problem first
2. Evaluate: bundle size, maintenance status, license, security
3. Add to approved packages table with version and purpose
4. Update this file before using in code
```

### 9.3 `config.json.template`

```json
{
  "_comment": "This file is overlaid on top of package defaults. Only include fields you want to change from the defaults.",
  "coreLibraries": []
}
```

---

## 10. Task 6: Framework-specific Playwright configs

### 10.1 `defaults/templates/playwright.react.config.ts`

Same as current `defaults/playwright.config.ts` (port 5173, `npm run dev` = Vite).

### 10.2 `defaults/templates/playwright.nextjs.config.ts`

```typescript
// Playwright config — Next.js project
//
// testDir and reporter are HARDCODED on purpose — the harness verifies
// these fields are unchanged after the QA agent runs. If the QA agent
// flips `reporter` to `['html']`, the pipeline hangs forever waiting
// on the HTML-report server.
//
// webServer runs `next dev` (port 3000) so tests can hit localhost:3000
// without the human starting it manually.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tasks',
  testMatch: '**/e2e/**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    cwd: '..',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

### 10.3 Remove the old `defaults/playwright.config.ts`

```bash
rm defaults/playwright.config.ts
```

The file is now only provided via `init` based on `--framework`.

---

## 11. Task 7: Build + verification

### 11.1 Adjust `tsup.config.ts`

Ensure the shebang is preserved and the output is executable.

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  splitting: false,
  minify: false,
  banner: { js: '#!/usr/bin/env node' },
  outExtension: () => ({ js: '.js' }),
  onSuccess: async () => {
    // chmod +x so the bin is executable
    const { chmodSync } = await import('node:fs');
    chmodSync('dist/cli.js', 0o755);
  },
});
```

### 11.2 Build

```bash
pnpm install
pnpm typecheck
pnpm build
ls -la dist/
# expect: cli.js (executable), cli.js.map
```

### 11.3 Smoke test locally

```bash
# Link package globally
pnpm link --global

# In a fresh test repo
mkdir /tmp/harness-test && cd /tmp/harness-test
git init
pnpm init
harness-ai init --framework nextjs
ls -la .claude/ harness/
harness-ai --help
# Expected: lists ship, run, init, status, debug, etc.
```

---

## 12. Task 8: Docs

### 12.1 `README.md` (package root)

Key sections:
- Install (`pnpm add -D @sweetlemonai/harness-ai`)
- `harness-ai init --framework nextjs|react`
- First task walkthrough
- Link to detailed internals (keep existing long README content as `docs/INTERNALS.md`)

### 12.2 `MIGRATION.md` — for existing LemonHarness users

Steps to move from committed `harness/` + `.claude/` to the npm package:

1. `pnpm add -D @sweetlemonai/harness-ai`
2. Save your current `.claude/CLAUDE.md`, `.claude/context/*.md`, `.claude/standards/tech-stack.md`
3. Delete `harness/` directory from repo (except `harness/tasks/`)
4. Run `harness-ai init --framework <yours>`
5. Restore saved `.claude/` files (CLAUDE.md, context, tech-stack)
6. If you had agent customizations: copy only the ones you changed into `.claude/agents/<name>.agent.md`
7. Move `harness/config.local.json` if you had one
8. Verify: `harness-ai --help` + pick a simple task and run

### 12.3 `.npmignore`

```
src/
tsconfig.json
tsup.config.ts
.github/
docs/
*.log
test-results/
analytics/
runs/
tasks/
```

### 12.4 `.gitignore` (package itself)

```
node_modules/
dist/
*.log
.DS_Store
```

---

## 13. Task 9: Publish

### 13.1 One-time setup

```bash
npm login
# confirm account with: npm whoami
```

### 13.2 Publish

```bash
cd harness-ai
pnpm build
npm publish --access public
```

(or set up GitHub Actions with `NPM_TOKEN` secret — can do later)

### 13.3 Verify

```bash
cd /tmp && mkdir publish-test && cd publish-test
pnpm init
pnpm add -D @sweetlemonai/harness-ai
pnpm harness-ai --help
```

---

## 14. Verification checklist

Run through these in order after Task 7:

- [ ] `pnpm typecheck` clean
- [ ] `pnpm build` produces `dist/cli.js`
- [ ] `dist/cli.js` is executable (`chmod +x` ran)
- [ ] `./dist/cli.js --help` lists `ship`, `run`, `init`, `status`, `debug`
- [ ] `harness-ai init --framework nextjs` in a fresh dir creates:
  - [ ] `.claude/CLAUDE.md` (from template)
  - [ ] `.claude/standards/tech-stack.md` (from template)
  - [ ] `harness/config.json` (minimal)
  - [ ] `harness/playwright.config.ts` (Next.js variant, port 3000)
  - [ ] `harness/tasks/` (empty)
  - [ ] `.gitignore` includes harness entries
- [ ] `harness-ai init --framework react` produces port 5173 playwright config
- [ ] `harness-ai init` fails cleanly if `.claude/CLAUDE.md` exists without `--force`
- [ ] Fresh repo + init + task run: full `ship` pipeline works end-to-end

---

## 15. Open questions

Decisions deferred — note them, answer later if needed:

1. **Default framework for `init`?** Plan says `nextjs` as default because SweetLemon is Next-first. If you expect more React+Vite users, change to `react`. Or make it required (no default).
2. **Should `init` add `@sweetlemonai/harness-ai` to `package.json`?** Plan says no (user runs `pnpm add` first). Alternative: `init --install` that does both. Nice-to-have.
3. **Should `init` create a `hello-world` sample task?** Helps first-run; noise otherwise. Default: no.
4. **`sync` command** — refresh default templates from package into the repo. Probably not needed — users pull new agents automatically via package version updates, only CLAUDE.md etc. are per-repo and shouldn't be overwritten.
5. **TypeScript source in the package?** Plan excludes `src/` from the published tarball. If you want downstream users to debug via source maps pointing to TS, include `src/` and reference via `sourcemap.mappingsURL`. Add later.
6. **Telemetry / usage analytics for the package?** E.g., opt-in ping on `init` so you know how many installs. Explicit opt-in if added.
7. **Published name `@sweetlemonai/harness-ai` uses a scoped public package** — requires `--access public` on first publish. Covered in Task 9.

---

## Appendix A: Running this plan via Claude Code

This plan is structured so each of the 9 tasks is independently executable. To run through Claude Code:

1. Push `harness-ai/` to GitHub (`sweetlemonai/harness-ai`).
2. Create a task ticket per plan task:
   ```markdown
   ---
   type: logic
   project: harness-ai-packaging
   depends: []  # or prior task slug
   ---

   # Task: <Task N name>

   <Paste the relevant section of this plan>

   ## Acceptance Criteria
   <Pull from the relevant "Verify" block>
   ```
3. For early packaging tasks, you probably want to run WITHOUT the harness itself (it's bootstrap-ish — the harness isn't stable during its own packaging). Use Claude Code interactively instead.
4. Once Task 7 verifies the build, you CAN use the freshly packaged harness to run later maintenance tasks on itself.

---

## Appendix B: Why `process.cwd()` over upward-walk

The current harness walks up from `src/lib/paths.ts` looking for an ancestor named `harness/` containing `config.json`. This works because the code is literally inside `harness/`.

Once installed as `node_modules/@sweetlemonai/harness-ai/dist/cli.js`, the same walk would find the nearest `harness/` directory above `node_modules/` — which is what we want only if the user happens to have `harness/` at repo root with the right files. That's the convention but fragile.

`process.cwd()` is simpler, matches every other CLI tool (npm, pnpm, next, etc.), and makes the expected invocation obvious: run from the repo root. The `harness-ai init` command enforces this layout by creating `harness/` there.

---

## Appendix C: Why standards are merged but agents fall back

**Agents:** single-file resolution. Either repo-level or package-level wins. An agent file is a complete instruction set — merging two would produce incoherent output.

**Standards + contexts:** file-list resolution. Every standard is appended to the context bundle. Adding new standards per-repo without overwriting defaults is a common case (e.g., "here's my project-specific coding convention on top of the general one"). Merging by filename lets users override a specific standard (`coding.md`) while keeping others (`git.md`, `testing.md`).

---

*End of plan.*
