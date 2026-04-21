---
standard: coding
version: 1.0
updated:
---

# Standard: coding

## General principles
- Clarity over cleverness — code is read more than it is written
- Simple over complex — if it needs a comment to explain it, simplify it
- Consistent over personal preference — follow the standard, not your style
- Explicit over implicit — never rely on side effects or magic
- Small functions — one function does one thing
- No dead code — if it is not used, delete it
- No commented out code — use version control instead

## Naming conventions
- Variables and functions: camelCase
- Components and classes: PascalCase
- Constants: SCREAMING_SNAKE_CASE
- Files: kebab-case
- Database tables and columns: snake_case
- Boolean variables: prefix with is, has, can, should
- Event handlers: prefix with handle or on
- Names must be descriptive — no single letters except loop counters

## File structure
- One component or class per file
- Group by feature not by type
- Index files for public exports only
- Keep files under 300 lines — if longer, split it
- Related files stay together

## Functions and modules
- Maximum 20 lines per function — if longer, extract
- Maximum 3 parameters — if more, use an object
- Always return early on error conditions
- No nested callbacks — use async/await
- Pure functions where possible — no side effects
- Never mutate function parameters

## Error handling
- Never swallow errors silently
- Always handle promise rejections
- User-facing errors must have clear human readable messages
- Log errors with enough context to debug
- Never expose internal error details to users
- Validate all inputs at the boundary

## Comments and documentation
- Code should be self-documenting — comments explain why not what
- Public APIs must have JSDoc or equivalent
- Complex algorithms need an explanation comment
- TODO comments must include a ticket or story reference
- Never leave console.log in production code

## Forbidden patterns
- No any type in TypeScript
- No == use === always
- No var use const or let
- No magic numbers — use named constants
- No deep nesting — maximum 3 levels
- No global state mutations
- No hardcoded URLs, keys or credentials
- No direct DOM manipulation in components
