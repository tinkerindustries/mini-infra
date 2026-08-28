---
name: test-dev
description: Using the playwright-cli for browser automation, test features that are requested for testing by the user. Tracks issues found during testing and reports them all at the end. Stops early if a show-stopper is encountered.
---

# UI Feature Testing

You're running UI tests against a live instance of Mini Infra — a Docker host management web app. Use the playwright-cli skill to drive the browser. The app is a test system so credentials can be shared freely.

## Environment

- Look for the existence of `environment-details.xml`.
- If absent run `wt start` to bring the environment up; the seeder writes `environment-details.xml` with all the details required. If `wt start` reports the worktree is not initialised, run `wt init --description "<what this worktree is for>"` first.
- Read from `environment-details.xml` at the project root — each worktree instance uses its own host port. Grab it once up front:

  ```bash
  MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
  ```

- **Named browser session** — multiple worktrees run concurrently and all share the same playwright-cli daemon. The default session (`default`) is shared, so two worktrees will fight over the same browser. Always derive a session name from the worktree profile and pass `-s=<SESSION>` to every `playwright-cli` command:

  ```bash
  # Derive once at the top of the test run — use the port number (short, unique per worktree)
  # Session names must be short alphanumeric strings; hyphens cause socket-path errors.
  UI_PORT=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml 2>/dev/null | grep -oE '[0-9]+$')
  SESSION="p${UI_PORT:-3005}"

  # Then use it on every playwright-cli call
  playwright-cli -s="$SESSION" open "$MINI_INFRA_URL"
  playwright-cli -s="$SESSION" goto "$MINI_INFRA_URL/applications"
  playwright-cli -s="$SESSION" snapshot
  playwright-cli -s="$SESSION" click e5
  # etc.
  ```

  Note: when using `-s`, element refs (e14, e17…) come from snapshots taken in **that same session** — refs from a different session won't work.

- **Login credentials**: read from `environment-details.xml` — do not hardcode them:

  ```bash
  ADMIN_EMAIL=$(xmllint --xpath 'string(//environment/admin/email)' environment-details.xml)
  ADMIN_PASSWORD=$(xmllint --xpath 'string(//environment/admin/password)' environment-details.xml)
  ```

- **Source code**: available in the current working directory

- **Worktree purpose**: optionally recorded in `environment-details.xml` — read it to understand the job this environment was created for:
  ```bash
  xmllint --xpath 'string(//environment/description/short)' environment-details.xml
  xmllint --xpath 'string(//environment/description/long)'  environment-details.xml
  ```

---

## Testing Workflow

### Step 1 — Understand what to test

If the user hasn't specified, ask:
- What feature or area should be tested?
- Are there specific scenarios, edge cases, or flows they want covered?
- Any known issues to watch for?

### Step 2 — Plan test cases

Before opening the browser, write out the test cases you intend to run:
- Happy path (normal expected flow)
- Edge cases (empty states, boundary values, long inputs)
- Error states (invalid inputs, missing data, failed actions)
- Navigation and UI state (page loads, transitions, back/forward)

### Step 3 — Open a browser and log in

```bash
playwright-cli -s="$SESSION" open "$MINI_INFRA_URL"
```

If redirected to `/login`, fill in credentials and submit:

```bash
playwright-cli -s="$SESSION" fill e14 "$ADMIN_EMAIL"
playwright-cli -s="$SESSION" fill e17 "$ADMIN_PASSWORD"
playwright-cli -s="$SESSION" click e18
```

> If login itself fails, this is a **BLOCKER** — log it and stop.

### Step 4 — Execute test cases

Work through each planned test case. After each significant interaction:
- Take a snapshot (`playwright-cli -s="$SESSION" snapshot`) to inspect DOM state and get element refs
- Take a screenshot if you want to capture visual state

**Async data caveat**: Pages that fetch data via React Query render empty first, then populate. After navigation or an action that triggers a data fetch, wait for a specific element that signals the content has loaded before snapshotting:

```bash
playwright-cli -s="$SESSION" run-code "async page => { await page.waitForSelector('.card', { timeout: 5000 }); }"
```

To find the right selector, take a snapshot after the data loads (or take a screenshot), identify an element in the loaded content, then use its class or text. Example — waiting for a server card to appear:

```bash
playwright-cli -s="$SESSION" run-code "async page => { await page.waitForSelector('text=healthy', { timeout: 5000 }); }"
```

> **Avoid `waitForLoadState('networkidle')`** in SPAs — React apps make ongoing background requests so the network never fully settles, which causes hangs and timeouts.

**Clicking specificity**: Always re-snapshot before clicking to get fresh refs. Avoid clicking container refs that span multiple buttons (e.g., a footer containing both Cancel and Save) — target the specific button ref instead to avoid ambiguous clicks.

For each issue found, immediately log it (see Issue Tracking below).

**When you hit a BLOCKER**: log it, then skip straight to Step 5 — do not attempt further test cases.

### Step 5 — Report all issues

At the end of testing (or when a BLOCKER forces an early stop), output a full test report:

```
## Test Report — <Feature/Area Name>

### Summary
- Test cases planned: N
- Test cases completed: N
- Issues found: N (X blockers, Y major, Z minor)
- Status: PASSED / FAILED / BLOCKED

### Issues

#### [BLOCKER] Issue title
- **Where**: Page or component
- **Steps**: 1. Do X → 2. Do Y → 3. Observe Z
- **Expected**: What should happen
- **Actual**: What actually happened

#### [MAJOR] Issue title
...

#### [MINOR] Issue title
...

### Test Cases Completed
- [x] Happy path: <description> — PASS / FAIL
- [x] Edge case: <description> — PASS / FAIL
- [ ] <description> — SKIPPED (blocked by above)
```

---

## Issue Tracking

Track issues as you find them. Do not wait until the end to log — note each one inline as testing proceeds so nothing is missed.

### Severity Levels

| Severity | When to use | Effect on testing |
|---|---|---|
| **BLOCKER** | Feature completely broken, app crashes, can't navigate, auth failure | Stop testing immediately |
| **MAJOR** | Feature produces wrong results, data not saved, action fails | Log and continue if possible |
| **MINOR** | UI glitch, cosmetic issue, minor misbehaviour, confusing copy | Log and continue |

---

## Playwright Tips

```bash
# Derive session name once (at the top of your test run)
UI_PORT=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml 2>/dev/null | grep -oE '[0-9]+$')
SESSION="p${UI_PORT:-3005}"

# Open browser (use named session to avoid clashes with other worktrees)
playwright-cli -s="$SESSION" open "$MINI_INFRA_URL"

# Navigate (always use full URL — relative paths fail)
playwright-cli -s="$SESSION" goto "$MINI_INFRA_URL/some/path"

# Inspect the page (always do this before clicking to find refs)
playwright-cli -s="$SESSION" snapshot

# Interact
playwright-cli -s="$SESSION" click e5
playwright-cli -s="$SESSION" fill e7 "some value"
playwright-cli -s="$SESSION" press Enter
playwright-cli -s="$SESSION" select e9 "option-value"

# Verify
playwright-cli -s="$SESSION" eval "document.title"
playwright-cli -s="$SESSION" eval "el => el.textContent" e5

# Capture state (always save screenshots to the screenshots/ folder in the project root)
playwright-cli -s="$SESSION" screenshot --filename=screenshots/issue-1.png

# Close when done
playwright-cli -s="$SESSION" close
```

---

## Scope — Testing Only

**This skill is for testing and reporting only. Do not make any code or configuration changes.**

- Log issues as findings — do not fix them during the test run
- Do not edit source files, configuration, or database records to work around issues
- Do not invoke API endpoints to patch or create data unless it is strictly necessary to complete a test case (e.g. seeding required data with no UI path)
- If a workaround is needed to proceed past a missing UI, note it clearly in the report
- All fixes should be left to the user to initiate after reviewing the report

---

## Notes

- Keep the browser session open throughout the test run — reuse it for all test cases.
- If the app is unresponsive or broken beyond recovery, `playwright-cli -s="$SESSION" close` and report a BLOCKER.
- Screenshots are useful evidence for BLOCKER and MAJOR issues — attach them to the report. Always save screenshots to `screenshots/` in the project root (e.g. `screenshots/issue-1.png`).
- Source code is available if you need to check what behaviour is intended (`client/src/pages/`, `client/src/components/`).
