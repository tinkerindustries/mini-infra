#!/usr/bin/env bash
#
# egress-e2e.sh — black-box smoke test for the per-environment egress firewall.
#
# Drives a running worktree's Mini Infra instance via its REST API:
#   1. Reads connection details from environment-details.xml
#   2. Enables egress firewall on env "local" (idempotent)
#   3. Deploys a single-container "alpine + curl" workload joining the
#      `applications` resource network
#   4. Runs two curls inside the workload via `docker exec`:
#        - https://example.com         → expect 200. This is the regression
#          test for the ConnTracker nil-deref panic — detect mode's default
#          Report policy was the exact trigger.
#        - https://dns.google/dns-query → expect 403 from the DoH gate.
#   5. Verifies the example.com request appears in /api/egress/events.
#   6. Greps the egress-gateway container's docker logs for `panic serving`
#      and fails loudly if any are present.
#   7. Always tears down the test stack on exit.
#
# Usage:  scripts/egress-e2e.sh
# Requires: xmllint, jq, curl, docker — all present on a normal dev machine.

set -euo pipefail

# ---- locate worktree root (script lives in scripts/) -----------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_XML="$ROOT/environment-details.xml"

if [[ ! -f "$ENV_XML" ]]; then
  echo "error: environment-details.xml not found at $ENV_XML" >&2
  echo "       run \`wt start\` first" >&2
  exit 1
fi

xq() { xmllint --xpath "string($1)" "$ENV_XML"; }

UI_URL="$(xq '//environment/endpoints/ui')"
API_KEY="$(xq '//environment/admin/apiKey')"
LOCAL_ENV_ID="$(xq '//environment/localEnvironment/id')"
LOCAL_ENV_NAME="$(xq '//environment/localEnvironment/name')"
COMPOSE_PROJECT="$(xq '//environment/worktree/composeProject')"

if [[ -z "$UI_URL" || -z "$API_KEY" || -z "$LOCAL_ENV_ID" ]]; then
  echo "error: environment-details.xml is missing required fields" >&2
  exit 1
fi

API="$UI_URL/api"
AUTH=(-H "x-api-key: $API_KEY")

STACK_NAME="egress-e2e-$$"
SERVICE_NAME="workload"
WORKLOAD_CONTAINER="${LOCAL_ENV_NAME}-${STACK_NAME}-${SERVICE_NAME}"
GATEWAY_CONTAINER="${LOCAL_ENV_NAME}-egress-gateway-egress-gateway"

STACK_ID=""
TEST_START_ISO=""

# ---- helpers ---------------------------------------------------------------

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m  ✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[0;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

api_call() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${AUTH[@]}" \
      -H "content-type: application/json" \
      -d "$body" "$API$path"
  else
    curl -fsS -X "$method" "${AUTH[@]}" "$API$path"
  fi
}

cleanup() {
  local exit_code=$?
  if [[ -n "$STACK_ID" ]]; then
    step "Cleanup: removing test stack $STACK_NAME"
    api_call DELETE "/stacks/$STACK_ID" >/dev/null 2>&1 || true
    ok "stack delete requested"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

# ---- 1. enable firewall on env --------------------------------------------

step "Ensuring egress firewall is enabled on env '$LOCAL_ENV_NAME'"
api_call PUT "/environments/$LOCAL_ENV_ID" '{"egressFirewallEnabled":true}' >/dev/null
ok "firewall flag set"

# ---- 2. confirm gateway container is running ------------------------------

step "Locating gateway container"
gateway_id="$(docker ps --filter "name=^${GATEWAY_CONTAINER}" --format '{{.ID}}' | head -n 1)"
[[ -n "$gateway_id" ]] || fail "gateway container '$GATEWAY_CONTAINER' is not running"
ok "gateway container $gateway_id"

# ---- 3. deploy the test workload stack ------------------------------------

step "Creating test stack $STACK_NAME"
TEST_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
create_payload=$(cat <<JSON
{
  "name": "$STACK_NAME",
  "environmentId": "$LOCAL_ENV_ID",
  "description": "egress-e2e smoke test workload",
  "networks": [],
  "volumes": [],
  "resourceInputs": [{"type":"docker-network","purpose":"applications"}],
  "services": [{
    "serviceName": "$SERVICE_NAME",
    "serviceType": "Stateful",
    "dockerImage": "curlimages/curl",
    "dockerTag": "latest",
    "order": 0,
    "dependsOn": [],
    "containerConfig": {
      "entrypoint": ["sh"],
      "command": ["-c","sleep infinity"],
      "joinResourceNetworks": ["applications"],
      "restartPolicy": "no"
    }
  }]
}
JSON
)
create_response="$(api_call POST "/stacks" "$create_payload")"
STACK_ID="$(echo "$create_response" | jq -r '.data.id // .id')"
[[ -n "$STACK_ID" && "$STACK_ID" != "null" ]] || fail "could not parse stack id from create response: $create_response"
ok "stack id $STACK_ID"

step "Applying stack"
api_call POST "/stacks/$STACK_ID/apply" '{}' >/dev/null
ok "apply requested"

step "Waiting for stack to reach 'synced'"
for _ in $(seq 1 60); do
  status="$(api_call GET "/stacks/$STACK_ID" | jq -r '.data.status // .status')"
  if [[ "$status" == "synced" ]]; then ok "stack status=synced"; break; fi
  if [[ "$status" == "error" ]]; then fail "stack apply failed (status=error)"; fi
  sleep 2
done
if [[ "$status" != "synced" ]]; then fail "stack did not reach 'synced' (last status=$status)"; fi

step "Waiting for workload container to be running"
for _ in $(seq 1 30); do
  state="$(docker inspect -f '{{.State.Status}}' "$WORKLOAD_CONTAINER" 2>/dev/null || echo missing)"
  case "$state" in
    running)
      if docker exec "$WORKLOAD_CONTAINER" sh -c 'command -v curl >/dev/null' 2>/dev/null; then
        ok "curl available in $WORKLOAD_CONTAINER"
        break
      fi
      ;;
    exited|dead)
      echo "  ✗ container is $state — last 30 lines of logs:" >&2
      docker logs --tail 30 "$WORKLOAD_CONTAINER" 2>&1 | sed 's/^/    /' >&2
      fail "workload container exited before we could exec into it"
      ;;
  esac
  sleep 2
done
docker exec "$WORKLOAD_CONTAINER" sh -c 'command -v curl >/dev/null' \
  || fail "curl never became available in $WORKLOAD_CONTAINER (state=$state)"

# Default auto-created policy is detect mode with allow-default — no rules
# needed. Detect mode means the default Report policy is applied to every
# request, which is exactly the state that triggered the panic
# (`decision_reason: "rule has allow and report policy"`).

# ---- 4. run the curls inside the workload --------------------------------

run_curl() {
  # Returns the *effective* HTTP status from the request:
  #   - on success: %{http_code} from curl (the upstream's response)
  #   - on a CONNECT-tunnel failure: the code the proxy returned in its 4xx
  #     CONNECT response, parsed from stderr ("CONNECT tunnel failed, response NNN")
  #   - "000" if neither was available (DNS/network failure, panic, etc.)
  local url="$2"
  local out
  out="$(docker exec "$WORKLOAD_CONTAINER" \
    curl -sS -k --connect-timeout 5 -m 10 \
      -o /dev/null -w '%{http_code}' "$url" 2>&1)" || true
  # The trailing line is the curl `-w` output (3-digit code or "000").
  local last_line http_code proxy_code
  last_line="$(printf '%s' "$out" | tail -n1)"
  http_code="$(printf '%s' "$last_line" | grep -oE '^[0-9]{3}$' | head -n1)"
  if [[ -n "$http_code" && "$http_code" != "000" ]]; then
    echo "$http_code"
    return
  fi
  proxy_code="$(printf '%s' "$out" | grep -oE 'response [0-9]{3}' | tail -n1 | awk '{print $2}')"
  if [[ -n "$proxy_code" ]]; then
    echo "$proxy_code"
    return
  fi
  echo "000"
}

step "Waiting for gateway container-map to register workload (curl example.com)"
# The container-map pusher debounces ~500ms after the workload starts. Poll
# the first curl until we get a non-403 — that proves our IP is in the map.
code=""
for i in $(seq 1 15); do
  code="$(run_curl example "https://example.com")"
  if [[ "$code" == "200" ]]; then
    ok "got $code (after ${i} attempt(s))"
    break
  fi
  sleep 1
done
[[ "$code" == "200" ]] || fail "want 200 from example.com, got $code after retries — gateway map likely never synced our IP"

step "Curl: https://dns.google/dns-query (expect 403 from DoH gate)"
code="$(run_curl doh "https://dns.google/dns-query")"
[[ "$code" == "403" ]] && ok "got 403" || fail "want 403 from DoH gate, got $code"

# ---- 5. verify the example.com request landed in /api/egress/events -------

step "Verifying egress events landed in /api/egress/events"
events="$(api_call GET "/egress/events?stackId=$STACK_ID&since=$TEST_START_ISO&limit=50")"
example_seen="$(echo "$events" | jq -r '[.events[]?, .data.events[]?] | map(select(.destination|test("example\\.com"))) | length')"
[[ "$example_seen" -ge 1 ]] && ok "example.com event present" || fail "no example.com event recorded"

# ---- 6. grep gateway logs for panics --------------------------------------

step "Grepping gateway logs for 'panic serving'"
if docker logs "$gateway_id" 2>&1 | grep -F -q 'panic serving'; then
  echo "--- panic excerpt ---" >&2
  docker logs "$gateway_id" 2>&1 | grep -A 8 'panic serving' >&2 || true
  fail "FOUND panic in egress-gateway logs — regression of the ConnTracker nil-deref"
fi
ok "no panics in gateway logs"

step "ALL CHECKS PASSED"
