# Migrating from LemonHarness

If you have an existing repo where `harness/` and `.claude/` are committed (the old LemonHarness layout), switch to `@sweetlemonai/harness-ai` with these steps.

## Before you start

Back up the files you care about. Agent/skill/standard customizations that lived in `.claude/` are the only irreplaceable pieces — everything under `harness/` (except `harness/tasks/`) is regenerable.

## Steps

1. **Install the package:**
   ```bash
   npm install -D @sweetlemonai/harness-ai
   # or: pnpm add -D @sweetlemonai/harness-ai
   ```

2. **Save your per-repo content:**
   - `.claude/CLAUDE.md`
   - `.claude/context/**`
   - `.claude/standards/tech-stack.md`
   - Any `.claude/agents/*.agent.md` **you customized** (don't save the ones you never touched — the package ships the originals)
   - Any `.claude/skills/*.md` or `.claude/standards/*.md` you customized
   - `harness/tasks/**` (your tickets and run artifacts)
   - `harness/config.local.json` if it exists

3. **Delete the committed harness scaffolding:**
   ```bash
   rm -rf harness/src harness/config.json harness/config.schema.json harness/playwright.config.ts
   rm -rf .claude/agents .claude/skills
   ```
   Keep `harness/tasks/` and the per-repo files from step 2.

4. **Run init:**
   ```bash
   npx harness-ai init --framework nextjs   # or --framework react
   ```
   This writes templates into `.claude/CLAUDE.md`, `.claude/standards/tech-stack.md`, `harness/config.json`, and `harness/playwright.config.ts`. It will **skip** files that already exist — so step 2's saved files survive.

5. **Restore your customizations:**
   - Drop your saved `.claude/CLAUDE.md`, `.claude/context/**`, and `.claude/standards/tech-stack.md` back in place (overwriting the templates).
   - For each customized agent/skill, put it at `.claude/agents/<name>.agent.md` or `.claude/skills/<name>.md`. The package falls back to its own defaults for every file you **didn't** override.
   - Restore `harness/config.local.json` if you had one.

6. **Verify:**
   ```bash
   npx harness-ai --help
   npx harness-ai run <project>/<task> --dry-run
   ```
   Pick a small task and ship it end-to-end.

## What changed

- **`harness/` is no longer committed.** The CLI, agents, skills, and standards ship via the npm package. Your repo only holds per-project content (tasks, custom agents, CLAUDE.md, tech-stack.md).
- **`config.json` is an override file, not a full config.** Only include keys you want to change from the package defaults.
- **Playwright config is framework-aware.** `init` generates port 3000 for Next.js or port 5173 for React + Vite. Edit it freely — it's not overwritten on re-init.
- **Agent resolution now falls back to the package.** Repo copies in `.claude/agents/` win when present; otherwise the package-bundled version is used.

## Rolling back

Check the tag/commit before the migration. The old layout is self-contained; reverting the commit restores it fully.
