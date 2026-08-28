# Mini Infra - Claude Code Context

Important: When making changes, if we are on main branch, switch to a branch. All changes should not go into main unless the user specifically mentions they want the changes on main.

All changes should be submitted as PRs when they are ready.

## Planning Guidelines

After the first round of exploration and planning try to do more exploration for flow on effects.

When designing the solution make sure you pick a DRY and well though out solution to reduce duplication and keep the code base maintainable.

## Worktree Development Workflow

For parallel dev work, each git worktree runs its own fully isolated Mini Infra instance on its own VM. This is the default flow — use it instead of fighting over a single dev daemon when you have multiple WIPs in flight. The VM driver is auto-selected per platform: **Colima** on macOS, **WSL2** on Windows. Override via the `MINI_INFRA_DRIVER` env var (`colima` or `wsl`).

Allocation is owned by [worktree-manager](docs/wt.md) — the `wt` CLI. It hands each worktree a slot and, from that slot, the ten host ports, the VM name, the compose project and the egress address pool. This repo's own bring-up lives in [deployment/development/](deployment/development/) and is driven entirely from that allocation; it decides nothing itself. The spec is [wt.yaml](wt.yaml) at the repo root.

**First run on a machine:** reserve this repo's port band once with `wt bands reserve --base ui=9200 --base registry=9210 --base vault=9220 --base docker=9230 --base haproxy_http=9240 --base haproxy_https=9250 --base haproxy_stats=9260 --base haproxy_dataplane=9270 --base nats_client=9280 --base nats_monitor=9290`. The band is machine-local, so a fresh clone needs it and an existing one does not.

**Windows users:** before your first run, build the cached Alpine + dockerd base tarball with `.\scripts\build-wsl-base.ps1` (one-time). See [docs/user/wsl2-reference.md](docs/user/wsl2-reference.md) for full detail.

1. **Create the worktree.** Claude Code's `WorktreeCreate` hook does this, or by hand: `git worktree add "$(wt spec path --slug <slug>)" -b claude/<slug>`. Worktrees live at `.claude/worktrees/<slug>`.

2. **Spin up.** From the worktree root, run `pnpm install`, then `wt init --description "<short summary of what this worktree is for>"` followed by `wt start`. `init` allocates the slot, creates the VM, writes `wt-env.yaml` and the managed block in `.env`, and runs the bring-up hooks; `start` re-runs the bring-up hooks on their own. Both are idempotent — re-running repairs.

   **Seed profile.** Pass `--param seed_profile=minimal` to `wt init` to skip the vault+nats stack, the egress-fw-agent stack, the local environment (and thus the egress-gateway), and the HAProxy stack — useful when you're working on parts of the app that don't need any of those. The default is `full`, which seeds everything. The choice is sticky: worktree-manager records it in `wt-env.yaml` and later runs reuse it.

3. **Find the URL.** `wt show` prints this worktree's allocation; `wt show --json` is the machine-readable form. The seeder also writes `environment-details.xml` at the worktree root with the UI URL, Vault URL, Docker host, admin credentials, seeded resource IDs and connected-service status — that file is where the credentials live, and the skills read it. Ports are `<base> + <slot>`, so slot 3's UI is 9203, its registry 9213, its vault 9223, and so on: every port for a given slot ends in the slot digit.

4. **Edit code normally.** The `server/` / `client/` / `lib/` layout and workspace rules below still apply.

5. **Rebuild after changes.** Re-run `wt start`. The VM stays up, images rebuild, containers recreate, and the seeder skips an already-seeded instance.

6. **Test.** Use the `test-dev` or `diagnose-dev` skills; both resolve the URL from `environment-details.xml` automatically.

7. **List everything.** `wt list` shows every worktree across every adopted repo on this machine; `wt doctor` reports anything broken and names the command that fixes it.

8. **Tear down this worktree.** `wt rm --slug <slug>` runs the safety checks, tears the stack down, deletes the VM, frees the slot and removes the git worktree in one shot. This repo refuses removal on uncommitted changes, unpushed commits **and** an open PR, so `gh` must be installed and authenticated. To bypass entirely: `colima delete mini-infra-<slug>-<slot> --data --force` on macOS, or `wsl --unregister mini-infra-<slug>-<slot>` on Windows.

9. **Bulk cleanup.** `wt cleanup --dry-run` previews which merged-PR worktrees would be swept; drop `--dry-run` to act. The coordinator also sweeps on its own schedule. Both require a merged pull request regardless of the `removal:` policy above.

The stages the hooks run are `pnpm worktree-env <stage>` — `provision`, `prepull`, `build`, `up`, `seed`, `health`, plus `status` and `down`. You rarely invoke them directly; `wt init` and `wt start` sequence them with the allocation in the environment.

Run `git` commands from inside the worktree directory, not the main checkout — mixing shells between the two is the main way commits land on the wrong branch.

See [docs/wt.md](docs/wt.md) for the worktree-manager reference, [docs/user/colima-reference.md](docs/user/colima-reference.md) for Colima detail (macOS) or [docs/user/wsl2-reference.md](docs/user/wsl2-reference.md) for WSL2 detail (Windows).

## Browser Automation & Testing

For browser automation and browser testing tasks, use the Playwright CLI skill defined in `.claude/skills/playwright-cli/SKILL.md`. This skill provides browser interaction capabilities including navigation, form filling, screenshots, and web testing.

When opening the site in playwright, read the current dev UI URL from `environment-details.xml` at the project root rather than hardcoding a port — each worktree instance listens on a different host port:

```bash
MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
playwright-cli open --persistent "$MINI_INFRA_URL"
```

## Important Instructions

* Always resolve the frontend/backend URL via `environment-details.xml` (see above) instead of hardcoding a localhost port — Vite proxies client traffic to the backend through whichever port the current worktree instance is bound to.
* **Package manager is pnpm** (pinned in `package.json` via the `packageManager` field). On a fresh checkout run `corepack enable` once, then `pnpm install`. Don't use `npm install` at the repo root — it will fight with the pnpm lockfile.
* **Fresh worktree? Run `pnpm install` first — always, before anything else.** Worktrees do not share `node_modules` with the main checkout. This applies to **every** `pnpm` command in a fresh worktree, including the `pnpm worktree-env <stage>` commands `wt` runs as hooks (they go through `tsx`, which lives in `node_modules` — without it you'll see `sh: tsx: command not found` and `Local package.json exists, but node_modules missing`). `wt init` runs `pnpm install` itself in its provision stage, but only after the VM is up, so install first when running anything by hand. Same goes for `pnpm build`, `pnpm --filter ... test`, `pnpm --filter ... lint`, etc. If `node_modules/` is missing at the worktree root (or you see `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` / `tsc: command not found`), run `pnpm install` from the worktree root before retrying. Also run `npm install` inside `update-sidecar/` and `agent-sidecar/` before invoking their test or build scripts.
* **Always run commands from the project root**. Never `cd` into `client/`, `server/`, or `lib/` subdirectories. Use `--filter <workspace>` flags instead (e.g., `pnpm --filter mini-infra-server test`).
* **Sidecar folders are NOT in the pnpm workspace and still use npm.** `update-sidecar/` and `agent-sidecar/` are standalone packages with their own `package-lock.json` — you must `cd` into them to run npm commands (e.g., `cd agent-sidecar && npm test`), then `cd` back to the project root afterwards.
* When a change is made for the local dev environment rebuild the containers — run `wt start` from the worktree root. It re-runs the build, up, seed and health hooks against this worktree's existing allocation.

## Project Overview

Mini Infra is a web application designed to manage a single Docker host and its associated infrastructure. It provides centralized management for Docker containers, PostgreSQL database backups, zero-downtime deployments using HAProxy, and Cloudflare tunnel monitoring.

### Key Concepts

- **Container** — a Docker container on the managed host. Status: Running, Stopped, Paused, Exited, Restarting.
- **Application** — a logical concept that provides a simplified UX for managing services. Under the hood, an application is just a stack. The application layer handles creating the stack definition from user inputs (image, ports, env vars, volumes, routing) and exposes deploy/update/stop actions. All actual container orchestration happens at the stack level.
- **Stack** — a collection of containers and supporting infrastructure (networks, volumes, config files) managed as a single unit with plan/apply semantics. Can be host-level or environment-scoped. Status: Synced, Drifted, Pending, Undeployed, Error, Removed.
- **Stack Definition** — a versioned snapshot of a stack's desired state. Compared against running containers to detect drift and generate plans. Tracks latest version, running version, and lastAppliedSnapshot.
- **Stack Template** — a reusable blueprint for stacks with draft-and-publish versioning. Scoped to Host or Environment. Source: System (built-in) or User (custom).
- **Service** — an individual container definition within a stack. Type: Stateful (stop/start replacement) or StatelessWeb (zero-downtime blue-green via HAProxy).
- **Deployment (Blue-Green)** — zero-downtime release strategy. Blue = current containers, Green = new release. Phases: deploy green → health check → switch traffic → drain blue → remove blue. Auto-rollback on failure.
- **Environment** — a named grouping (e.g., production, staging) with a type (production/nonproduction) and network type: Local (Docker host only) or Internet (publicly routable via Cloudflare tunnel).
- **HAProxy** — load balancer configured via Data Plane API (no reload needed). Key objects: Instance (running process), Frontend (listener — Manual or Shared with routes), Backend (server group with balance algorithm), Server (container endpoint).
- **PostgreSQL Backup** — scheduled or manual encrypted database backups stored in Azure Blob Storage. Configurable cron, retention, format (custom/sql), and compression.
- **TLS Certificate** — automated SSL/TLS via ACME (Let's Encrypt). DNS-01 challenge via Cloudflare. Stored in Azure Blob Storage. Auto-renewed 30 days before expiry. Status: Pending, Active, Renewing, Expired, Error.
- **Cloudflare Tunnel** — Argo Tunnel providing public internet access without open firewall ports. Linked to internet-type environments via UUID and service URL.
- **Connected Service** — external integration (Docker, Azure Storage, Cloudflare, GitHub) with connectivity status tracking (connected/failed/timeout/unreachable) and response time.
- **DNS Zone** — Cloudflare-managed domain. Records can be proxied or DNS-only. Auto-created for ACME challenges and tunnel config.
- **Volume** — Docker volume with optional inspection (Alpine container scans filesystem, catalogs files, supports content retrieval up to 1 MB).
- **Docker Network** — bridge-driver network for container communication. Environment-scoped networks use `{environment}-{purpose}` naming.
- **API Key** — programmatic access token with permission scopes (`resource:action`). Presets: Reader, Editor, Admin. Supports rotation and last-used tracking.
- **Event** — audit log entry for long-running operations. Tracks type, category, status progression, trigger source, progress, user, and duration. Streams via Socket.IO.
- **Self-Update** — in-place upgrade via sidecar health-check pattern. Pulls new image, validates, swaps containers. Auto-rollback on failure. Data preserved on mounted volumes.
- **Agent Sidecar** — optional AI operations assistant in a separate container. Natural language interface to Docker, Mini Infra API, and docs. Per-user conversations with SSE streaming.
- **NATS** — built-in message bus, deployed as a managed host-scoped `nats` stack. Requires a synced `vault` host stack with the `vault-bootstrapped` predicate true (the `nats.conf` and account JWTs are read from Vault KV at container start). Accounts, credential profiles, JetStream streams/consumers, and runtime config are DB-backed and reconciled via `POST /api/nats/apply`. NKeys/operator keys live in Vault.
- **NATS App Role** — symbolic role on a stack template (`nats.roles[]`) that materializes into a `NatsCredentialProfile` at apply time. Subject prefix (`nats.subjectPrefix`, default `app.<stack.id>`) is prepended to publish/subscribe; `_INBOX.>` auto-injected per `inboxAuto`. Services bind via `services[].natsRole: <name>` → injects `NATS_CREDS` + `NATS_URL`.
- **NATS Signer** — scoped signing key (`nats.signers[]`) for in-process JWT minting; delivered as `NATS_SIGNER_SEED`. Constrained to a declared `subjectScope` sub-tree.
- **NATS Subject Prefix Allowlist** — admin-only allowlist (CRUD-per-entry at `/api/nats/prefix-allowlist`) that gates which templates may claim non-default subject prefixes. Wildcards, `$SYS.*`, and subject-tree overlaps are rejected at write time.
- **NATS Import / Export** — cross-stack subject sharing via `nats.exports[]` / `nats.imports[]`. Imports resolve at apply time against the producer's last-applied snapshot, scoped to the same environment, and are bound to specific consumer roles via `forRoles`.

## Project Structure

```
mini-infra/
├── client/                # Vite + React 19 frontend application
├── server/                # Express.js 5 + Prisma backend
├── lib/                   # Shared TypeScript types (@mini-infra/types)
├── acme/                  # ACME / Let's Encrypt client library
├── update-sidecar/        # Self-update sidecar container (mini-infra-sidecar)
├── agent-sidecar/         # AI agent sidecar container (mini-infra-agent-sidecar)
├── egress-gateway/        # Egress firewall gateway container
├── egress-fw-agent/       # Egress firewall agent container
├── egress-shared/         # Shared code for egress gateway/agent
├── pg-az-backup/          # PostgreSQL Azure backup container
├── deployment/            # Deployment configurations
├── scripts/               # Utility scripts (see below)
├── docs/                  # Project documentation and specs
├── claude-guidance/       # Claude Code guidance files
├── .claude/               # Claude Code configuration
├── package.json           # Root workspace configuration
├── pnpm-workspace.yaml    # pnpm workspace packages + overrides
└── .npmrc                 # pnpm settings (hoisted linker, peer deps, etc.)
```

### Utility Scripts (`scripts/`)
- `generate-ui-manifest.mjs` — Scans `client/src/` for `data-tour` attributes and generates `client/src/user-docs/ui-elements/manifest.json`, mapping UI element IDs to routes for the AI agent's `highlight_element` tool. Run via `pnpm generate:ui-manifest`.
- `top-files-by-lines.sh` — Lists the top N files of a given extension by line count. Usage: `./scripts/top-files-by-lines.sh ts 20`

## Shared Types Architecture

The project uses a centralized shared types package (`@mini-infra/types`) that provides TypeScript definitions shared between the client and server applications.

### Build Dependencies
- **Build Order**: lib must compile before client/server builds
- **Scripts**: `build:lib` → `build:client` / `build:server`
- **Watch Mode**: All three services run in parallel during development
- **Type Safety**: Ensures consistent type definitions across full-stack
- **Testing**: The shared types package must be built (`pnpm build:lib`) before running tests, otherwise type imports will fail

## Socket.IO Conventions

Note: Socket IO is not required for the self patching or updating feature.

### Client-Side Data Fetching
- **No polling when socket is connected.** Rely on socket events to invalidate TanStack Query caches. Set `refetchInterval` to `false` when connected, fall back to polling only when disconnected.
- **Use `refetchOnReconnect: true`** so data refreshes automatically after a socket reconnect (covers any events missed during disconnection).
- **Use `useSocketChannel()`** to subscribe/unsubscribe to a channel on mount/unmount, and **`useSocketEvent()`** to listen for events and invalidate queries.
- See `client/src/hooks/useContainers.ts` for the reference pattern.

### Server-Side Emission
- **Emitters are standalone functions** (e.g., `emitConnectivityStatus()`) that query the DB and call `emitToChannel()`. Follow the pattern in `server/src/services/container-socket-emitter.ts`.
- **Wrap emission calls in try/catch** so failures never break the caller (schedulers, executors, route handlers).
- **Extract shared logic** (e.g., health calculators) into separate modules so both REST routes and socket emitters can reuse them.
- **Event types and channel constants** are defined in `lib/types/socket-events.ts` — always use `Channel.*` and `ServerEvent.*` constants, never raw strings.

### Task Tracker for Long-Running Operations
- Long-running operations (certificate issuance, container connect, stack deploys, container removal, HAProxy migrations) are tracked via a **global task tracker** in the frontend.
- The tracker lives in `client/src/components/task-tracker/` with a context provider (`TaskTrackerProvider`), popover UI (`TaskTrackerPopover`), and detail dialog (`TaskDetailDialog`).
- Each task type is defined in the **task type registry** (`client/src/lib/task-type-registry.ts`) which maps task types to labels, icons, step definitions, and Socket.IO channel/event bindings.
- To add a new tracked task type: add an entry to the registry in `task-type-registry.ts` and call `trackTask()` from the relevant dialog/hook.
- The tracker subscribes to Socket.IO events to show live step-by-step progress and persists task state across navigation.

## Key Commands

### Root Project (pnpm workspaces)
- `pnpm install` - Install all workspace dependencies (replaces `npm install`)
- `pnpm dev` - Start all services: lib watch + acme watch + server + client
- `pnpm build` - Build server, then client (production build for frontend)
- `pnpm build:all` - Build lib, acme, then client, server, sidecar, agent-sidecar, and egress-gateway in parallel
- `pnpm build:lib` - Build shared types package only
- `pnpm build:server` - Build lib + acme + server
- `pnpm build:sidecar` - Build self-update sidecar (npm under the hood — sidecars are standalone)
- `pnpm build:agent-sidecar` - Build AI agent sidecar (npm under the hood — sidecars are standalone)

### Frontend (client/) — run from project root
- `pnpm --filter mini-infra-client dev` - Start development server (Vite)
- `pnpm --filter mini-infra-client build` - Build for production
- `pnpm --filter mini-infra-client test` - Run tests (when tests exist)
- `pnpm --filter mini-infra-client lint` - Run linting

### Backend (server/) — run from project root
- `pnpm --filter mini-infra-server dev` - Start development server with hot reload (tsx watch)
- `pnpm --filter mini-infra-server build` - Build TypeScript to JavaScript
- `pnpm --filter mini-infra-server start` - Start production server
- `pnpm --filter mini-infra-server test` - Run Vitest `unit` + `integration` projects (default; no live external services required)
- `pnpm --filter mini-infra-server test:watch` - Run `unit` + `integration` in watch mode
- `pnpm --filter mini-infra-server test:coverage` - Run `unit` + `integration` with coverage report
- `pnpm --filter mini-infra-server test:nats` - Run only NATS `*.external.test.ts` files (requires a live NATS server reachable on `/healthz`)
- `pnpm --filter mini-infra-server test:external` - Run the full `external-integration` project (NATS externals + the haproxy data-plane integration test; requires the corresponding live services)
- `pnpm --filter mini-infra-server test:all` - Run every project including externals (CI-style full run)
- `pnpm --filter mini-infra-server exec vitest run <filename>` - Run a single test file (e.g., `pnpm --filter mini-infra-server exec vitest run src/__tests__/environment-manager.test.ts`)
- `pnpm --filter mini-infra-server lint` - Run ESLint on TypeScript files
- `pnpm --filter mini-infra-server lint:fix` - Run ESLint with auto-fix
- `pnpm --filter mini-infra-server format` - Format code with Prettier
- `pnpm --filter mini-infra-server format:check` - Check code formatting

### Self-Update Sidecar (update-sidecar/) — standalone, uses npm
- `cd update-sidecar && npm install && npm run build`
- `cd update-sidecar && npm test`

### Agent Sidecar (agent-sidecar/) — standalone, uses npm
- `cd agent-sidecar && npm install && npm run build`
- `cd agent-sidecar && npm test`

### Shared Types (lib/) — run from project root
- `pnpm --filter @mini-infra/types dev` - TypeScript watch mode (auto-recompile on changes)
- `pnpm --filter @mini-infra/types build` - Compile TypeScript to JavaScript + declarations
- `pnpm --filter @mini-infra/types clean` - Remove dist/ build output

### Database — run from project root
- `pnpm --filter mini-infra-server exec prisma migrate dev --name <description>` - Create and apply new migration (use this after schema changes)
- `pnpm --filter mini-infra-server exec prisma generate` - Regenerate Prisma client after schema changes
- `pnpm --filter mini-infra-server exec prisma migrate status` - Check migration status and detect drift
- `pnpm --filter mini-infra-server exec prisma migrate resolve --applied <migration_name>` - Mark an existing migration as applied (useful when fixing drift)

## Critical Coding Patterns

These are the most commonly missed patterns. See `server/CLAUDE.md` for the full service guide.

* **Never use raw `docker.pull()`** — always use `DockerExecutorService.pullImageWithAutoAuth()` which handles registry credential lookup, authentication, and token refresh automatically.
* **Never create Docker clients directly** — use `DockerService.getInstance()` (singleton with caching, event streaming, and timeout protection).
* **Never use raw dockerode calls** — use `DockerService` wrappers (e.g., `listContainers()`, `getContainer()`) which add caching, error handling, and sensitive label redaction.
* **Always use `ConfigurationServiceFactory`** to create config services — never instantiate `DockerConfigService`, `AzureStorageService`, etc. directly.
* **All configuration mutations require `userId`** for audit trail — `set()`, `delete()`, and `create()` methods all track who made the change.
* **Use `Channel.*` and `ServerEvent.*` constants** for Socket.IO — never use raw strings for event names or channels.
* In typescript avoid the use of any. This is OK to clean up later but its good to have strongly typed variables.
# --- managed by wt; edits below are overwritten ---
# wt-field: app=mini-infra
# wt-field: band docker=9230
# wt-field: band haproxy_dataplane=9270
# wt-field: band haproxy_http=9240
# wt-field: band haproxy_https=9250
# wt-field: band haproxy_stats=9260
# wt-field: band nats_client=9280
# wt-field: band nats_monitor=9290
# wt-field: band registry=9210
# wt-field: band ui=9200
# wt-field: band vault=9220
# wt-field: descriptor=wt-env.yaml
# wt-field: resources=ui, registry, vault, docker, haproxy_http, haproxy_https, haproxy_stats, haproxy_dataplane, nats_client, nats_monitor, vm, egress
# wt-field: shared={home}/.mini-infra/dev.env, {home}/.mini-infra/wsl-base.tar, the Cloudflare zone named by dev.env's CLOUDFLARE_API_TOKEN, the Azure Blob Storage account named by dev.env's AZURE_STORAGE_CONNECTION_STRING
# wt-field: worktrees=.claude/worktrees/{slug}
This repository uses per-worktree environments.
- Never hardcode a port or a path: read them with `wt show`.
- Something else creates the worktree; `wt init` attaches to it.
See docs/wt.md for the full reference.
# --- end ---
