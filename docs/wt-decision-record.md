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
| The compose project | isolate — `namespace` |
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

**The VM comes up under-provisioned.** worktree-manager's machine driver runs
plain `colima start <name>`, which uses Colima's own defaults (2 CPU, 2 GiB)
— not enough to build and run the stack. The provision stage detects an
under-sized profile from `colima list --json` and restarts it once at 2 CPU
and 8 GiB, preferring `vz` + `virtiofs` and falling back to the portable
defaults.

**On Windows the distro does not exist yet.** The WSL2 machine driver starts
a distro that already exists but does not import one, so a first bring-up
finds nothing registered. The provision stage imports it from the cached base
tarball under the name wt allocated. Teardown is unaffected —
`wsl --unregister` works once the distro exists.

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
