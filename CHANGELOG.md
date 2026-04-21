# Changelog

All notable changes to `@sweetlemonai/harness-ai` are recorded here.
This project follows Semantic Versioning.

## 0.3.0 — 2026-04-21

### Added
- `retries.reconcile` config key. Default 2. Previously hardcoded at 1;
  reconcile phase now retries fix attempts up to this budget before
  escalating.
- `--from <task>` and `--from <task>/<phase>` syntax in project mode.
  Single-task mode's `--from <phase>` continues to work unchanged.
- Auto-fix for the "export default X + export { X }" double-export
  pattern during the build phase's export alignment check.
- `build_auto_fix` events in analytics for each auto-fix applied.

### Changed
- Escalation hint in single-task runs now shows the correct single-task
  resume command first (`ship <project>/<task> --resume --from <phase>`)
  with the project-mode alternative listed second.

### Fixed
- Reconcile phase no longer escalates after a single failed fix attempt.
  See `retries.reconcile` for configuration.

### Migration notes
- Existing `config.json` files without `retries.reconcile` pick up the
  default of 2 automatically. No user action required.
- Projects using `--from <phase>` in project mode previously got an
  error. They now get an error only when the project has multiple
  tasks; single-task projects auto-scope with a warning.
