---
standard: git
version: 1.0
updated:
---

# Standard: git

## Branch naming
- Features: feature/STORY-XX-short-description
- Bugs: fix/STORY-XX-short-description
- Sprint branches: sprint/sprint-XX
- Hotfixes: hotfix/short-description
- All lowercase, hyphens only, no spaces

## Commit format
```
type(scope): short description

Optional longer description if needed.

Story: STORY-XX
```

## Commit types
- feat: new feature
- fix: bug fix
- style: UI or copy changes, no logic change
- refactor: code change with no feature or fix
- test: adding or updating tests
- chore: build, deps, config changes
- docs: documentation only

## Commit message rules
- Subject line maximum 72 characters
- Subject line does not end with a period
- Use imperative mood — "add feature" not "added feature"
- Reference story in every commit
- One logical change per commit — do not bundle unrelated changes
- Never commit broken code
- Never commit with failing tests
- Never commit secrets, tokens or passwords

## PR rules
- Every sprint closes with a PR from sprint branch to main
- PR title: Sprint XX — brief summary of what was built
- PR description must include:
  - Sprint goal
  - Stories completed
  - Stories carried over and why
  - Test results summary
  - Deployment notes if any
- PR must have passing CI before merge
- DevOps agent creates the PR — never merge without review

## Merge strategy
- Squash and merge for feature branches into sprint branch
- Merge commit for sprint branch into main — preserve sprint history
- Never force push to main or sprint branches
- Delete feature branches after merge

## What never gets committed
- .env files
- node_modules
- Build output
- Editor config files (.vscode, .idea)
- OS files (.DS_Store)
- secrets or credentials of any kind
