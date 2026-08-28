# wt — this repository's per-worktree environments

Why the tooling exists, what it does, and the rules that keep two
worktrees of this repository from colliding. The concrete facts — the
descriptor filename, the port band bases, the shared resources — are
recorded in the managed block at the end of this document, and `wt show`
reads them live.

## Why

Two worktrees of one repository run side by side, and every resource the
application touches has to come from somewhere. Without the tooling, the
second worktree either fails to bind a port or silently attaches to the
first worktree's state, and the failure looks like an unrelated bug. This
repository adopted `wt` so that each worktree's allocation is explicit,
recorded in a descriptor it can read.

## The slot model

Slot 0 is the primary checkout: never managed, keeps the committed
defaults. Slots 1 and up are worktrees; every resource a worktree holds is
derived from its slot and recorded in its descriptor. Two worktrees'
resource tables are disjoint by construction.

## What `wt init` writes

`wt init` attaches to a worktree something else created: it allocates the
slot, materialises the state paths (seeding per the spec's modes), writes
the descriptor and the `.env` managed block, and runs the repo's hooks.
It is idempotent, and re-running it repairs a worktree that drifted.

## What stays shared and why

The resources marked shared are reached unisolated by every worktree and
the main checkout. Writes to them escape the worktree — see the managed
block's shared list, and the descriptor's shared block for the blast
radius of each.

## The registry and the resolution chain

The coordinator keeps a per-machine registry of entries. The application
never reads it: its generated reader (or the `.env` block) resolves the
descriptor from cwd, falling back to the legacy defaults in the primary
checkout and refusing loudly in a linked worktree with no descriptor.

## Teardown ordering

`wt rm` (or `wt reconcile`) tears the resources down by handle from the
registry, never from the working tree: reap the processes bound to the
worktree's ports, tear down in dependency order, drop the entry. The
directory can be deleted first; the handle is the registry's.

## The documented bypass

When the helper cannot run, the manual commands are the hooks in
`wt.yaml` and the values in the descriptor — read them with `wt show
--json`, never hardcode a port or a path. The managed block records the
manual start command.

## The co-resident production stack

If a production stack co-resides on this machine, the tooling never
touches it: its ports are reserved host-globally (`wt bands reserve
--host`, with a note naming what holds the range), and label-based
teardown refuses a compose project name that matches a reservation.

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
# wt-field: resources=ui, registry, vault, docker, haproxy_http, haproxy_https, haproxy_stats, haproxy_dataplane, nats_client, nats_monitor, vm, egress, compose
# wt-field: shared={home}/.mini-infra/dev.env, {home}/.mini-infra/wsl-base.tar, the Cloudflare zone named by dev.env's CLOUDFLARE_API_TOKEN, the Azure Blob Storage account named by dev.env's AZURE_STORAGE_CONNECTION_STRING
# wt-field: worktrees=.claude/worktrees/{slug}
This repository's facts, recorded when these artefacts were generated:
- descriptor: wt-env.yaml (yaml)
- worktrees: .claude/worktrees/{slug} (resolve one with 'wt spec path --slug <slug>')
- ui: port, band base 9200
- registry: port, band base 9210
- vault: port, band base 9220
- docker: port, band base 9230
- haproxy_http: port, band base 9240
- haproxy_https: port, band base 9250
- haproxy_stats: port, band base 9260
- haproxy_dataplane: port, band base 9270
- nats_client: port, band base 9280
- nats_monitor: port, band base 9290
- vm: machine
- egress: cidr
- compose: namespace (compose)
- shared: {home}/.mini-infra/dev.env, {home}/.mini-infra/wsl-base.tar, the Cloudflare zone named by dev.env's CLOUDFLARE_API_TOKEN, the Azure Blob Storage account named by dev.env's AZURE_STORAGE_CONNECTION_STRING
- manual start (the spec's start hook): pnpm worktree-env up
# --- end ---
