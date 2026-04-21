---
standard: lint
version: 1.0
updated:
---

# Standard: lint

## Philosophy
Linting is not optional. It runs before every commit and in CI.
A failing lint is a failing build. No exceptions.

## Tools
<!-- Update with project specific tools when known -->
- **ESLint** — JavaScript and TypeScript linting
- **Prettier** — code formatting
- **Stylelint** — CSS and style linting
- **TypeScript** — type checking (if applicable)

## How to run
```bash
npm run lint        # run all linters
npm run lint:fix    # auto-fix where possible
npm run typecheck   # TypeScript type check
```

## Configuration
- Config files live at project root
- Never disable lint rules inline without a comment explaining why
- Never use eslint-disable-next-line without a story or reason
- Prettier config is the source of truth for formatting — 
  do not fight it

## Rules
- Lint must pass before any commit
- Lint must pass in CI before any merge
- Auto-fixable issues must be fixed — not ignored
- Non-auto-fixable issues must be resolved in code
- New lint rule exceptions require a comment with justification

## CI enforcement
- Lint runs on every PR
- Failing lint blocks merge
- Lint config changes require Architect review
