---
standard: tech-stack
version: 1.0
updated:
---

# Standard: tech-stack

## How to use this file
- This is the source of truth for all technology decisions
- Coder reads this before installing any package
- Orchestrator reads this before starting any sprint
- Any new dependency must be added here before use
- Removing a dependency requires updating this file

## Frontend
<!-- Update with project specific choices -->
- Framework:
- Styling:
- State management:
- Routing:
- Forms:
- Testing:
- Build tool:

## Backend
<!-- Update with project specific choices -->
- Runtime:
- Framework:
- ORM:
- Authentication:
- API style:
- Testing:

## Database
<!-- Update with project specific choices -->
- Primary database:
- Caching:
- Search:
- File storage:

## DevOps / infrastructure
<!-- Update with project specific choices -->
- Hosting:
- CI/CD:
- Environment management:
- Monitoring:
- Error tracking:

## Approved packages
<!-- List all approved packages with version and reason -->
| Package | Version | Purpose |
|---------|---------|---------|
|         |         |         |

## Forbidden packages
<!-- Packages explicitly not allowed and why -->
| Package | Reason |
|---------|--------|
|         |        |

## Adding a new dependency
1. Check if existing approved package solves the problem first
2. Evaluate: bundle size, maintenance status, license, security
3. Add to approved packages table with version and purpose
4. Update this file before using in code
5. Flag to Architect if it is a significant architectural dependency
