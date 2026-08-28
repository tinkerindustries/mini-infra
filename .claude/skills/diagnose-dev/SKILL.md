---
name: diagnose-dev
description: Diagnose and debug issues in the Mini Infra development environment running in Docker. Use this skill when the user mentions "dev", "dev environment", "in dev", or "development" alongside a bug report or issue description. Triggers include things like "in dev, X is broken", "getting an error in dev when I...", "the dev environment is showing...", "something's wrong in dev with...", or any description of incorrect behavior that references the dev environment. Do NOT trigger for production issues or when the user doesn't mention dev.
---

# Diagnose Development Environment Issues

You're debugging a running instance of Mini Infra — a Docker host management web app. The app is running in Docker on the local machine and you have full access to its logs, API, and source code.

## Environment

- **App URL**: read from `environment-details.xml` at the project root so you're not pinned to a stale port. Grab it once up front and reuse it:

  ```bash
  MINI_INFRA_URL=$(xmllint --xpath 'string(//environment/endpoints/ui)' environment-details.xml)
  ```

  If `environment-details.xml` is absent the environment has not been seeded. Run `wt show` to confirm the worktree is initialised, then `wt start` to bring it up; `wt show --json` gives the allocated ports on their own.
- **Container name**: `mini-infra-dev`
- **Docker Compose file**: `deployment/development/docker-compose.yaml`
- **Source code**: available in the current working directory

Read the API key from `environment-details.xml` at the project root (`//admin/apiKey`). If the file is absent or the element is empty, ask the user for the key.

- **Worktree purpose**: optionally recorded in `environment-details.xml` — read it to understand the job this environment was created for:
  ```bash
  xmllint --xpath 'string(//environment/description/short)' environment-details.xml
  xmllint --xpath 'string(//environment/description/long)'  environment-details.xml
  ```

## Diagnosis Workflow

### 1. Understand the problem

Ask the user:
- What they observed vs what they expected
- Whether they can reproduce it and how
- What part of the app is affected (containers, deployments, backups, tunnels, stacks, etc.)

### 2. Gather evidence

Based on what area is affected, pull the relevant information. Don't dump everything — pick the logs and endpoints that matter for the reported issue.

#### Reading logs

All server logs go to a **single NDJSON file** inside the dev container at `/app/server/logs/app.<N>.log` (rotated daily + on size by `pino-roll`; highest `<N>` is the most recent). Every line carries `component`, `subcomponent`, and — when inside an HTTP request or long-running operation — `requestId` / `userId` / `operationId`. Filter by those structured fields rather than by filename.

```bash
# Find the most recent log file
docker exec mini-infra-dev ls -t /app/server/logs/app.*.log | head -1

# Tail it pretty-printed through jq
docker exec mini-infra-dev sh -c 'tail -200 $(ls -t /app/server/logs/app.*.log | head -1)' \
  | jq -c '{t:.time, lvl:.level, c:.component, s:.subcomponent, m:.msg, r:.requestId, op:.operationId}'

# All errors anywhere
docker exec mini-infra-dev sh -c 'grep -h "\"level\":\"error\"" /app/server/logs/app.*.log' | jq -c .

# Everything from one component
docker exec mini-infra-dev sh -c 'grep -h "\"component\":\"tls\"" /app/server/logs/app.*.log' | jq -c .

# One subcomponent (narrower)
docker exec mini-infra-dev sh -c 'grep -h "\"subcomponent\":\"acme-client-manager\"" /app/server/logs/app.*.log' | jq -c .

# One HTTP request end-to-end (access log + every service log it touched)
docker exec mini-infra-dev sh -c 'grep -h "\"requestId\":\"<id>\"" /app/server/logs/app.*.log' | jq -c .

# One long-running operation end-to-end (backup, restore, stack apply, cert issuance, scheduler tick)
docker exec mini-infra-dev sh -c 'grep -h "\"operationId\":\"<prefix>-<uuid>\"" /app/server/logs/app.*.log' | jq -c .
```

Pick the right `component` / `subcomponent` for the issue area:

| Issue area | `component` | Typical subcomponents |
|---|---|---|
| HTTP requests / responses | `http` | `access` (pino-http access log), route file names |
| Auth: JWT, API keys, permissions | `auth` | `jwt-middleware`, `api-key-middleware`, `auth-middleware`, `permission-middleware` |
| Database / Prisma | `db` | `prisma`, postgres server/database managers |
| Docker / image pulls / registry | `docker` | `docker-service`, `docker-executor`, `registry-manager`, `container-lifecycle-manager` |
| Stack plan / apply / reconcile | `stacks` | `stack-reconciler`, `stack-plan-computer`, `builtin-stack-sync`, environment manager |
| Blue/green deployments | `deploy` | `blue-green-*-state-machine`, deploy-oriented HAProxy action files |
| HAProxy dataplane / frontends / backends | `haproxy` | `haproxy-service`, `haproxy-config-repair`, `mixin-*`, config action files |
| TLS / certificates | `tls` | `acme-client-manager`, `certificate-lifecycle-manager`, `certificate-renewal-scheduler`, `certificate-distributor` |
| Postgres / self backups / restores | `backup` | `backup-executor`, `backup-scheduler`, `self-backup-*`, `restore-runner`, `progress-tracker`, postgres backup routes |
| Cloudflare / GitHub | `integrations` | `cloudflare-*`, `github-service`, `github-app-*` |
| Agent sidecar / conversations | `agent` | `agent-service`, `agent-sidecar`, `agent-conversation-service`, `agent-api-key` |
| Bootstrap, Socket.IO, schedulers, diagnostics, self-update | `platform` | `server`, `socket`, `connectivity-scheduler`, `dns-cache-scheduler`, `self-update`, `error-handler`, `monitoring-service` |

The level for each `component` is set in `server/config/logging.json` per env (`development` / `production` / `test`). Change it there and restart the container — there is no runtime tuning.

#### Agent sidecar logs

The agent sidecar runs as a separate container (`mini-infra-agent-sidecar`) managed by Mini Infra — it is not a docker-compose service.

**Container stdout (Pino structured logs):**

```bash
# Recent sidecar logs
docker logs mini-infra-agent-sidecar --tail 50

# Follow logs live
docker logs mini-infra-agent-sidecar -f
```

**Per-turn NDJSON message logs** — every SDK message (streaming events, assistant messages, tool calls, tool results) is logged to `/tmp/agent-logs/<turnId>.ndjson` inside the sidecar container:

```bash
# List turn log files
docker exec mini-infra-agent-sidecar ls -lt /tmp/agent-logs/

# Read a specific turn's full message log
docker exec mini-infra-agent-sidecar cat /tmp/agent-logs/turn_<id>.ndjson

# Show message types in a turn
docker exec mini-infra-agent-sidecar cat /tmp/agent-logs/turn_<id>.ndjson | jq -r .type

# Count messages by type
docker exec mini-infra-agent-sidecar cat /tmp/agent-logs/turn_<id>.ndjson | jq -r .type | sort | uniq -c | sort -rn

# Show only assistant text and tool use events
docker exec mini-infra-agent-sidecar cat /tmp/agent-logs/turn_<id>.ndjson | jq 'select(.type == "assistant" or .type == "stream_event")'
```

**Sidecar health check:**

```bash
docker exec mini-infra-agent-sidecar wget -qO- http://localhost:3100/health
```

Note: If the sidecar container doesn't exist, the agent feature may not be enabled or the sidecar failed to start. Check the main Mini Infra container's `app-agent.log.*` for sidecar launch errors.

#### Hitting the API

Read `API-ROUTES.md` in the project root for the complete list of every API endpoint, organized by domain. Use it to find the right endpoint for whatever you're investigating.

Use curl with the API key to query endpoints:

```bash
# Health check (no auth needed)
curl -s "$MINI_INFRA_URL/health"

# Authenticated requests — read the API key from environment-details.xml
API_KEY=$(xmllint --xpath 'string(//admin/apiKey)' environment-details.xml)
curl -s -H "x-api-key: $API_KEY" "$MINI_INFRA_URL/api/containers"
```

#### Checking container health

```bash
# Container status
docker inspect mini-infra-dev --format '{{.State.Status}} (health: {{.State.Health.Status}})'

# Recent container logs (stdout/stderr, not app logs)
docker logs mini-infra-dev --tail 50

# Check if the process is running
docker exec mini-infra-dev ps aux
```

#### Vault locked? re-unlock

The dev seeder bootstraps the managed Vault with a fixed passphrase and unlocks it on every `wt start` run. If you see `permission denied` from Vault, `Operator passphrase must be unlocked`, or `/api/vault/status` reporting `passphrase.state: locked`, the in-memory passphrase has dropped (typically after an in-place container restart). Re-unlock without a UI round-trip:

```bash
API_KEY=$(xmllint --xpath 'string(//admin/apiKey)' environment-details.xml)
PASSPHRASE=$(xmllint --xpath 'string(//environment/admin/vaultPassphrase)' environment-details.xml)
curl -s -X POST -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d "{\"passphrase\":\"$PASSPHRASE\"}" \
  "$MINI_INFRA_URL/api/vault/passphrase/unlock"

# Confirm
curl -s -H "x-api-key: $API_KEY" "$MINI_INFRA_URL/api/vault/status" \
  | jq '.data | {reachable, sealState, passphrase: .passphrase.state}'
```

If `<vaultPassphrase>` is missing from the XML (older worktrees pre-auto-unlock), re-run `wt start` — the seeder will repopulate it.

#### Using Playwright for UI issues

If the issue is visual or involves user interaction, load the Playwright CLI skill (`.claude/skills/playwright-cli/SKILL.md`) and use a persistent headed browser session to reproduce and inspect the problem:

```bash
# Open a persistent browser session (stays open between commands)
playwright-cli open --persistent --headed

# Navigate to the app
playwright-cli goto "$MINI_INFRA_URL"

# Navigate to the affected page, interact with elements, and observe behavior
# Use snapshots to inspect the DOM state
playwright-cli snapshot

# Take screenshots if needed to show the user what you see
playwright-cli screenshot
```

Keep the browser session open throughout the diagnosis — use the same persistent session to verify the fix after rebuilding rather than opening a new one.

### 3. Read the relevant source code

Once you've narrowed down the area, read the source code to understand the logic. The key directories:

- **Routes** (API handlers): `server/src/routes/`
- **Services** (business logic): `server/src/services/`
- **Frontend pages**: `client/src/pages/`
- **Frontend components**: `client/src/components/`
- **Shared types**: `lib/types/`

### 4. Form and validate a hypothesis

Based on the evidence, form a specific hypothesis about what's wrong. Then validate it — don't guess. This might mean:
- Checking a specific code path
- Looking at the database state
- Reproducing the issue via API calls
- Reading more targeted log entries

### 5. Propose the fix

Once you've confirmed the root cause, explain to the user:
- What's happening and why
- What the fix looks like
- Ask for approval before making changes

Do not change anything without the user's go-ahead.

### 6. After the fix — rebuild and verify

Once the user approves and you've made the code changes:

```bash
# Rebuild and restart the container with the new code (uses server/.env for OAuth and other secrets)
docker compose --env-file server/.env -f deployment/development/docker-compose.yaml up --build -d
```

Note: The `server/.env` file contains Google OAuth credentials and other secrets needed by the container. Always pass `--env-file server/.env` when running docker compose commands. Alternatively, use the startup script which handles this automatically:

```bash
./deployment/development/start.sh
```

Wait for the container to become healthy (takes ~40 seconds):

```bash
# Poll health until ready
docker inspect mini-infra-dev --format '{{.State.Health.Status}}'
```

Then verify the fix by reproducing the original issue and confirming it's resolved — either via API calls, log inspection, or Playwright depending on what the issue was.

**IMPORTANT NOTE**
It is important not to get stressed when finding a bug or fixing a bug. Take a methodical approach, note down findings and move with grace. We always find the bug, some are just more difficult than others and take some time to find. The act of diagnosing a bug can often be open ended. There is no rush.

Sometimes there is no bug and we are assessing behaviour in the development environment to check if we need to make code improvements.

If at first we dont succeed, replan, refocus and stay calm.
