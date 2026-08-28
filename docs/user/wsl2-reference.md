# WSL2 Reference

Reference notes for using WSL2 to run multiple isolated Docker daemons on Windows — one per Mini Infra worktree. The Windows analog of [colima-reference.md](colima-reference.md).

## What WSL2 Is

The Windows Subsystem for Linux v2 runs a real Linux kernel in a managed lightweight VM. Each "distro" is a registered Linux installation with its own filesystem (a VHDX disk file). All distros share a single Hyper-V utility VM and (in the default NAT networking mode) a single kernel network namespace — verifiable via `readlink /proc/self/ns/net`, which returns the same id from every running distro. Each distro has its own filesystem, mount, pid, ipc, and user namespaces; only the network namespace is shared. (`networkingMode=mirrored` in `~\.wslconfig` changes this, but Mini Infra assumes the default.)

For our use case:

- Mini Infra creates one distro per worktree, namespaced `mini-infra-<profile>`.
- The distro is cloned from a cached Alpine + dockerd tarball at `~\.mini-infra\wsl-base.tar`.
- ~250 MB on disk per worktree (Alpine + dockerd installed).
- ~60 MB idle RAM per worktree (shared kernel keeps overhead low).
- Each distro hosts dockerd on a dedicated TCP port (9230 + slot) plus a unix socket inside the distro.

## Installation

One-time, on a fresh box, from an admin PowerShell:

```powershell
wsl --install
```

This enables the WSL2 feature and reboots. After reboot, run `wsl --status` from a normal PowerShell to confirm it works.

You also need the Docker CLI on Windows PATH (no daemon — that runs inside the distro). Smallest install is the static Docker binary:

1. Download from <https://download.docker.com/win/static/stable/x86_64/> (pick the latest `docker-XX.YY.ZZ.zip`).
2. Extract `docker.exe` to a folder on PATH (e.g. `C:\Tools\docker\`).
3. Verify: `docker --version` from a new shell.

Docker Desktop is **not** required and **not** recommended — it would conflict with the per-worktree dockerd model.

## Building the Base Tarball

One-time, before your first `wt init`:

```powershell
.\scripts\build-wsl-base.ps1
```

The script downloads Alpine Mini Root Filesystem, imports it as a builder distro, installs dockerd + iptables, exports the result to `~\.mini-infra\wsl-base.tar`, and unregisters the builder.

Re-run with `-Force` to refresh after Alpine or dockerd updates. Pass `-AlpineVersion 3.22.1` to pin a specific version.

## Per-Worktree Workflow

Same commands as the macOS flow — see [CLAUDE.md](../../CLAUDE.md). The unified CLI works the same on Windows:

```powershell
wt init --description "auth refactor"
wt init --description "auth refactor" --param seed_profile=minimal
wt start
wt list
wt rm --slug <slug>
wt cleanup --dry-run
```

`seed_profile=minimal` skips the vault+nats stack, the egress-fw-agent stack, the local environment (and its egress-gateway), and the HAProxy stack — the per-distro dockerd ends up with just the mini-infra container. `full` (the default) seeds everything. The parameter is sticky: worktree-manager records it in `wt-env.yaml`, so later `wt start` runs reuse it.

The orchestrator auto-detects driver: `wsl` on Windows, `colima` on macOS. Override with `MINI_INFRA_DRIVER=wsl` (or `colima`) if you need to.

## Core Commands

```powershell
wsl --list --verbose                      # list all distros + state
wsl --list --running                      # only running distros
wsl -d mini-infra-<profile>               # open a shell in a distro
wsl -d mini-infra-<profile> -- <cmd>      # run one command and exit
wsl --terminate mini-infra-<profile>      # stop a distro (data preserved)
wsl --shutdown                            # stop ALL distros + the utility VM
wsl --unregister mini-infra-<profile>     # delete a distro and its disk
wsl --export mini-infra-<profile> out.tar # snapshot
wsl --import <name> <dir> <tar>           # restore / clone
```

## Inspecting a Worktree's Daemon

```powershell
# What's running inside the worktree's distro?
wsl -d mini-infra-strange-ride-7c8285 -- ps aux | findstr dockerd

# dockerd logs
wsl -d mini-infra-strange-ride-7c8285 -- cat /var/log/mini-infra/dockerd.log

# Docker info via the TCP listener (from Windows)
$env:DOCKER_HOST = "tcp://localhost:9231"   # 9230 + slot; `wt show` prints yours
docker info
```

## Resource Limits

WSL2 uses a single global memory budget shared across all distros. Configure it via `~\.wslconfig`:

```ini
[wsl2]
memory=16GB
processors=8
swap=4GB
```

Apply with `wsl --shutdown` then start a distro again. Unlike Colima, you cannot give individual distros different caps — all distros share the pool dynamically. For 1–3 concurrent worktrees this is usually friendlier than Colima's per-VM allocation.

## Networking — How `localhost:<port>` Reaches the Distro

WSL2's `localhostForwarding` feature (default on) automatically forwards `127.0.0.1:<port>` from Windows to whichever distro is binding that port. That's how `http://localhost:9201` reaches the mini-infra container, how `tcp://localhost:9231` reaches dockerd, and so on. If forwarding ever breaks, check `~\.wslconfig`:

```ini
[wsl2]
localhostForwarding=true
```

## Common Tasks

### Wipe and rebuild a worktree

The friendly path — `compose down -v`, unregister the distro, remove the install dir, and drop the registry entry in one shot:

```powershell
wt rm --slug <slug>
# add --force to skip the confirmation prompt
# add --keep-vm to drop containers + registry entry only, leaving the distro up
wt start
```

The raw equivalent (skips compose-down and the registry update):

```powershell
wsl --unregister mini-infra-<profile>
wt start
```

### Reset only data (keep distro)

```powershell
pnpm worktree-env down --volumes && wt start
```

### Stop everything quickly

```powershell
wsl --shutdown
```

Restarts on the next `wt start`.

### List all Mini Infra distros

```powershell
wsl --list --verbose | findstr mini-infra-
```

## Tradeoffs vs Colima

| Property | Colima (macOS) | WSL2 (Windows) |
|---|---|---|
| Disk / worktree | ~3–8 GB VHDX | ~250 MB VHDX |
| Idle RAM / worktree | ~400 MB | ~60 MB |
| Per-worktree CPU/RAM caps | Yes (`--cpu` / `--memory`) | No (global only) |
| Cold-start time | ~30–60 s | ~5–10 s |
| Source-mount perf | virtiofs (excellent) | TCP build context (fine) |
| Init system | systemd in VM | none — dockerd via `nohup` |

Net: WSL2 is lighter per-instance and faster to spin up, but coarser on resource isolation.

## Troubleshooting

**`wsl --import` fails with "There is not enough space on the disk."**
WSL stores VHDX files under `~\.mini-infra\wsl\<profile>\`. Free up space on that drive or symlink the directory elsewhere before re-running.

**dockerd doesn't start.**
Check `wsl -d mini-infra-<profile> -- cat /var/log/mini-infra/dockerd.log`. Most common cause: iptables nftables/legacy mismatch — re-run `scripts\build-wsl-base.ps1 -Force` to rebuild the base tarball with the correct iptables symlinks.

**`localhost:<port>` doesn't reach the distro.**
Ensure `localhostForwarding=true` in `~\.wslconfig`, then `wsl --shutdown` and try again.

**Distro shows status `Stopped` but `wt start` says it's running.**
The orchestrator triggers a start when needed. If it consistently misdetects state, manually `wsl --terminate` the distro and re-run.

**"docker.exe is not recognized."**
Install the static Docker CLI binary (see [Installation](#installation)). Don't install Docker Desktop unless you've intentionally chosen that path — it'll fight with the per-worktree daemon.

**Containers on the same env's applications network can't reach each other.**
Symptom: TCP connects time out and ICMP fails between two containers that `docker network inspect <env>-applications` confirms are on the same network. `iptables -L DOCKER-USER` is just `RETURN` and doesn't drop anything. Likely cause: an orphaned `br-<id>` bridge is shadowing the real one in the kernel's FIB. Because every WSL2 distro shares one network namespace, a previous worktree's leftover bridge can win the route lookup for the same subnet, sending packets out via empty veths.

This used to happen routinely between *running* sibling worktrees because two daemons could independently pick the same `/24` for their `local-applications` network. That class of collision is now prevented by construction: each worktree is given its own `/22` slice of `172.30.0.0/16`, keyed off the same slot as its ports. Slot 1 → `172.30.0.0/22`, slot 2 → `172.30.4.0/22`, and so on. The slice is passed into the container as `MINI_INFRA_EGRESS_POOL_CIDR` and the server allocates `/24`s only from inside it. You can verify the assignment with `wt show` or `xmllint --xpath 'string(//environment/egressPool)' environment-details.xml`.

The pool holds 64 blocks and [wt.yaml](../../wt.yaml) caps the repository at 4 slots, so exhaustion is not reachable. If the ceiling is ever raised past 64, the `cidr` resource's `on_exhaustion: shared-pool` falls back to the shared `172.30.0.0/16` and collisions between siblings become possible again.

Migration corner case: existing worktrees keep their already-allocated `local-applications` subnets across restarts (the server reuses the network's IPAM config rather than reallocating). If an old subnet sits *outside* the new pool for that worktree's slot, the worktree itself keeps working but a *different* worktree may later pick the same `/24` for a fresh env. Run `pnpm worktree-env down --volumes` then `wt start` for a clean cutover.

Diagnose a suspected orphan-bridge case:

```powershell
# 1. Two routes for the same subnet = orphan bridge problem
wsl -d mini-infra-<profile> -- ip route show 172.30.0.0/24

# 2. Cross-check the kernel's bridge list against what dockerd thinks it has
wsl -d mini-infra-<profile> -- sh -c 'ip -o link | grep -oE "br-[a-f0-9]{12}" | sort > /tmp/k; docker network ls -q --no-trunc | cut -c1-12 | sort > /tmp/d; comm -23 /tmp/k /tmp/d'
# Anything printed here is a bridge in the kernel that this distro's
# dockerd doesn't claim — it may belong to a sibling distro (fine) or
# be a true orphan from a partial cleanup (bug).

# 3. List bridges claimed by every other running mini-infra distro
wsl -l -v | findstr mini-infra-
# then for each running one:
wsl -d mini-infra-<other> -- docker network ls -q --no-trunc | cut -c1-12
```

`wt rm` and `wt cleanup` already tear the stack down and delete the distro before deallocating. As a last-resort manual recovery for a bridge that survived a partial teardown:

```powershell
wsl -d mini-infra-<profile> -- ip link delete br-<id>
```

Only delete bridges that no running distro's `docker network ls -q` claims. Yanking a sibling distro's bridge will break that worktree's networking until its dockerd recreates it.
