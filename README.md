# @sweetlemonai/harness-ai

AI engineering pipeline — ticket to reviewed branch, with quality gates.

`harness-ai` drives Claude Code through a fixed pipeline (spec → context → build → reconcile → gates → QA → E2E → PR) and enforces tsc/eslint/vitest/storybook as hard gates. It's framework-agnostic; the same package works with React + Vite, Next.js, or any TypeScript project that owns its own `npm run dev`.

## Install

```bash
npm install -D @sweetlemonai/harness-ai
# or: pnpm add -D @sweetlemonai/harness-ai
```

Requires Node ≥ 20 and the Claude Code CLI (`npm install -g @anthropic-ai/claude-code`).

## Initialize

Run once per repo:

```bash
npx harness-ai init --framework nextjs
# or: npx harness-ai init --framework react
```

`init` creates:

```
.claude/
  CLAUDE.md              ← edit: what this project is
  context/               ← add: domain docs
  standards/
    tech-stack.md        ← fill: approved packages + versions
harness/
  config.json            ← tweak: overrides on top of package defaults
  playwright.config.ts   ← framework-aware (port 3000 or 5173)
  tasks/
.gitignore               ← appended: runs/, analytics/, config.local.json
```

Pass `--force` to overwrite existing files.

## First task

1. Write a ticket at `harness/tasks/<project>/<N>-<slug>.md` with:
   ```markdown
   ---
   type: logic
   project: <project>
   depends: []
   ---

   # Task: <title>

   ## Acceptance criteria
   - ...
   ```
2. Run it:
   ```bash
   npx harness-ai ship <project>/<N>-<slug>
   ```
   `ship` chains preflight → spec → build → gates → QA → PR end-to-end.

Useful variants:
- `harness-ai run <project>/<task> --dry-run` — print the phase plan without running.
- `harness-ai run <project>/<task> --from hardGates` — resume at a specific phase.
- `harness-ai status` — project / task state overview.
- `harness-ai debug <project>/<task> --run <runId>` — inspect prompts, outputs, logs for a past run.

### `--from` shapes

`--from` accepts three forms on both `ship` and `run`:

- `--from <phase>` — single-task mode. Re-run the named task from `<phase>`. Example: `harness ship my-project/2-foo --resume --from build`.
- `--from <task>` — project mode. Skip earlier tasks, start at `<task>` from its first incomplete phase, then continue with the rest. Example: `harness ship my-project --resume --from 2-foo` (numeric shorthand `--from 2` also works).
- `--from <task>/<phase>` — project mode. Skip earlier tasks, resume `<task>` at `<phase>`, then continue. Example: `harness ship my-project --resume --from 2-foo/build`.

A bare `--from <phase>` in project mode is ambiguous when the project has more than one task; the harness prints the three corrected syntaxes. It auto-scopes (with a warning) when the project has exactly one task.

## Resolution order for `.claude/` assets

| Asset | Order |
|---|---|
| `agents/<file>.md` | repo `.claude/agents/` → package defaults → error |
| `skills/<file>.md` | repo → package defaults → error |
| `standards/*.md`, `context/*.md` | merged; repo wins on filename conflict |
| `CLAUDE.md`, `standards/tech-stack.md` | repo only; required |
| `config.json` | package defaults ← overlaid by `harness/config.json` ← overlaid by `harness/config.local.json` |

Drop a file at `.claude/agents/spec.agent.md` in your repo to override the packaged spec agent. Remove it to fall back to the default.

## Configuration

`harness/config.json` is an override file, not a full config. Only include keys you want to change:

```json
{
  "retries": { "agent": 3, "reconcile": 2 },
  "git": { "createPR": true }
}
```

Package defaults live at `node_modules/@sweetlemonai/harness-ai/defaults/config.json`. Schema is enforced by ajv — unknown keys fail validation. Keys starting with `_` are treated as comments and stripped before validation.

`harness/config.local.json` overlays on top of `harness/config.json` and is gitignored — use it for machine-specific overrides.

### Most commonly tuned knobs

- `retries.agent` — how many times to retry a failed coding-agent invocation before escalating. Default 2.
- `retries.gate` — how many auto-fix rounds the harness runs against hard-gate failures (tsc/eslint/vitest/storybook) before escalating. Default 3.
- `retries.e2e` — how many times to retry failing Playwright specs before escalating. Default 2.
- `retries.reconcile` — how many times to try fixing after the reconciliation agent reports a contradiction. Default 2. Set higher for flaky agents, lower (e.g. 0) to escalate immediately without any self-repair.

## Migrating from LemonHarness

See [MIGRATION.md](./MIGRATION.md).

## License

MIT
