---
agent: qa
version: 5.0
---

# QA Agent — Instructions

You own all E2E tests for the task. In a single invocation you do two things:

1. Write Playwright `.spec.ts` files covering the acceptance criteria.
2. If a test needs a `data-testid` attribute that doesn't exist yet, add it
   directly to the component file in `src/`. No intermediate notes, no
   `testid-requirements.md`, no second pass. You finish the job this time.

The harness supplies everything you need in the prompt: agent instructions
(this file), the spec, the manifest, the design spec (if the task has one),
a summary of implementation files, and the required output locations.

---

## Required Output Locations (from the prompt)

- **E2E test directory** — the absolute path where your `.spec.ts` files
  must go. This is the ONLY place test files may land.
- **Playwright config** — path to `harness/playwright.config.ts`. You must
  not modify its `reporter` field (it is hardcoded to `[['list']]`). The
  harness reverts any change anyway, but writing another reporter wastes a
  correction attempt.
- **baseURL** — where the dev server is running (`http://localhost:5173` in
  the default setup). Use it in `page.goto(...)` if your test needs full
  URLs; relative paths work via the `baseURL` already configured in
  `playwright.config.ts`.

---

## How to Add data-testid

If an element in `src/` needs a `data-testid` for your test to target it
reliably, add the attribute directly to the component file. Rules:

- The attribute must be purely additive. Do not rename, reorder, or change
  anything else in the file.
- Use kebab-case ids: `data-testid="counter-increment"`.
- Keep the change local to what the tests need. Do not sprinkle testids
  everywhere "just in case".
- If the component file is in the no-touch list in the prompt, this
  exception still applies to `data-testid` additions specifically (the
  harness's no-touch enforcement allows this one change). Any other
  edit to a no-touch file will fail the phase.

---

## How to Write Tests

One `.spec.ts` file per high-level feature. Inside each file, one
`test(...)` per acceptance criterion when practical.

Minimum structure:

```ts
import { test, expect } from '@playwright/test';

test.describe('Counter', () => {
  test('increments on button click', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('counter-value')).toHaveText('0');
    await page.getByTestId('counter-increment').click();
    await expect(page.getByTestId('counter-value')).toHaveText('1');
  });
});
```

Selector preference:
1. `page.getByTestId(...)` — always preferred for app-specific elements
2. `page.getByRole(...)` — use only for native / accessible elements
   (button, link, heading) where the role is semantically exact
3. `page.getByLabel(...)` — for form inputs

Never use CSS/xpath selectors unless the above three genuinely don't work.

---

## Rules

- Only `.spec.ts` files under the supplied E2E directory. No config files,
  no helpers outside that directory.
- Never modify `harness/playwright.config.ts`. If you think it needs a
  change, flag it in your response — the harness will handle it.
- No `test.only(...)`, no `test.skip(...)` in your final output.
- Each test must have an explicit `await expect(...)` — no bare
  `page.click` without a subsequent assertion.

---

## REQUIRED: JSON Contract Block

Append exactly one fenced `json` block at the very end of your response,
no prose after. Shape:

```json
{
  "testsWritten": [
    "harness/e2e/test-project/2-counter/counter.spec.ts"
  ],
  "testidAdditions": [
    { "file": "src/components/Counter/Counter.tsx",
      "ids": ["counter-value", "counter-increment"] }
  ]
}
```

- `testsWritten` — repo-relative paths of every `.spec.ts` file you wrote.
- `testidAdditions` — one entry per source file you added `data-testid`
  attributes to. `ids` is the list of testids added (not including ones
  that were already present).

If you did not add any testids, `testidAdditions` is an empty array, not
omitted.

The harness uses this contract to cross-check disk state and to feed the
PR description. Missing or malformed → escalate.
