#!/bin/sh
# PreToolUse enforcement hook, generated per repo by worktree-manager
# phase 7 (docs/design/07-agent-surface.md §6, docs/ARCHITECTURE.md §9.6).
# Opt-in: .claude/settings.json declares it only when the repo's developer
# confirmed enforcement during onboarding (C6).
#
# It calls `wt guard --json` — the local verb that reads git and the
# descriptor and opens no socket — so an agent session keeps working with
# the coordinator down, and the coordinator never sits in the latency path
# of a file write.
#
# Caching (the phase-7 decision on plan.md §9.2, 07-agent-surface.md
# §6.3): the classification is cached per session in WT_GUARD_CACHE, keyed
# on cwd. The cache is validated by stat; when the worktree is removed
# mid-session its root vanishes, the cache drops, and the next call
# reclassifies — failing open with a one-time note, because a session
# whose worktree vanished must keep working elsewhere.
set -u

export WT_GUARD_CACHE="${WT_GUARD_CACHE:-${TMPDIR:-/tmp}/wt-guard-cache}"

if ! command -v wt >/dev/null 2>&1; then
  echo "note: wt is not on PATH; this call was allowed (the guard failed open)" >&2
  echo '{"hookSpecificOutput":{"hookEventName":{"permissionDecision":"allow"}}}'
  exit 0
fi

out="$(wt guard --json 2>&1)"
code=$?
case "$code" in
0)
  echo '{"hookSpecificOutput":{"hookEventName":{"permissionDecision":"allow"}}}'
  exit 0
  ;;
3)
  # Denied. The full reason is on stderr already (wt guard prints it);
  # echo the structured denial for the hook protocol and the reason for
  # the model, so it corrects itself and retries.
  reason="$(printf '%s\n' "$out" | sed -n 's/.*"reason": "\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$reason" ] || reason="denied by wt guard"
  printf '{"hookSpecificOutput":{"hookEventName":{"permissionDecision":"deny","denyReason":"%s"}}}\n' "$reason"
  exit 2
  ;;
*)
  # Fail open and say so once: a guard that denies on its own errors makes
  # the session unusable.
  echo "note: wt guard could not classify (exit $code); this call was allowed — the guard fails open on its own errors" >&2
  echo '{"hookSpecificOutput":{"hookEventName":{"permissionDecision":"allow"}}}'
  exit 0
  ;;
esac

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
# --- end ---
