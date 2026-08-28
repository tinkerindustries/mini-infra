---
name: finish-worktree
description: Tears down a finished agent worktree — `cd`s back to the repo root and runs `wt rm --slug <slug>`, which runs the safety checks, tears the stack down, deletes the per-worktree VM, frees the slot and removes the git worktree in one shot. The remote branch is left untouched (the PR points at it). Takes the worktree slug as the argument (e.g. `/finish-worktree tunnel-retry`). This skill can be invoked manually after any worktree-based flow finishes — ad-hoc bugfixes, design exploration, anything where the worktree's purpose is over and the slot should be freed for the next run. Use this skill whenever the user says "finish worktree", "clean up worktree", "tear down worktree", "remove worktree", "done with worktree", "delete worktree <slug>", "wrap up the <slug> worktree", or any equivalent ask to dispose of a finished worktree. Do **not** trigger when there's still active work in the worktree, when the PR hasn't been opened yet, or when the run failed — leaving the worktree alive is the right answer in those cases. `wt rm` refuses on uncommitted changes, unpushed commits and an open PR, and this skill stops and asks rather than working around a refusal.
---

# Finish Worktree

This is a **cleanup skill**, not an execution agent. It disposes of a finished agent worktree and frees its slot.

Once the PR is open and review has moved to GitHub, the worktree is dead weight — it holds a whole Colima VM (or WSL2 distro) and one of only four slots. This skill removes it.

The remote branch is **left alone** — that's where the PR points.

The safety checks are not this skill's job. `wt rm` runs them, and [wt.yaml](../../../wt.yaml)'s `removal:` block sets all three to refuse for this repository: uncommitted changes, unpushed commits, and an open PR each stop the removal. A refusal exits 3, and **a refusal is a stop-and-ask, never something to work around**.

## Arguments

- **`<slug>`** — the worktree slug (e.g. `tunnel-retry`). Lowercase it. Accepts surrounding text containing the slug.

If no argument is supplied, **stop and ask**. Never auto-pick "the most recent worktree" — that's the guess that ends with someone's WIP deleted.

---

## Phase 1 — Resolve the target

Normalise the argument to a slug (`pick up tunnel-retry please` → `tunnel-retry`), then confirm it exists:

```bash
wt list
```

If the slug isn't there, check `git worktree list` too: a directory with no registry entry means a previous cleanup got half-done. Say which half is missing rather than guessing.

---

## Phase 2 — Tear down

Run from the **repo root**, not the worktree — you can't remove the tree you're standing in:

```bash
wt rm --slug <slug>
```

That one command runs the safety checks, tears the compose stack down, deletes the VM, deallocates the slot in the coordinator and runs `git worktree remove`.

Read the exit code:

- **0** — done. Report it.
- **3** — a check refused. The output names which one. **Stop and show the user.** Do not pass `--force`; the refusal is this repository's policy and the user decides whether to override it.
- **4** — a check could not run, almost always `gh` missing or unauthenticated. Say so and stop; this repo's policy makes `gh` a hard requirement for removal.

If the user explicitly tells you to override a refusal after seeing it, `wt rm --slug <slug> --force` is the documented way. That's their call to make, not yours to pre-empt.

---

## Phase 3 — Report

```
✓ Removed worktree <slug> — VM deleted, slot freed, directory gone.
  Branch claude/<slug> remains on the remote (PR points at it).
```

If review feedback later needs changes on the same branch, the worktree can be recreated from it:

```bash
git fetch origin claude/<slug>
git worktree add "$(wt spec path --slug <slug>)" claude/<slug>
cd "$(wt spec path --slug <slug>)" && pnpm install && wt init --description "<what this is for>"
```

Mention that only if it seems relevant.

---

## Hard rules

- **Never run cleanup on a failure path.** If the smoke failed, the PR didn't open, or the user is mid-investigation, leave the worktree alive.
- **Never work around a refusal.** Exit 3 means a check fired. Show it and ask; don't reach for `--force` on your own judgment.
- **Never delete the remote branch.** The PR points at it.
- **Never run `wt rm` from inside the worktree.** `cd` to the repo root first.
- **Never auto-pick a worktree to delete.** The skill needs an explicit slug.
- **Never produce an ExitPlanMode block.** This is a cleanup skill, not a planning skill.

---

## Example

> User: `/finish-worktree tunnel-retry`
>
> *Skill normalises to `tunnel-retry`, confirms it in `wt list`, `cd`s to the repo root and runs `wt rm --slug tunnel-retry`. Exit 0.*
>
> Skill: "✓ Removed worktree `tunnel-retry` — VM deleted, slot freed, directory gone. Branch `claude/tunnel-retry` remains on the remote (PR #412 points at it)."

> User: `/finish-worktree docs-fix`
>
> *`wt rm --slug docs-fix` exits 3: "uncommitted changes in the worktree".*
>
> Skill: "`wt rm` refused — `docs-fix` has uncommitted changes. This repo's policy refuses on that rather than warning. Do you want to salvage them first, or override with `--force`?"
