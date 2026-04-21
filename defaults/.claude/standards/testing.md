---
standard: testing
version: 1.0
updated:
---

# Standard: testing

## Philosophy
Tests are not optional. They are part of the definition of done.
A story without tests is not done. Tests are written by the coder
and verified by QA. Both have different responsibilities.

## Types of tests

### Unit tests
- Test one function or component in isolation
- No real network calls, database or file system
- Fast — must run in milliseconds
- Written by coder alongside the code

### Integration tests
- Test how multiple units work together
- May use a test database
- Test API endpoints end to end
- Written by coder for critical paths

### E2E tests
- Test full user flows in a real browser
- Written for critical user journeys only
- Run in CI before every merge

### Accessibility tests
- Run automated a11y checks on every UI component
- Part of QA verify phase — not optional

## Coverage expectations
- Unit tests: all business logic and utility functions
- Integration tests: all API endpoints and critical data flows
- E2E tests: all primary user journeys
- No coverage percentage target — test what matters, not everything

## Tools
<!-- Update with project specific tools when known -->
- Unit and integration: 
- E2E: 
- Accessibility: 
- Coverage reporting: 

## How to run
```bash
npm run test          # unit and integration tests
npm run test:e2e      # end to end tests
npm run test:a11y     # accessibility tests
npm run test:coverage # coverage report
```

## What must always be tested
- All business logic
- All API endpoints
- All form validation
- All error states
- All authentication and authorisation paths
- All payment flows
- All critical user journeys

## What not to test
- Third party library internals
- Simple getters and setters with no logic
- Pure UI layout with no behaviour
- Generated code

## CI enforcement
- All tests run on every PR
- Failing tests block merge
- E2E tests run on merge to main before deploy
