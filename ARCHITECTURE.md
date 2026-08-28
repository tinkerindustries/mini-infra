# Architecture

This document is the bird's-eye view of Mini Infra. Read it first if you're new to the codebase. It explains what the major pieces are, where they live, and how they fit together. Subsystem-level depth lives in [server/ARCHITECTURE.md](server/ARCHITECTURE.md) and [client/ARCHITECTURE.md](client/ARCHITECTURE.md).

This file is meant to be hand-maintained. When the shape of the system changes — a new sidecar, a new top-level package, a new external dependency — update it.

## What Mini Infra is

Mini Infra is a self-hosted control plane for a single Docker host. It manages the host's containers, networks, and volumes; deploys multi-container applications with zero-downtime blue-green rollouts; runs scheduled PostgreSQL backups to Azure Blob Storage; provisions TLS certificates via Let's Encrypt; routes public traffic through HAProxy and optionally Cloudflare tunnels; enforces per-environment egress firewall policy; and exposes an optional AI assistant.

The mental model that holds the codebase together is **stacks**. A stack is a versioned, declarative bundle of services, networks, volumes, and config files with plan/apply semantics. Almost every higher-level concept — *applications*, the built-in HAProxy/Vault/Postgres/monitoring/egress services, the Cloudflare tunnel — is a stack underneath. The stack reconciler is the single chokepoint that brings desired state into being. If you understand stacks, you understand the system.

## Entry points

When you open the repo cold, these are the files to read first.

- **Server boot** — [server/src/server.ts](server/src/server.ts). The boot sequence is documented in [server/ARCHITECTURE.md](server/ARCHITECTURE.md#boot-sequence).
- **Server HTTP** — [server/src/app-factory.ts](server/src/app-factory.ts). Middleware order, route registration table, dev-vs-prod static serving.
- **Client boot** — [client/src/main.tsx](client/src/main.tsx) → [client/src/App.tsx](client/src/App.tsx) → [client/src/lib/routes.tsx](client/src/lib/routes.tsx). The router is statically defined; that file is the source of truth for what URLs exist.
- **The cross-process contract** — [lib/types/socket-events.ts](lib/types/socket-events.ts) (channels and events) and [lib/types/permissions.ts](lib/types/permissions.ts) (RBAC scopes). When client and server need to agree on something, it lives here.
- **Stack reconciliation** — [server/src/services/stacks/stack-reconciler.ts](server/src/services/stacks/stack-reconciler.ts). The chokepoint that brings every stack — built-in or user-defined — to its desired state.
- **Dev workflow** — `wt init` / `wt start`, which run the bring-up stages in [deployment/development/worktree-env.ts](deployment/development/worktree-env.ts). Spins up a per-worktree Mini Infra instance (works the same on macOS, Linux, and Windows). See [docs/wt.md](docs/wt.md).

## Code map

### `client/`

Vite + React 19 frontend. File-based routing, TanStack Query for server state, Socket.IO for real-time pushes, Radix-based component library. See [client/ARCHITECTURE.md](client/ARCHITECTURE.md).

**Invariant:** there is no other store. TanStack Query owns server state; React state owns UI state. No Redux, no Zustand.

### `server/`

Express 5 + Prisma backend. A single Node process that owns the Docker socket, talks to Postgres, Vault, Azure, Cloudflare, and the host's HAProxy data-plane API, and serves both the REST API and the Socket.IO event stream. Built TypeScript. See [server/ARCHITECTURE.md](server/ARCHITECTURE.md).

**Invariant:** exactly one process owns the Docker socket — this one. Sidecars and stack containers don't dial Docker directly; they ask the server.

### `lib/` — `@mini-infra/types` — **API Boundary**

The shared TypeScript types package consumed by both client and server. This is the only place where the two halves of the application meet at a typed contract — touch carefully. The most load-bearing files are [lib/types/socket-events.ts](lib/types/socket-events.ts) (channel and event constants — the contract for everything real-time) and [lib/types/permissions.ts](lib/types/permissions.ts) (RBAC scopes). Must be built before client or server.

**Invariant:** all real-time channel and event names live in `socket-events.ts`. There are no raw event-name strings anywhere else in the codebase.

### `acme/` — `@mini-infra/acme`

Standalone Let's Encrypt ACME client. Implements the DNS-01 challenge flow used by [server/src/services/tls/](server/src/services/tls/). Built before server.

### `update-sidecar/`

Standalone npm package built into a separate container image. Drives in-place self-update: pulls the new server image, validates it via a health-check pattern, swaps containers, and rolls back on failure. Launched by the server when an update is requested.

**Invariant:** sidecars are launched by, and only by, the server. Operators don't run them directly — that's how their lifecycle and credentials stay coherent across self-updates.

### `agent-sidecar/`

Standalone npm package built into a separate container image. Optional AI assistant — a Claude Agent SDK runtime with tools for Docker, the Mini Infra API, and the user docs. Per-user conversations stream over SSE. Launched by the server when the agent is enabled.

### `egress-gateway/`

Go service. The egress data plane. Container traffic that should be governed flows through the gateway, which enforces per-environment allow/deny rules and emits a traffic feed.

### `egress-fw-agent/`

Go sidecar. Runs alongside the gateway and applies firewall rules at the host level. Communicates with the server over a local transport — see [server/src/services/egress/fw-agent-transport.ts](server/src/services/egress/fw-agent-transport.ts).

### `egress-shared/`

Shared Go module imported by both `egress-gateway/` and `egress-fw-agent/`. Wired into the workspace via [go.work](go.work). Not part of the pnpm workspace.

### `auth-proxy/`

Standalone Go service. Per-environment reverse proxy that holds API credentials (Anthropic keys, GitHub PATs, Google Workspace OAuth refresh tokens) on behalf of application containers. Apps point their SDK at `http://auth-proxy:8080/<provider>/<tenant>/...`; the proxy strips any inbound auth headers, injects the right credential from its config, and forwards to the upstream. Built on `net/http` + `httputil.ReverseProxy` so streaming, SSE, and large bodies pass through natively. Stack-template integration and Vault-backed secrets are planned follow-ups; v1 reads `${ENV_VAR}` from a mounted YAML config. See [auth-proxy/CLAUDE.md](auth-proxy/CLAUDE.md).

**Invariant:** application containers never carry the upstream credentials — they only know the proxy URL.

### `pg-az-backup/`

Container image (Alpine + shell) that performs a single PostgreSQL backup to Azure Blob Storage. Invoked by the server's backup scheduler as a one-shot container.

### `deployment/`

Operator-facing scripts and compose files. Development bring-up is a set of stages in [deployment/development/worktree-env.ts](deployment/development/worktree-env.ts), sequenced by worktree-manager's hooks (`wt init`, `wt start`) to spin up a per-worktree isolated VM. Production deployment artifacts also live here.

### `scripts/`

Repo utilities. Notable: [scripts/generate-ui-manifest.mjs](scripts/generate-ui-manifest.mjs) (scans the client for `data-tour` attributes so the agent's `highlight_element` tool can point users at UI elements) and [scripts/top-files-by-lines.sh](scripts/top-files-by-lines.sh) (refactor target finder).

### `docs/`

User-facing operator documentation and design specs. Distinct from `client/src/user-docs/`, which is the in-app help shipped to end users.

### `claude-guidance/`

Notes and prompts for Claude Code; not consumed by the running application.

## Runtime topology

In production a Mini Infra installation looks like this:

```
                ┌─────────────────────────────┐
   browser ───▶ │       HAProxy (stack)       │ ◀── public traffic via Cloudflare tunnel (optional)
                └────────────────┬────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
     ┌──────────────────┐                  ┌─────────────────┐
     │  Mini Infra      │ ──── /var/run/docker.sock ────────┐│
     │  server (Express)│ ──── HAProxy data-plane socket ──┐││
     │  + Socket.IO     │                                  │││
     └──┬──────┬──────┬─┘                                  │││
        │      │      │                                    │││
        │      │      ▼                                    │││
        │      │   Postgres (stack)  ◀── pg-az-backup ─▶ Azure Blob
        │      │                                           │││
        │      ▼                                           │││
        │   Vault (stack)                                  │││
        │                                                  │││
        ▼                                                  │││
   sidecars (launched by server, share docker.sock):       │││
     ┌────────────────────┐                                │││
     │ agent-sidecar      │ ◀── SSE proxy                  │││
     │ update-sidecar     │ ◀── only during self-update    │││
     │ egress-fw-agent    │ ◀── firewall rule transport    │││
     └────────────────────┘                                │││
                                                          ▼▼▼
                                       managed Docker host containers
                                       (egress-gateway, monitoring,
                                        Cloudflare tunnel, user apps…)
```

Everything drawn as a "stack" — HAProxy, Postgres, Vault, monitoring (Prometheus + Grafana), the egress gateway, the Cloudflare tunnel — is reconciled through the same code path as user-deployed applications. The server is the only long-lived bespoke process; sidecars are short-lived or optional.

### External boundaries

| Boundary | What it is | Where it's wrapped |
|---|---|---|
| Docker socket | `/var/run/docker.sock` via dockerode | [server/src/services/docker.ts](server/src/services/docker.ts) (`DockerService` singleton) |
| Postgres | App database (Prisma) | [server/src/lib/prisma.ts](server/src/lib/prisma.ts) |
| Vault | HashiCorp Vault for secrets | [server/src/services/vault/](server/src/services/vault/) |
| NATS | Managed message bus (control plane + JetStream) | [server/src/services/nats/](server/src/services/nats/) |
| Cloudflare API | DNS zones, tunnels | [server/src/services/cloudflare/](server/src/services/cloudflare/) |
| Azure Blob Storage | Backups + certificates | [server/src/services/azure-storage-service.ts](server/src/services/azure-storage-service.ts) |
| Container registries | Image pulls (Hub, GHCR, etc.) | [server/src/services/registry-credential.ts](server/src/services/registry-credential.ts) + [server/src/services/docker-executor/](server/src/services/docker-executor/) |
| HAProxy data-plane | Live config without reload | [server/src/services/haproxy/haproxy-dataplane-client.ts](server/src/services/haproxy/haproxy-dataplane-client.ts) |
| ACME servers | Let's Encrypt (or staging) | [server/src/services/tls/acme-client-manager.ts](server/src/services/tls/acme-client-manager.ts) via `@mini-infra/acme` |
| GitHub | Bug reports + GitHub App auth | [server/src/services/github-service.ts](server/src/services/github-service.ts) |
| Agent sidecar | SSE proxy for chat | [server/src/services/agent-service.ts](server/src/services/agent-service.ts) |
| Egress firewall agent | Per-env rule push | [server/src/services/egress/fw-agent-transport.ts](server/src/services/egress/fw-agent-transport.ts) |

## Architectural invariants — digest

The repo-wide invariants in one place, for quick reference. Each one is restated where it applies in the code map and in the per-project docs. Breaking one is a signal that the change needs more thought, not a workaround.

- One Docker socket owner: the server. (See `server/`.)
- All Docker access through `DockerService.getInstance()`; image pulls through `DockerExecutorService.pullImageWithAutoAuth()`.
- Stacks are the only orchestration primitive. Built-in services and user apps share one code path.
- All Socket.IO channel and event names are constants in [lib/types/socket-events.ts](lib/types/socket-events.ts). No raw strings.
- All long-running operations emit `*_STARTED → *_STEP → *_COMPLETED`.
- Configuration is database-backed and audited; mutations require `userId`. No runtime env-var settings.
- Permissions are `resource:action` scopes, not roles. New code never branches on a role name.
- Client never polls when the socket is connected. `refetchOnReconnect: true` covers gaps.
- Sidecars are launched by the server, not operators.

## Cross-cutting concerns

These show up in nearly every feature. Skim them before making changes that touch more than one file.

### Socket.IO is the real-time backbone

Channels and event names are constants in [lib/types/socket-events.ts](lib/types/socket-events.ts). Use `Channel.*` and `ServerEvent.*` — never raw strings. The server emits via `emitToChannel()`; the client subscribes per-room via `useSocketChannel()` and listens via `useSocketEvent()`. Long-running operations follow a **started → step → completed** triplet; see the patterns sections of [server/ARCHITECTURE.md](server/ARCHITECTURE.md) and [client/ARCHITECTURE.md](client/ARCHITECTURE.md).

### NATS is the system-internal bus

Server↔sidecar control-plane traffic (egress firewall agent, egress gateway, future backup and self-update progress) goes over NATS through the singleton `NatsBus` ([server/src/services/nats/nats-bus.ts](server/src/services/nats/nats-bus.ts)). Subjects live under `mini-infra.>`, with constants in [lib/types/nats-subjects.ts](lib/types/nats-subjects.ts) (and a Go mirror in [egress-shared/natsbus/subjects.go](egress-shared/natsbus/subjects.go), kept in lockstep by a CI drift check). Payloads are Zod-validated on both ends. The client never subscribes to NATS — when a NATS event matters to the UI, the server bridges it to Socket.IO. See [docs/architecture/internal-messaging.md](docs/architecture/internal-messaging.md) for the full namespace, per-pair flows, and how to add a new channel.

### Task tracker for long-running ops

Operations like certificate issuance, stack apply, container connect, and HAProxy migrations report progress through a single registry-driven UI. Server emits `*_STARTED`, `*_STEP`, `*_COMPLETED`. The client maps task types to that triplet in [client/src/lib/task-type-registry.ts](client/src/lib/task-type-registry.ts), and components register tasks with `trackTask()` so progress is visible from anywhere in the app.

### Audit events

`UserEventService` ([server/src/services/user-events/](server/src/services/user-events/)) is the persistent audit log. Every user-initiated mutation that's worth showing in the events page goes through it. It also emits `EVENT_CREATED` / `EVENT_UPDATED` so the events list updates live.

### RBAC

Permissions are scope strings of the form `resource:action` defined in [lib/types/permissions.ts](lib/types/permissions.ts). API keys and users are granted scopes (or one of the Reader/Editor/Admin presets). Server middleware in [server/src/lib/permission-middleware.ts](server/src/lib/permission-middleware.ts) gates routes; the client reads the user's scopes from auth context and gates UI accordingly.

### Logging

`getLogger(component, subcomponent)` from [server/src/lib/logger-factory.ts](server/src/lib/logger-factory.ts) is the only entry point. All output is NDJSON to a single rotating file. Long-running operations carry an `operationId`; HTTP requests carry a `requestId` injected by middleware. Components are a fixed set: `http`, `auth`, `db`, `docker`, `stacks`, `deploy`, `haproxy`, `tls`, `backup`, `integrations`, `agent`, `platform`. See [server/ARCHITECTURE.md](server/ARCHITECTURE.md) for the full conventions.

### Configuration is database-backed and audited

Settings for Docker, Cloudflare, Azure, Postgres, and TLS aren't environment variables — they're rows in the database, managed through services created by `ConfigurationServiceFactory`. Every mutation requires a `userId` for the audit trail. `validate()` records connectivity status and metadata so the UI can show "Last checked 2m ago — connected".

## Build and dev topology

### Workspaces

`pnpm-workspace.yaml` declares four packages: `client`, `server`, `lib`, `acme`. The sidecars (`update-sidecar/`, `agent-sidecar/`) and Go services (`egress-gateway/`, `egress-fw-agent/`, `pg-az-backup/`) are **not** in the workspace — they're standalone packages with their own lockfiles. Don't `cd` into client/server/lib at the workspace root; use `pnpm --filter <name>`.

### Build order

`lib` (types) and `acme` compile independently, then `client` and `server` build in parallel against them. The server's production Docker image is multi-stage: types → acme → client (bundled into `server/public/`) → server → runtime image. The two npm sidecars and the Go services are built as separate images.

### Development

Each git worktree gets its own isolated Mini Infra instance running on its own VM (Colima on macOS, WSL2 on Windows). Ports, the VM name, the compose project and the egress pool are allocated by [worktree-manager](docs/wt.md) from the slot it assigns; the spec is [wt.yaml](wt.yaml). Spin up via `wt init` then `wt start`. The worktree's URL, vault URL and seeded credentials are written to `environment-details.xml` at the worktree root — read from there instead of hard-coding ports. See the root [CLAUDE.md](CLAUDE.md) for the worktree workflow.

In dev, Vite serves the client and proxies `/api`, `/auth`, and `/socket.io` to the backend. In production, Express serves the pre-built client bundle out of `server/public/`.

## Vocabulary

Mini Infra has a precise vocabulary. Get the words right and the code reads itself; mix them up and confusion compounds.

- **Container** — a Docker container on the managed host. Status: Running, Stopped, Paused, Exited, Restarting.
- **Application** — a logical UX layer over a stack. The application screens collect user inputs (image, ports, env, volumes, routing) and produce a stack definition. There is no "application" object underneath — it's always a stack.
- **Stack** — the unit of orchestration. A collection of containers, networks, volumes, and config files managed together with plan/apply semantics. Can be host-level or environment-scoped. Status: Synced, Drifted, Pending, Undeployed, Error, Removed.
- **Stack Definition** — a versioned snapshot of a stack's desired state. The reconciler diffs the latest definition against the running state to detect drift and produce a plan.
- **Stack Template** — a reusable blueprint with draft-and-publish versioning. Scoped to Host or Environment. Source: System (built-in) or User (custom).
- **Service** — an individual container definition inside a stack. Type: Stateful (stop/start replacement) or StatelessWeb (zero-downtime blue-green via HAProxy).
- **Deployment (Blue-Green)** — the release strategy for StatelessWeb services. Phases: deploy green → health check → switch traffic → drain blue → remove blue. Auto-rollback on failure.
- **Environment** — a named grouping (e.g. `production`, `staging`) with a type (production/nonproduction) and a network type: Local (Docker host only) or Internet (publicly routable via Cloudflare tunnel). Local environments still get real Let's Encrypt certificates and public DNS — don't gate TLS by network type.
- **HAProxy** — the load balancer, configured live via the Data Plane API (no reload). Key objects: Instance (running process), Frontend (listener — Manual or Shared with routes), Backend (server group with balance algorithm), Server (container endpoint).
- **PostgreSQL Backup** — scheduled or manual encrypted dumps stored in Azure Blob. Configurable cron, retention, format (custom/sql), and compression.
- **TLS Certificate** — automated SSL/TLS via ACME (Let's Encrypt). DNS-01 challenge through Cloudflare. Stored in Azure Blob. Auto-renewed 30 days before expiry.
- **Cloudflare Tunnel** — Argo Tunnel that gives an Internet-network environment public reachability without opening firewall ports.
- **Connected Service** — an external integration (Docker, Azure, Cloudflare, GitHub) with tracked connectivity status and response time.
- **DNS Zone** — a Cloudflare-managed domain. Records auto-created for ACME challenges and tunnel config.
- **Volume** — a Docker volume. Inspectable: an Alpine sidecar can scan the filesystem and serve content up to 1 MB.
- **API Key** — programmatic access token with permission scopes. Presets: Reader, Editor, Admin. Supports rotation and last-used tracking.
- **Event** — an entry in the audit log. Tracks type, status progression, trigger source, progress, user, and duration. Streams via Socket.IO.
- **Self-Update** — in-place upgrade via the update sidecar's health-check pattern. Pulls new image, validates, swaps containers. Auto-rollback on failure. Data on mounted volumes is preserved.
- **Agent Sidecar** — the optional AI assistant. Per-user conversations, SSE streaming, has tools for Docker, the Mini Infra API, and the user docs.
- **NATS** — the built-in message bus, deployed as a managed host-scoped `nats` stack. The stack declares a cross-stack `requires` on the `vault` host stack and the `vault-bootstrapped` predicate so it can only apply once Vault is up and bootstrapped. Accounts, credential profiles, JetStream streams/consumers, and the runtime config are all stored in the database and reconciled through `POST /api/nats/apply` (no NATS CLI needed). NKeys/operator keys live in Vault.
- **NATS Subject Prefix** — every stack that uses NATS lives under a subject namespace. Defaults to `app.<stack.id>` (collision-free). A non-default prefix (e.g. `events.platform`) requires an admin entry in the prefix allowlist (`/api/nats/prefix-allowlist`).
- **NATS App Role** — symbolic role on a stack template (`nats.roles[]` in the definition) that materializes into a `NatsCredentialProfile` at apply time, with the stack's subject prefix prepended to its publish/subscribe lists. Services reference it via `services[].natsRole: <name>` to get `NATS_CREDS` + `NATS_URL` injected. `_INBOX.>` is auto-injected per `inboxAuto`.
- **NATS Signer** — scoped signing key on a template (`nats.signers[]`) used for in-process JWT minting (e.g. a manager service that mints worker JWTs). The seed is delivered as `NATS_SIGNER_SEED`; the NATS server cryptographically constrains anything signed with it to the declared `subjectScope`.
- **NATS Import / Export** — cross-stack subject sharing. A producer template declares `nats.exports[]` (relative to its prefix); a consumer's `nats.imports[]` resolves at apply time against the producer's last-applied snapshot, scoped to the same environment, and grants matching subjects to the consumer roles named in `forRoles`.

## Where to next

- [server/ARCHITECTURE.md](server/ARCHITECTURE.md) — server subsystems, service patterns, boot sequence, "adding a feature" walkthrough.
- [client/ARCHITECTURE.md](client/ARCHITECTURE.md) — client layout, data fetching, socket integration, task tracker, "adding a page" walkthrough.
- [CLAUDE.md](CLAUDE.md) — project-wide instructions for Claude (and a useful reference for humans).
- [server/CLAUDE.md](server/CLAUDE.md) — the canonical service-pattern cheat-sheet. The server architecture doc summarises this; the cheat-sheet has all the do/don't tables.
- [client/CLAUDE.md](client/CLAUDE.md) — the task-tracker and data-fetching pattern reference.
- [docs/](docs/) — operator and design docs.
