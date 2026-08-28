---
name: setup-worktree
description: Sets up a fresh git worktree — pre-flights main, pulls latest, creates the worktree at the path `wt spec path` gives, runs `pnpm install`, and (by default) kicks off `wt init` in the background to allocate the slot and warm the dev VM. Takes an optional short slug as the argument (e.g. `/setup-worktree tunnel-retry`); when omitted, generates a random `adjective-animal` slug (e.g. `swift-otter`). Pass `--no-env` to skip the dev-env spin-up — useful for docs-only changes or when the caller doesn't need a running stack. This skill is a reusable worktree-prep step for other flows (ad-hoc bugfix sessions, design-doc PR flows) and can be called directly by the user when they want a worktree without a full execute-end-to-end loop. Use this skill whenever the user says "set up a worktree", "create a worktree", "spin up a worktree", "new worktree for X", "make me a worktree", or any equivalent ask to scaffold a fresh agent worktree from main. Do **not** trigger when the user is already inside a worktree and wants to keep working there.
---

# Setup Worktree

This is a **scaffolding skill**, not an execution agent. It gets a fresh worktree from `main` ready for work, then hands control back to the caller. It does **not** do code changes or open PRs.

It allocates nothing itself. worktree-manager owns the slot, the ports, the VM name, the compose project and the egress pool — see [docs/wt.md](../../../docs/wt.md) and [wt.yaml](../../../wt.yaml). This skill only does the repo-specific things around `wt init`: the pre-flight on main, the worktree creation, and getting `pnpm install` to run before anything that needs `tsx`.

## Arguments

- **`<slug>`** (optional) — a short kebab-case name for this worktree (e.g. `tunnel-retry`). Lowercased and sanitised to `[a-z0-9-]`. **When omitted**, generate a random `adjective-animal` slug (e.g. `swift-otter`, `bold-lynx`).
- **`--no-env`** (optional) — skip Phase 4 (the `wt init` warm-up). Use it when the change is docs-only or the caller explicitly doesn't want a running dev stack.
- **`--description "<short summary>"`** (optional) — pass-through to `wt init`, which requires one.

---

## Phase 1 — Pre-flight on main

Start at the **main checkout root**, on `main`, with a clean tree:

```bash
pwd && git rev-parse --abbrev-ref HEAD && git status --short
```

Required state:

- **`pwd` is the repo root**, not under `.claude/worktrees/`.
- **Branch is the repo's default** (usually `main`; confirm with `git symbolic-ref refs/remotes/origin/HEAD --short` if unsure).
- **Working tree is clean.**

If any of these fail, **stop with a clear message**. Don't auto-stash, auto-checkout, or guess — the user's WIP elsewhere matters more than this skill's convenience.

Then update main:

```bash
git pull --ff-only origin main
```

`--ff-only` means a stale local main with non-pushed commits surfaces as an error rather than being silently merged. If it fails, stop and tell the user.

---

## Phase 2 — Create the worktree

Derive the slug, then ask worktree-manager where the tree goes rather than hardcoding the path:

```bash
wt spec path --slug <slug>
```

That resolves this repository's `worktrees.path` — today `.claude/worktrees/<slug>`. Use whatever it prints.

Branch: `claude/<slug>` — namespaces it as agent-created, matching the other `claude/...` branches.

Before creating, **collision-check** the chosen slug:

```bash
ls "$(wt spec path --slug <slug>)" 2>/dev/null
git rev-parse --verify --quiet refs/heads/claude/<slug>
```

If either exists:

- **Random slug**: silently regenerate and re-check, up to ~3 attempts, then stop and ask.
- **User-supplied slug**: stop and ask. Don't auto-resume someone else's worktree and don't reuse a stale branch silently. `wt rm --slug <slug>` is the cleanup; or the user may want to `cd` into the existing worktree and continue.

Create it off the freshly-pulled main:

```bash
git worktree add "$(wt spec path --slug <slug>)" -b claude/<slug>
```

`cd` into it for the rest of the skill.

---

## Phase 3 — Install dependencies

Fresh worktrees do not share `node_modules` with the main checkout:

```bash
pnpm install
```

This must finish before Phase 4: `wt init` runs the repo's hooks, and those go through `tsx`, which lives in `node_modules`. Run it synchronously.

If `pnpm install` fails, stop and surface the output. Don't paper over it with `--force` or `--shamefully-hoist`.

---

## Phase 4 — Allocate and warm the environment (skip if `--no-env`)

If the caller passed `--no-env`, **skip this phase entirely** and say so.

Otherwise run `wt init` in the background with the `Bash` tool's `run_in_background: true`. It allocates the slot, creates the VM and runs the bring-up hooks; the first run takes several minutes because the VM is cold.

```bash
wt init --description "<short summary, ≤10 words>"
```

Pick the description in this order:

1. If the caller passed `--description "..."`, use it verbatim.
2. Otherwise, prompt the user once for a ≤10-word description.

Add `--param seed_profile=minimal` when the work needs no vault, NATS, egress or HAProxy — it is sticky, so later runs reuse it.

Don't wait for it. `wt init` is idempotent, and re-running it repairs a partial bring-up.

---

## Phase 5 — Report and hand back

State the result:

- Worktree path and branch
- `pnpm install` status
- Env: backgrounded *(or "skipped — `--no-env`")*
- Current working directory

Once `wt init` finishes, `wt show` prints the allocation and the seeder's `environment-details.xml` carries the credentials.

---

## Hard rules

- **Never run on a dirty tree or a non-default branch.** Phase 1 stops; don't auto-stash or auto-checkout.
- **Never reuse an existing worktree directory or branch silently.** Stop and ask. The cleanup is `wt rm --slug <slug>`.
- **Never hardcode a worktree path or a port.** Ask `wt spec path` for the path and `wt show` for the ports.
- **Never skip `pnpm install`**, and never run it after `wt init` — the hooks need it first.
- **Never wait for `wt init` synchronously.** It takes minutes; backgrounding is the point.
- **Never produce an ExitPlanMode block.** This is a scaffolding skill, not a planning skill.

---

## Example

> User: `/setup-worktree tunnel-retry`
>
> *Repo root, on `main`, clean. `git pull --ff-only origin main` — already up to date.*
>
> *`wt spec path --slug tunnel-retry` → `.claude/worktrees/tunnel-retry`. No collision.*
>
> *`git worktree add .claude/worktrees/tunnel-retry -b claude/tunnel-retry`, then `cd` into it.*
>
> *`pnpm install` synchronously. Done in 12s.*
>
> *No `--description` passed, so prompt: "What's this worktree for? (≤10 words)". User answers "tunnel reconciler retry budget".*
>
> *`wt init --description "tunnel reconciler retry budget"` in the background.*
>
> Skill: "Worktree ready at `.claude/worktrees/tunnel-retry` on branch `claude/tunnel-retry`. `pnpm install` done. `wt init` warming the environment in the background. Working directory is the worktree."
