# worktree-manager decision record

Why [wt.yaml](../wt.yaml) says what it says. The spec is the contract; this
is the memory behind it. Written during the adoption of this repository into
worktree-manager.

Mini Infra had its own per-worktree environment tool before this — a CLI
under `deployment/development/` that allocated ports from
`~/.mini-infra/worktrees.yaml`, created a Colima profile or WSL2 distro per
worktree, brought a compose stack up and seeded it. Adoption retired the
allocator and kept the orchestration; see [Phase 8](#phase-8--what-was-imported).

## Phase 1 — the audit

The finding that shaped everything else: **the VM boundary already isolates
most of the app.** Each worktree gets its own Colima profile running its own
dockerd, so `/var/run/docker.sock`, the fw-agent socket at
`/var/run/mini-infra/fw.sock`, the HAProxy admin socket, the compose volumes
and every Docker network are VM-local and cannot reach another worktree's.
`node_modules`, `server/prisma/dev.db` and `server/prisma/test.db` are
in-tree. `docker-compose.worktree.yaml` pins no `name:` and hardcodes no
port.

What is left is what the spec allocates.

| Resource | Decision |
|---|---|
| Ten host ports (ui, registry, vault, docker, four haproxy, two nats) | isolate — one band base each |
| The Colima profile / WSL2 distro | isolate — `machine` |
| The egress address pool | isolate — `cidr`, a /22 per worktree |
| The compose project | **not modelled** — see Phase 7 below |
| `~/.mini-infra/worktrees.yaml` | retired — worktree-manager's registry replaces it |
| `~/.mini-infra/dev.env` | share |
| `~/.mini-infra/wsl-base.tar` | share |
| The launchd hourly cleanup agent | retired — `wt cleanup` and the coordinator's sweep replace it |
| The Cloudflare zone, the Azure storage account, Let's Encrypt rate limits | share |

The external tenants are the row worth re-reading. Nothing in the repository
isolates them, and nothing can: `dev.env` holds one Cloudflare token and one
Azure connection string, so every worktree that deploys a hostname-routed
stack writes DNS records into the same real zone and stores certificates and
backups in the same storage account. Two worktrees deploying the same
hostname will fight. That is a property of the credentials, not of the
tooling, which is why it is in the hand-authored `shared:` block rather than
modelled as a resource.

## Phase 2 — the policy decisions

**C1 — what isolates by default.** Everything the spec names. The question
the decision turns on is whether the shared state is something the worktree's
user wants to reach, and for Mini Infra's runtime state the answer is no: a
worktree exists to run its own instance. The four `shared:` entries are the
exceptions, and each is reached deliberately by the developer rather than by
a worktree on its own.

**C2 — seeding.** No `state-path` resources at all, so no seed modes. The
app's state lives in compose volumes inside the VM, which the machine
resource creates fresh and destroys wholesale. Seeding is the `seed` hook —
the existing seeder — parameterised by a sticky `seed_profile` chosen on
first `wt init`.

**C3 — descriptor format.** YAML. `js-yaml` is already a dependency and the
repo's own configuration is YAML throughout. The descriptor does not replace
`environment-details.xml`: that file carries the seeded instance's admin
credentials, API key and resource IDs, which worktree-manager does not model,
and the repo's skills read it. The two coexist — `wt-env.yaml` is the
allocation, `environment-details.xml` is what the seeder produced from it.

**C4 — config delivery.** Environment, via the `.env` managed block and the
hook environment. No generated reader: worktree-manager only generates Go
readers and this repository is TypeScript, so `lib/allocation.ts` is the
hand-written equivalent, reading the hook environment first and falling back
to `wt show --json`.

`DOCKER_HOST` is deliberately not an emitted key. It is
`unix://{home}/.colima/{vm}/docker.sock` under Colima and
`tcp://localhost:{docker}` under WSL2, and a static template cannot branch on
the driver, so `lib/allocation.ts` derives it from the VM name and the docker
port instead.

**C6 — the enforcement hook.** Not committed. The SessionStart tripwire is,
because a one-sentence notice is not a policy; the PreToolUse guard would
make the enforcement choice for everyone who clones this repository, and that
choice is theirs. `.claude/hooks/wt-guard.sh` is generated and committed so
anyone who wants it only has to wire it up in their own settings.

**C7 — base branch.** The default. Work here branches from `main`.

**C8 — cleanup posture.** An idle worktree is expensive: a whole Colima VM
with its own dockerd, sized at 2 CPU and 8 GiB. So cleanup matters, and
`wt cleanup` plus the coordinator's sweep replace the launchd agent that used
to run hourly.

**C9 — slot ceiling.** Four. Ten ports per slot means the ceiling multiplies
straight into band size, and four concurrent VMs is already the practical
limit — past roughly four dockerds, bridge network creation starts failing
with "all predefined address pools have been fully subnetted". The retired
allocator enforced the same ceiling for WSL2 and allowed 100 slots
everywhere else, which was theoretical.

**Removal policy.** `unpushed: refuse` and `open_pr: refuse`, raised from
their lenient defaults because every change in this repository is submitted
as a pull request. The cost is that `gh` must be installed and authenticated
for `wt rm` to run at all.

**Worktree path.** The default, `.claude/worktrees/{slug}`. This repository
already put its worktrees there and already gitignored the directory, so
overriding it would move trees for no reason.

## Phase 3 — the band

The ten bases sit on a 10-port stride from 9200: ui 9200, registry 9210,
vault 9220, docker 9230, haproxy_http 9240, haproxy_https 9250, haproxy_stats
9260, haproxy_dataplane 9270, nats_client 9280, nats_monitor 9290.

`wt bands suggest` proposed bases 1 through 40. Those are privileged ports —
the coordinator checks the ledger, which is genuinely free down there, and
does not know the OS reserves everything under 1024. The choice was made
here instead.

The stride preserves a property the retired allocator had and the ports were
easier to read for: every port belonging to slot *n* ends in *n*. Slot 3 is
9203 / 9213 / 9223 / … The whole block fits in 9200–9299 with room to raise
the ceiling to ten slots later without moving a base.

The historical ranges were not reused. Two of them collided with bands
already on this machine — haproxy_http at 8100–8199 against print-pipeline's
`api` base, vault at 8200–8299 against its `web` base — and they were sized
for a 100-slot ceiling that no longer applies.

The band is machine-local. A colleague cloning this repository reserves it on
their own machine; the one-liner is in [CLAUDE.md](../CLAUDE.md) and in
[docs/wt.md](wt.md)'s facts block.

## Phase 6 — what the entry points read now

`deployment/development/lib/allocation.ts` is the only place that learns the
allocation, and everything else takes it as an argument. `lib/registry.ts`
became `lib/paths.ts` — the machine-global paths and the seed profile type
are all that survived of it.

Two behaviours worth recording:

**The provision stage owns the VM being up and correctly sized.** The
machine driver owns the VM's name, the concurrency guard and teardown, and
it starts the VM detached — a cold VM takes minutes and blocking
materialisation on it would stall `wt init`. Three cases follow, and
provision handles all of them: the profile is mid-creation, so it waits;
the profile is already there, so it checks the size; or the driver started
nothing at all, which happens when the machine resource is already
materialised and only the VM has gone away, so provision creates it.

Sizing is the reason the last case matters. A bare `colima start` takes
Colima's own defaults, 2 CPU and 2 GiB, which is not enough to build and
run the stack — the client build dies with a buildkit RPC error rather
than anything that names memory. Provision starts the VM at 2 CPU and
8 GiB, preferring `vz` + `virtiofs` and falling back to the portable
defaults, and restarts an under-sized profile once to correct it.

A `machine` resource's presence in the registry does not imply a running
VM. That is the property the install hook has to own.

**On Windows the distro does not exist yet.** The WSL2 machine driver starts
a distro that already exists but does not import one, so a first bring-up
finds nothing registered. The provision stage imports it from the cached base
tarball under the name wt allocated. Teardown is unaffected —
`wsl --unregister` works once the distro exists.

## Phase 7 — what the proof changed

Two worktrees were brought up side by side and both served at once: slots
1 and 2, all twelve resources disjoint, both `/health` endpoints answering
on 9201 and 9202 with the full seed profile applied — Vault on 9221/9222,
NATS on 9281/9282, HAProxy on 9241/9242 and the rest. The ports were not
merely allocated; each stack template took the one the spec gave it.

The proof changed the spec once.

**The compose project was declared as a `namespace` resource and is not
any more.** Teardown surfaced why. The namespace driver runs
`docker compose -p <project> down` against the worktree's own dockerd, and
that dockerd lives inside the VM the `machine` resource owns. Two failures
follow from that:

- `compose down` leaves the network in place while the agent-sidecar and
  egress-fw-agent containers are still attached. The server creates those
  through the Docker API at runtime, so they are not part of the compose
  project and `down` does not touch them. Teardown stopped with
  `network ... has active endpoints` before the VM was deleted.
- Once the VM is gone, the compose teardown can never succeed again — the
  daemon it needs no longer exists. The entry stuck in `tearing-down` and
  the slot could not be reclaimed. Recovering it meant recreating a VM
  under the old name purely so the teardown had something to talk to.

The compose project was never a contended resource. It lives inside a
per-worktree VM, so two worktrees cannot collide on it whatever it is
called, and deleting the VM removes the containers, networks and volumes
together. Declaring it bought nothing and made teardown depend on
something teardown destroys.

The name is still deterministic and still slot-derived: `emit.env.keys`
resolves `COMPOSE_PROJECT_NAME` from `{app}-{slug}-{slot}` directly, and
`lib/allocation.ts` evaluates the same template when it reads the
descriptor instead of the hook environment.

**Teardown was then re-proved on a fresh worktree** under the corrected
spec, with the agent-sidecar running and attached to the compose network —
the exact condition that had blocked the first two. `wt rm` completed in a
single pass: the machine driver deleted the VM, the slot was freed, the
git worktree was removed, and `wt doctor` came back with nothing.

**One migration hazard is worth knowing about.** Removing a resource from
the spec strands any entry that still carries it:

    survived: resource compose (the spec no longer declares this
    resource; it cannot be torn down without its spec row)

The slot cannot be freed, and the only way out is to put the row back
temporarily, tear the worktree down, and remove the row again. So the
order is: tear down every worktree first, then change the spec. Both proof
worktrees had to be recovered this way.

**A latent bug in the repository also surfaced here.** The dev compose
healthcheck probed `localhost:5000`, the registry service's internal port,
while the app listens on 5005. The container had been marked unhealthy
since the healthcheck was added, and nothing noticed because the old
bring-up ran `compose up -d` and polled the UI port from the host. The
`up` stage uses `compose up -d --wait`, which reads the container's health
status, so it failed immediately and made the mismatch obvious.

## Phase 8 — what was imported

`~/.mini-infra/worktrees.yaml` held no entries at adoption time, so there was
nothing to reconstruct: no live environment was disturbed. The retirement was
therefore a clean deletion rather than a migration.

Retired: `lib/registry.ts`'s port allocator and registry file,
`worktree-list.ts`, `worktree-delete.ts`, `worktree-cleanup.ts`,
`worktree-cleanup-install.ts` and `worktree_cleanup.plist`. `wt list`,
`wt rm` and `wt cleanup` cover all of them.

Kept: the seeder, the sidecar builder, the Colima and WSL2 helpers, the
compose file and `environment-details.xml`. They now read the allocation
instead of computing it.

One behavioural change: the main checkout can no longer run an instance. Slot
0 is the primary checkout and worktree-manager never allocates it, so
`pnpm worktree-env <stage>` in the main checkout exits 4 and names
`wt init`. If the main checkout ever needs its own instance, the answer is a
host-global reservation for a fixed set of ports (`wt bands reserve --host`)
rather than a slot.
