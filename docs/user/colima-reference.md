# Colima Reference

Reference notes for using Colima to run multiple isolated Docker daemons on macOS — one per Mini Infra worktree.

Source: <https://colima.run/docs/> and <https://github.com/abiosoft/colima>

## What Colima Is

Colima is a CLI-only container runtime for macOS and Linux. It runs a Linux VM (via Lima) and exposes a Docker daemon from inside that VM. Each profile is an independent VM with its own Docker daemon, socket, containers, images, and volumes.

Key properties for our use case:

- Multiple concurrent profiles are supported — each is a fully isolated Docker host.
- Each profile creates its own Docker context (`colima`, `colima-<profile>`).
- ~400 MB RAM idle per profile.
- Free, open source, CLI-only (no GUI).

## Installation

```bash
brew install colima docker
```

Alternatives: MacPorts (`sudo port install colima`), Nix, Mise, or raw binary from GitHub releases.

Docker CLI is not bundled — install it separately (above) or reuse the one from Docker Desktop.

## VM Defaults

- CPUs: 2
- Memory: 2 GiB
- Disk: 100 GiB
- Runtime: `docker`
- VM type: `qemu` (default) or `vz` (newer, faster, Rosetta 2 support on Apple Silicon, macOS 13+)

## Core Commands

```bash
colima start [profile] [flags]     # create/start a profile VM
colima stop [profile]              # halt without data loss
colima restart [profile]
colima delete [profile]            # remove VM, preserve images/volumes
colima delete [profile] --data     # full teardown
colima list                        # show all profiles + status
colima status [profile]            # show socket path, runtime, arch, etc.
colima ssh [profile] -- <cmd>      # shell into the VM
colima template                    # print YAML template
colima version
```

## Profiles — The Important Bit

### Creating a profile

Three equivalent ways:

```bash
colima start dev --cpus 4 --memory 8
colima start --profile dev --cpus 4 --memory 8
COLIMA_PROFILE=dev colima start --cpus 4 --memory 8
```

Profile selection priority: `--profile` flag > positional arg > `COLIMA_PROFILE` env var > `default`.

### Storage layout

- Config: `~/.colima/<profile>/colima.yaml`
- Docker socket: `~/.colima/<profile>/docker.sock`
- Base dir override: `COLIMA_HOME` env var (default `~/.colima`)

### Targeting a specific profile from Docker

Two options:

**Docker context** (auto-created per profile):

```bash
docker context ls                  # lists colima, colima-dev, etc.
docker context use colima-dev
docker compose up                  # now targets the dev profile
```

**DOCKER_HOST env var** (takes precedence over context, good for scripts):

```bash
export DOCKER_HOST="unix://$HOME/.colima/dev/docker.sock"
docker compose up                  # targets the dev profile
```

For our `start.sh`, `DOCKER_HOST` is the cleaner choice — it makes the target explicit in the script without mutating the user's active context.

## Configuration File (colima.yaml)

Per-profile config at `~/.colima/<profile>/colima.yaml`. CLI flags override YAML. Common options:

```yaml
cpu: 4
memory: 8
disk: 100
vmType: vz                # qemu | vz | krunkit
rosetta: true             # requires vz on Apple Silicon
runtime: docker           # docker | containerd | incus
mountType: virtiofs       # sshfs | 9p | virtiofs (virtiofs requires vz)
mounts:
  - location: ~
    writable: true
network:
  address: true           # reachable IP (slower startup)
docker:
  insecure-registries:
    - localhost:5051
```

### Immutable after create

These require `colima delete` + restart to change:

- `arch`
- `runtime`
- `vmType`
- `mountType`

## Mount Gotcha

Bind mounts from paths **outside** `/Users/$USER` silently mount as empty inside containers. To expose extra paths, add them under `mounts:` in `colima.yaml` and restart the profile.

For Mini Infra this matters because `start.sh` lives inside a worktree path (e.g. `~/Repos/mini-infra/.claude/worktrees/...`) — as long as that's under `/Users/$USER`, bind mounts work by default.

## Docker Socket — Bind Mount for Mini Infra

Our `docker-compose.yaml` does:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

With Colima, the host-side path is **not** `/var/run/docker.sock`. It's `~/.colima/<profile>/docker.sock`. Either:

1. **Change the compose mount to honour a variable** (preferred):

   ```yaml
   - ${DOCKER_SOCK:-/var/run/docker.sock}:/var/run/docker.sock
   ```

   Then export `DOCKER_SOCK=$HOME/.colima/<profile>/docker.sock` in `start.sh`.

2. **Symlink** `/var/run/docker.sock` to the Colima socket (breaks multi-profile, not recommended):

   ```bash
   sudo ln -sf $HOME/.colima/<profile>/docker.sock /var/run/docker.sock
   ```

## Concurrent Profiles

Multiple profiles can run simultaneously — each is a separate VM. Cost: ~400 MB + some CPU per active profile.

```bash
colima start wt-alpha
colima start wt-beta
colima list
# NAME         STATUS    ARCH      CPUS    MEMORY    DISK    RUNTIME   ADDRESS
# wt-alpha     Running   aarch64   4       8GiB      100GiB  docker    …
# wt-beta      Running   aarch64   4       8GiB      100GiB  docker    …
```

## Known Gotchas

- macOS sleep/restart can leave a profile in a "broken" state → `colima stop --force <profile>` then `colima start <profile>`.
- Network-address mode (`--network-address`) slows startup and needs root — leave off unless a container genuinely needs a reachable IP from the host.
- Rosetta (`vmType: vz` + `rosetta: true`) speeds up x86_64 emulation on Apple Silicon but requires macOS 13+.

## Useful Recipes

### Pick the seed profile when spinning up

The seed hook accepts a `seed_profile` of `minimal` or `full`, chosen on first init with `wt init --param seed_profile=minimal`:

- `--seed-profile full` (default on first run) seeds vault+nats, the egress-fw-agent stack, the local environment with its egress-gateway, and the HAProxy stack — everything needed to exercise the full app.
- `--seed-profile minimal` stops after the admin user, connected services, and onboarding-complete steps. None of the four stacks above are created, so the per-profile VM stays light when you're working on parts of the app that don't touch them.

The parameter is sticky: worktree-manager records it in the worktree's `wt-env.yaml`, so later `wt start` runs reuse it without the flag. `wt show` prints the stored value, and so does `<seedProfile>` in `environment-details.xml`.

### Tear down a worktree's profile completely

The friendly path — wipes the Compose project (containers + volumes), deletes the Colima VM, and removes the registry entry:

```bash
wt rm --slug <slug>
# add --force to skip the confirmation prompt
# add --keep-vm to drop containers + registry entry only, leaving the VM up
```

The raw equivalent (skips compose-down and the registry update):

```bash
colima delete <profile> --data --force
```

### Inspect what's inside a profile's VM

```bash
colima ssh <profile> -- docker ps
```

### Point one shell at one profile for ad-hoc work

```bash
export DOCKER_HOST="unix://$HOME/.colima/<profile>/docker.sock"
docker ps
```
