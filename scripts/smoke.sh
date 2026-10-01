#!/usr/bin/env bash
# End-to-end smoke test against a running API: health, credits, chats, a turn (send, active run, cancel, replay),
# history and delete. Works with or without `pnpm trigger:dev` running.
#
#   TEST_TOKEN=<Clerk session token> ./scripts/smoke.sh
#   BASE_URL=http://localhost:3000 (default)
#
# Get a token in the frontend's browser console: await window.Clerk.session.getToken()
# Tokens are short-lived (about a minute), so run the script right after copying one.
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TOKEN="${TEST_TOKEN:-}"

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "✘ $tool is required" >&2; exit 2; }
done
[[ -n "$TOKEN" ]] || { echo "✘ set TEST_TOKEN to a Clerk session token" >&2; exit 2; }

failures=0
pass() { echo "✔ $1"; }
fail() { echo "✘ $1" >&2; failures=$((failures + 1)); }

# call METHOD PATH [JSON BODY] [auth|noauth]: sets $status and $body
call() {
  local method=$1 path=$2 data=${3:-} auth=${4:-auth}
  local args=(-sS -X "$method" -o /tmp/magica-smoke.$$ -w '%{http_code}' "$BASE_URL$path")
  [[ $auth == auth ]] && args+=(-H "Authorization: Bearer $TOKEN")
  [[ -n $data ]] && args+=(-H 'Content-Type: application/json' --data "$data")
  status=$(curl "${args[@]}") || status=000
  body=$(cat /tmp/magica-smoke.$$ 2>/dev/null || true)
  rm -f /tmp/magica-smoke.$$
}

# expect NAME STATUS [JQ TEST]: the test must print true
expect() {
  local name=$1 want=$2 test=${3:-}
  if [[ $status != "$want" ]]; then
    fail "$name (HTTP $status, wanted $want): $(echo "$body" | head -c 300)"
  elif [[ -n $test ]] && [[ $(echo "$body" | jq -r "$test" 2>/dev/null) != true ]]; then
    fail "$name (unexpected body): $(echo "$body" | head -c 300)"
  else
    pass "$name"
  fi
}

uuid() { uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || cat /proc/sys/kernel/random/uuid; }

call GET /api/health "" noauth
expect "health" 200

call GET /api/credits "" noauth
expect "no token is refused" 401 '(.code | type == "string") and (.error | type == "string")'

call GET /api/credits
expect "credits" 200 '(.balance | type == "number") and (.held | type == "number")'
held_before=$(echo "$body" | jq -r '.held // 0')

call GET /api/models
expect "models: only the free router, with its health" 200 '.defaultModelId == "openrouter/free" and ([.models[] | .free] | all) and (.status.health | IN("available","degraded","unavailable","unknown"))'

call POST /api/chats '{}'
expect "create chat" 201 '.chat.title == "New chat"'
chat=$(echo "$body" | jq -r '.chat.id // empty')
[[ -n $chat ]] || { echo "✘ no chat id, stopping" >&2; exit 1; }

call GET "/api/chats/$chat"
expect "get chat" 200 ".chat.id == \"$chat\""

call PATCH "/api/chats/$chat" '{"title":"Smoke test","isPinned":true}'
expect "rename and pin" 200 '.chat.title == "Smoke test" and .chat.isPinned == true'

call GET "/api/chats?limit=5"
expect "list shows it first (pinned)" 200 ".chats[0].id == \"$chat\""

call PATCH "/api/chats/$chat" '{"title":""}'
expect "an empty title is refused" 400

call GET "/api/chats/$chat/active-run"
expect "no active run yet" 200 '.run == null'

client_id=$(uuid)
call POST "/api/chats/$chat/messages" "{\"content\":\"Say hello in one word.\",\"clientMessageId\":\"$client_id\"}"
expect "send" 201 '(.runId | length > 0) and (.triggerRunId | length > 0) and (.realtimeToken | length > 0) and .message.role == "USER"'
run=$(echo "$body" | jq -r '.runId // empty')
message=$(echo "$body" | jq -r '.message.id // empty')

call POST "/api/chats/$chat/messages" "{\"content\":\"Say hello in one word.\",\"clientMessageId\":\"$client_id\"}"
expect "the same message again is a replay" 200 ".message.id == \"$message\" and .runId == \"$run\""

call POST "/api/chats/$chat/messages" "{\"content\":\"A second question\",\"clientMessageId\":\"$(uuid)\"}"
if [[ $status == 409 ]]; then pass "a second send while a run is going is refused (409)"
elif [[ $status == 201 ]]; then pass "the first run had already finished, so a second send was accepted"; run=$(echo "$body" | jq -r '.runId')
else fail "second send (HTTP $status): $(echo "$body" | head -c 300)"; fi

call GET "/api/chats/$chat/active-run"
expect "active run" 200 '(.run == null) or ((.run.status | IN("PENDING","RUNNING")) and (.partialBlocks | type == "array"))'

call POST "/api/runs/$run/cancel"
if [[ $status == 204 ]]; then pass "cancel"
elif [[ $status == 404 ]]; then pass "cancel: the run had already finished (the worker answered first)"
else fail "cancel (HTTP $status): $(echo "$body" | head -c 300)"; fi

call POST "/api/runs/$run/cancel"
expect "cancelling again finds nothing to stop" 404

call GET "/api/chats/$chat/active-run"
expect "no active run after cancel" 200 '.run == null'

call GET "/api/chats/$chat/messages"
expect "history has the question and an ended reply" 200 \
  '([.messages[] | select(.role == "USER")] | length >= 1) and ([.messages[] | select(.role == "ASSISTANT") | .status] | all(IN("COMPLETED","CANCELLED","FAILED")))'

call GET /api/credits
expect "credits are no longer held for this chat" 200 ".held == $held_before"

call DELETE "/api/chats/$chat"
expect "delete" 204

call GET "/api/chats/$chat"
expect "the deleted chat is gone" 404 '(.code | type == "string") and (.error | type == "string")'

echo
if ((failures > 0)); then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
