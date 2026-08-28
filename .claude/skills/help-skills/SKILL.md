---
name: help-skills
description: Explains the standard Mini Infra workflow and which skill to reach for at each step — brainstorm → plan → code → review → ship — plus the worktree and diagnostic helpers that wrap around it. Use this skill whenever the user asks "what's the workflow", "which skill do I use for X", "how do I work on a feature/task", "what skills do I have", "remind me of the flow", "help me with skills", "what's next", "where am I in the process", or any equivalent ask for a workflow refresher or a pointer to the right skill. Also use it when the user is mid-flow and seems unsure which skill comes next (e.g. they just finished a review and ask "now what?"). Do **not** trigger for questions about Claude Code itself (slash commands, hooks, MCP) — those go to claude-code-guide — and do **not** trigger when the user has already named the specific skill they want to run.
---

# Help — Skills Workflow

This skill is a **map**, not an executor. It tells the user (or you) which skill to reach for at each step of the standard Mini Infra workflow. When in doubt, print the relevant section verbatim — the user is asking for a reminder, not a re-derivation.

Work isn't tracked in an external ticket system — the plan doc (if there is one) and the PR are the record. The workflow has two entry points (planned features vs. one-off work) that converge on the same worktree → code → review → ship loop.

---

## The standard flow

```
                  ┌─ planned feature ──────────────────┐
                  │                                     │
  brainstorming ──▶ brainstorm-to-plan ──▶ phased plan doc
                                                         │
                  ┌─ one-off task ──────────────────────┤
                  │                                     │
                  │                                     ▼
                  │                             setup-worktree
                  │                                     │
                  │                                     ▼
                  │                              (write the code)
                  │                                     │
                  │                                     ▼
                  │                                  review  (loop until clean)
                  │                                     │
                  │                                     ▼
                  │                        gh pr merge  (ship it)
                  │
                  └─ wrapping the active task: finish-worktree
                                                diagnose-dev (when something's broken in the worktree)
```

---

## Step-by-step — when to use which skill

### 1. Planning a feature (multi-phase work)

- **`brainstorming`** — open-ended ideation. Optional; just chatting to Claude works too. Use this when the shape of the work isn't clear yet.
- **`brainstorm-to-plan`** — turns the brainstorm (a scratch markdown file or in-conversation notes) into a phased planning document under `docs/planning/not-shipped/`. This is the bridge from "vibes" to concrete, sequenced work. Each phase is scoped to ship as one PR.

For a one-off task (a bugfix, a small chore, anything that doesn't need a phased plan), skip straight to setting up a worktree.

### 2. Working a task

- **`setup-worktree`** — scaffolds a fresh git worktree from main with `pnpm install` and a backgrounded `wt init`. Use it for any isolated piece of work, whether it's one phase of a plan or an ad-hoc fix.
- Write the code, run the relevant build/lint/unit tests, and smoke-test with `test-dev` (see below) before opening a PR.

### 3. Review loop

- **`review`** — independent code review of a GitHub PR. Pulls the diff, checks bugs / security / convention violations / duplication, and posts a severity-tagged comment on the PR. Accepts a PR number, a branch name, or no argument (reviews the current branch's open PR).

Loop — fix the findings, push, `/review` again — until the review is clean.

### 4. Shipping

- Once the review is clean, merge the PR yourself (`gh pr merge` or the GitHub UI). There's no dedicated ship skill — merging a reviewed PR is a deliberate, low-frequency action best done explicitly rather than automated.

---

## Wrapping skills (used during a task)

These wrap around the worktree/code/review loop rather than being a workflow step in their own right:

- **`finish-worktree`** — tears down a finished worktree: deletes the per-worktree VM/distro and removes the worktree dir. Run this **after** the PR is merged, never before — and never when the work is unfinished. The remote branch is left alone (already merged or the PR points at it).
- **`test-dev`** — runs a set of tests against the current worktree's dev environment using `playwright-cli`. Use it to smoke-test a feature before opening a PR, or any time the user asks for the change to be exercised in the running stack. Tracks issues found and reports them at the end; stops early on a show-stopper.
- **`diagnose-dev`** — diagnoses issues in the dev environment running on a worktree. Trigger when the user mentions something is broken "in dev" — don't use it for production issues.

---

## General tooling skills

These aren't workflow steps — they're general-purpose tools reached for as needed, usually around a PR:

- **`playwright-cli`** — browser automation: navigation, form filling, screenshots, web testing, data extraction. `test-dev` builds on top of it; reach for it directly for ad-hoc browser interactions or one-off scraping/automation tasks.
- **`api-change-check`** — checks whether docs, permission definitions, and registrations are in sync with the current branch's changes before opening a PR.
- **`refactor-large-file`** — finds and refactors the codebase's largest TypeScript files.

---

## Quick decision tree

When the user asks "what do I do next?", figure out where they are:

| Where they are | What to suggest |
|---|---|
| Has an idea, no shape yet | `brainstorming` (or just chat), then `brainstorm-to-plan` |
| Has a plan doc or a one-off task, ready to code | `setup-worktree` |
| Code written, ready for a PR | Open the PR, then `review` |
| Review posted with findings | Fix them by hand, push, `/review` again |
| Review is clean | Merge the PR (`gh pr merge`) |
| PR merged, worktree still around | `finish-worktree` |
| Something's broken in the worktree | `diagnose-dev` |

---

## Notes

- The skill list above is curated — these are the skills that form the **normal workflow** plus the general tooling that supports it. Other skills exist (e.g. `update-ui-artifacts`, `generate-docs-structure`, `task-tracker-audit`) but they're either auxiliary or used opportunistically rather than as steps in the standard flow. Don't list them unless the user asks about them specifically.
- If the user asks about a skill that isn't in this map, read its `SKILL.md` from `.claude/skills/<name>/SKILL.md` rather than guessing.
- Keep responses focused on what the user actually asked. If they ask "how do I ship?", just describe merging the PR and the immediate prerequisites — don't dump the whole flow on them.
