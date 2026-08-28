# Mini Infra - Development Deployment

This folder contains the per-worktree development workflow for running a fully isolated Mini Infra instance locally — one VM, one set of containers, one set of ports per git worktree.

The legacy single-instance flow (`start.sh`/`docker-compose.yaml`) has been removed; the worktree flow is now the only supported path.

Allocation is owned by [worktree-manager](../../docs/wt.md). It hands each worktree a slot and, from that slot, the ten host ports, the VM name, the compose project and the egress address pool; the spec is [wt.yaml](../../wt.yaml) at the repo root. Everything in this folder reads that allocation and decides nothing itself.

## Quick Start

From the worktree root (works on macOS, Linux, and Windows — same commands everywhere):

```bash
pnpm install
wt init --description "<short summary>"
```

On macOS the VM is Colima; on Windows it is WSL2 (first run also needs `scripts/build-wsl-base.ps1`).

`wt init` allocates the slot and runs every bring-up stage. Later re-runs are `wt start`, which re-runs the stages against the existing allocation. Both are idempotent.

Between them they:

1. Create the per-worktree VM (Colima profile on macOS, WSL2 distro on Windows) — worktree-manager's machine driver.
2. Resolve the ten host ports, the compose project and the egress /22 from the slot, and export them to every stage.
3. Build and push the **agent sidecar**, **egress gateway**, and **egress firewall agent** images to the per-worktree local Docker registry.
4. Build the **main app** image with those image tags baked in as build args.
5. Run `docker compose up` against `docker-compose.worktree.yaml` to bring up `registry` and `mini-infra`. The agent sidecar and the egress firewall agent are launched at runtime by the `mini-infra` server itself (not by compose), so they do not appear as compose services.
6. Seed credentials from `~/.mini-infra/dev.env` and write `environment-details.xml` at the worktree root with the URL, admin login, and seeded resource IDs. The allocation itself is in `wt-env.yaml` beside it, and in the managed block of `.env`.

## Architecture

The compose file brings up two containers per worktree, in the compose project worktree-manager allocated (`mini-infra-<slug>-<slot>`):

| Container | Purpose | Port |
|-----------|---------|------|
| `<project>-registry-1` | Per-worktree local Docker registry | 9210 + slot |
| `<project>-mini-infra-1` | Main Mini Infra application | 9200 + slot |

Two more containers are spawned at runtime by the server inside that VM:

| Container | Purpose | Notes |
|-----------|---------|-------|
| `mini-infra-agent-sidecar` | AI agent sidecar | Created by `ensureAgentSidecar()` on boot |
| `mini-infra-egress-fw-agent` | Host firewall agent (network_mode: host, NET_ADMIN/NET_RAW, mounts `/var/run/mini-infra` + `/lib/modules`) | Created by `ensureFwAgent()` on boot |

Both runtime sidecars are managed end-to-end by `mini-infra-server`: pull image, create, start, health-check, restart on demand via the UI. Their image tags are baked into the main image at build time via `AGENT_SIDECAR_IMAGE_TAG` and `EGRESS_FW_AGENT_IMAGE_TAG`, with database settings (`agent-sidecar.image`, `egress-fw-agent.image`) able to override at runtime.

## Common Commands

Lifecycle is `wt`, run from the worktree root:

```bash
# Bring up / rebuild
wt start

# This worktree's allocation
wt show

# Every worktree on this machine, across every adopted repo
wt list

# Tear down: safety checks, stack down, VM deleted, slot freed, tree removed
wt rm --slug <slug>

# Sweep merged-PR worktrees
wt cleanup --dry-run

# What is broken, and the command that fixes each thing
wt doctor
```

The individual stages are available directly when you want to re-run one:

```bash
pnpm worktree-env provision   # VM ready, host deps synced       (install hook)
pnpm worktree-env prepull     # registry up, base images pulled  (prepull hook)
pnpm worktree-env build       # sidecar images, then the app     (build hook)
pnpm worktree-env up          # compose up, wait for healthy     (start hook)
pnpm worktree-env seed        # seed the instance via its API    (seed hook)
pnpm worktree-env health      # probe /health                    (health hook)

pnpm worktree-env status              # print this worktree's endpoints
pnpm worktree-env seed --force        # re-seed an already-seeded instance
pnpm worktree-env down --volumes      # stop and destroy the data, keep the VM
```

And the endpoints, read back from the manifest the seeder wrote:

```bash
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
NATS_CLIENT_URL=$(xmllint --xpath 'string(//environment/endpoints/natsClient)' environment-details.xml)
NATS_MONITOR_URL=$(xmllint --xpath 'string(//environment/endpoints/natsMonitor)' environment-details.xml)
```

Run `pnpm worktree-env help` for the stage list and `wt help` for the lifecycle verbs.

### Logging

The console shows status-only output: completed milestones, warnings, and errors. The full progress chatter (every step the seeder is about to take, every "already done" skip) is appended to `deployment/development/worktree-env.log` (capped at ~200 KB, trimmed in place). Tail it when you want detail:

```bash
tail -f deployment/development/worktree-env.log
```

Set `WORKTREE_ENV_VERBOSE=1` in front of `wt init` / `wt start` (or a direct stage invocation) to mirror the verbose chatter to the console.

## When to use this vs `pnpm dev`

| Scenario | Worktree flow | `pnpm dev` |
|----------|---------------|------------|
| Testing Docker builds, agent sidecar, egress firewall agent | ✅ Yes | ❌ No |
| Validating docker-compose configuration changes | ✅ Yes | ❌ No |
| Testing in production-like environment | ✅ Yes | ❌ No |
| Rapid code iteration with hot reload | ❌ No | ✅ Yes |
