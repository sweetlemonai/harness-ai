---
standard: file-format
version: 1.0
updated:
---

# Standard: file-format

## Rules
- Every .claude/ file written by PO or Orchestrator must have YAML frontmatter
- Frontmatter must be the first thing in the file
- Markdown structure must be consistent and follow section templates below
- All files must be both human-readable and machine-parseable
- Never remove or rename frontmatter fields — only add new ones
- Dates use ISO format: YYYY-MM-DD
- Status values are always lowercase
- Arrays use YAML list format

## Frontmatter requirements
- Every file must have: type or standard or agent, version, updated
- Sprint files must have all required sprint fields (see below)
- Version increments when structure changes, not on content updates

## Required fields per file type

### PROJECT.md
```yaml
---
project:
status: active | paused | complete
created: YYYY-MM-DD
updated: YYYY-MM-DD
current_sprint: 01
current_phase: 1
phases_total: 3
---
```

### backlog.md
```yaml
---
type: backlog
updated: YYYY-MM-DD
items_total: 0
---
```

### memory.md
```yaml
---
type: memory
version: 1.0
updated: YYYY-MM-DD
---
```

### Sprint plan
```yaml
---
sprint: 01
type: plan
status: draft | active | complete
created: YYYY-MM-DD
updated: YYYY-MM-DD
created_by: product-owner
stories_total: 0
stories_done: 0
stories_blocked: 0
stories_carried_over: 0
agents_used: []
---
```

### Sprint log
```yaml
---
sprint: 01
type: log
updated: YYYY-MM-DD
---
```

### Sprint decisions
```yaml
---
sprint: 01
type: decisions
updated: YYYY-MM-DD
decisions_total: 0
---
```

### Sprint blockers
```yaml
---
sprint: 01
type: blockers
updated: YYYY-MM-DD
blockers_total: 0
blockers_resolved: 0
---
```

### Sprint review
```yaml
---
sprint: 01
type: review
status: pending | complete
start_date: YYYY-MM-DD
end_date: YYYY-MM-DD
velocity: 0
stories_completed: 0
stories_carried_over: 0
human_approved: false
---
```

## Markdown structure conventions

### Decisions entry format
```markdown
## YYYY-MM-DD — [decision title]
**Context:** Why this decision was needed
**Decision:** What was decided
**Why:** Reasoning
**Impact:** What this affects
```

### Blockers entry format
```markdown
## YYYY-MM-DD — [blocker title]
**Description:** What is blocked and why
**Status:** blocked | in progress | resolved
**Resolution:** How it was resolved (when resolved)
```

### Log entry format
```markdown
## YYYY-MM-DD HH:MM — [action]
**Agent:** which agent
**Story:** which story
**Action:** what was done
**Output:** result or finding
```

### Story format in plan.md
```markdown
## STORY-XX — [title]
**Description:** What needs to be built
**Acceptance criteria:**
- [ ] criterion one
- [ ] criterion two
**Complexity:** S | M | L
**Dependencies:** STORY-XX or none
**Agents:** suggested agents (optional)
**Status:** todo | in progress | done | blocked | carried over
```

## Machine readability rules
- Frontmatter fields are the source of truth for dashboards
- Keep field names snake_case
- Boolean values are true or false — never yes/no
- Never put machine-read values in markdown body — frontmatter only
- Arrays must always be valid YAML even when empty: []
