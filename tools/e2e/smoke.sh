#!/usr/bin/env bash
# 10-check end-to-end smoke test for polyglot-sre-platform.
# Requires: curl, jq, psql, redis-cli, openssl
# Usage: bash tools/e2e/smoke.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SMOKE_START=$(date +%s)

# ── Load env ────────────────────────────────────────────────────────────────
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

ORDERS_API_URL="${ORDERS_API_URL:-http://localhost:${ORDERS_API_PORT:-8080}}"
CHECKOUT_BFF_URL="${CHECKOUT_BFF_URL:-http://localhost:${CHECKOUT_BFF_PORT:-8081}}"
NOTIFIER_URL="${NOTIFIER_URL:-http://localhost:${NOTIFIER_WORKER_PORT:-8082}}"
PSQL_URL="${PSQL_URL:-postgresql://orders:orders_dev@localhost:5432/orders}"
JWT_SECRET="${JWT_SECRET:-dev-jwt-secret-change-me}"
ORDERS_API_KEY="${ORDERS_API_KEY:-dev-api-key-change-me}"
CUSTOMER_ID="${CUSTOMER_ID:-00000000-0000-0000-0000-000000000001}"

# ── Helpers ──────────────────────────────────────────────────────────────────
source "${SCRIPT_DIR}/lib/assertions.sh"
source "${SCRIPT_DIR}/lib/jwt.sh"

check_deps() {
  local missing=()
  for cmd in curl jq psql redis-cli openssl; do
    command -v "$cmd" &>/dev/null || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing required tools: ${missing[*]}" >&2
    exit 1
  fi
}

check_deps

echo "─────────────────────────────────────"
echo "E2E Smoke Test  ($(date -u +%H:%M:%SZ))"
echo "─────────────────────────────────────"

# ── Pre-test setup: trim stream to prevent stale-event backlog issues ─────────
# Keeps only the last 20 entries so the notifier-worker doesn't reclaim hundreds
# of stale messages from previous runs and trigger its backpressure shutdown.
redis-cli XTRIM orders.events MAXLEN "~" 20 >/dev/null 2>&1 || true

# ── Check 1: Health probes ────────────────────────────────────────────────────
echo ""
echo "[1] Health probes"
assert_http_200 "orders-api   /healthz" "${ORDERS_API_URL}/healthz"
assert_http_200 "orders-api   /readyz"  "${ORDERS_API_URL}/readyz"
assert_http_200 "checkout-bff /healthz" "${CHECKOUT_BFF_URL}/healthz"
assert_http_200 "checkout-bff /readyz"  "${CHECKOUT_BFF_URL}/readyz"
assert_http_200 "notifier     /healthz" "${NOTIFIER_URL}/healthz"
assert_http_200 "notifier     /readyz"  "${NOTIFIER_URL}/readyz"

# ── Check 2: Info endpoints ───────────────────────────────────────────────────
echo ""
echo "[2] Info endpoints"
ORDERS_INFO=$(curl -fsSL --max-time 5 "${ORDERS_API_URL}/info" 2>/dev/null || echo '{}')
assert_not_empty "orders-api info.service"  "$(echo "$ORDERS_INFO"  | jq -r '.service // empty')"

BFF_INFO=$(curl -fsSL --max-time 5 "${CHECKOUT_BFF_URL}/info" 2>/dev/null || echo '{}')
assert_not_empty "checkout-bff info.service" "$(echo "$BFF_INFO" | jq -r '.service // empty')"

NOTIF_INFO=$(curl -fsSL --max-time 5 "${NOTIFIER_URL}/info" 2>/dev/null || echo '{}')
assert_not_empty "notifier info.service"    "$(echo "$NOTIF_INFO" | jq -r '.service // empty')"

# ── Check 3: Prometheus metrics ───────────────────────────────────────────────
echo ""
echo "[3] Prometheus metrics format"
ORDERS_METRICS=$(curl -fsSL --max-time 5 "${ORDERS_API_URL}/metrics" 2>/dev/null || echo "")
assert_contains "orders-api metrics"   "$ORDERS_METRICS" "^# (HELP|TYPE)"

BFF_METRICS=$(curl -fsSL --max-time 5 "${CHECKOUT_BFF_URL}/metrics" 2>/dev/null || echo "")
assert_contains "checkout-bff metrics" "$BFF_METRICS"    "^# (HELP|TYPE)"

NOTIF_METRICS=$(curl -fsSL --max-time 5 "${NOTIFIER_URL}/metrics" 2>/dev/null || echo "")
assert_contains "notifier metrics"     "$NOTIF_METRICS"  "^# (HELP|TYPE)"

# ── Check 4: Create order via checkout-bff ────────────────────────────────────
echo ""
echo "[4] Create order via checkout-bff"

IDEM_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
JWT=$(jwt_generate "$JWT_SECRET" "$CUSTOMER_ID")

CHECKOUT_RESP=$(curl -fsSL --max-time 10 \
  -X POST "${CHECKOUT_BFF_URL}/v1/checkout" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Idempotency-Key: ${IDEM_KEY}" \
  -d @"${SCRIPT_DIR}/fixtures/valid-checkout.json" 2>/dev/null || echo '{}')

ORDER_ID=$(echo "$CHECKOUT_RESP" | jq -r '.order_id // empty' 2>/dev/null || echo "")
assert_uuid "checkout returns order_id" "$ORDER_ID"

# ── Check 5: Verify order in orders-api DB ────────────────────────────────────
echo ""
echo "[5] Order persisted in Postgres"
if [[ -n "$ORDER_ID" && "$ORDER_ID" != "null" ]]; then
  DB_COUNT=$(psql "$PSQL_URL" -t -c \
    "SELECT COUNT(*) FROM orders WHERE id = '${ORDER_ID}'" 2>/dev/null \
    | tr -d ' \n' || echo "0")
  assert_eq "order row in DB" "$DB_COUNT" "1"
else
  fail "order in DB" "skipped — no order_id from check 4"
fi

# ── Check 6: Outbox published to Redis stream ─────────────────────────────────
echo ""
echo "[6] Outbox event in Redis stream"
STREAM_LEN=$(redis-cli XLEN orders.events 2>/dev/null | tr -d ' \n' || echo "0")
assert_gt "orders.events stream has entries" "$STREAM_LEN" "0"

if [[ -n "$ORDER_ID" && "$ORDER_ID" != "null" ]]; then
  # Poll up to 10s for the outbox relay to publish the event
  STREAM_HAS_ORDER=0
  STREAM_DEADLINE=$(( $(date +%s) + 10 ))
  while true; do
    STREAM_DATA=$(redis-cli XRANGE orders.events - + COUNT 500 2>/dev/null || echo "")
    if echo "$STREAM_DATA" | grep -q "$ORDER_ID"; then
      STREAM_HAS_ORDER=1
      break
    fi
    (( $(date +%s) > STREAM_DEADLINE )) && break
    sleep 1
  done
  if [[ "$STREAM_HAS_ORDER" -eq 1 ]]; then
    pass "order_id in stream events"
  else
    fail "order_id in stream events" "order ${ORDER_ID} not found in stream after 10s"
  fi
else
  fail "order_id in stream" "skipped — no order_id"
fi

# ── Check 7: notifier-worker consumed the event ───────────────────────────────
echo ""
echo "[7] notifier-worker consumed event (max 15s)"
PENDING="unknown"
DEADLINE=$(( $(date +%s) + 15 ))
while true; do
  RAW_PENDING=$(redis-cli XPENDING orders.events notifier-workers - + 10 2>/dev/null || echo "")
  # If output is empty or all whitespace → no pending messages
  STRIPPED=$(echo "$RAW_PENDING" | tr -d '[:space:]')
  if [[ -z "$STRIPPED" ]]; then
    PENDING="0"
    break
  fi
  if (( $(date +%s) > DEADLINE )); then
    PENDING="has_pending"
    break
  fi
  sleep 1
done
assert_eq "no pending unacked messages" "$PENDING" "0"

# ── Check 8: Idempotency ──────────────────────────────────────────────────────
echo ""
echo "[8] Idempotency (same key → same order_id, 1 DB row)"
CHECKOUT_RESP2=""
if [[ -n "$ORDER_ID" && "$ORDER_ID" != "null" ]]; then
  CHECKOUT_RESP2=$(curl -fsSL --max-time 10 \
    -X POST "${CHECKOUT_BFF_URL}/v1/checkout" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${JWT}" \
    -H "Idempotency-Key: ${IDEM_KEY}" \
    -d @"${SCRIPT_DIR}/fixtures/valid-checkout.json" 2>/dev/null || echo '{}')
  ORDER_ID2=$(echo "$CHECKOUT_RESP2" | jq -r '.order_id // empty' 2>/dev/null || echo "")
  assert_eq "idempotent order_id matches" "$ORDER_ID2" "$ORDER_ID"

  # Confirm idempotency_keys table has exactly 1 row for this key
  IDEM_COUNT=$(psql "$PSQL_URL" -t -c \
    "SELECT COUNT(*) FROM idempotency_keys WHERE key = '${IDEM_KEY}'" 2>/dev/null \
    | tr -d ' \n' || echo "0")
  assert_eq "idempotency_keys has 1 row" "$IDEM_COUNT" "1"
else
  fail "idempotency check" "skipped — no order_id from check 4"
  fail "idempotency DB row" "skipped"
fi

# ── Check 9: Validation error → 400 Problem Details ──────────────────────────
echo ""
echo "[9] Validation error returns 400 + Problem Details"
NEW_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
NEW_JWT=$(jwt_generate "$JWT_SECRET" "$CUSTOMER_ID")
VAL_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
  -X POST "${CHECKOUT_BFF_URL}/v1/checkout" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NEW_JWT}" \
  -H "Idempotency-Key: ${NEW_KEY}" \
  -d @"${SCRIPT_DIR}/fixtures/invalid-checkout.json" 2>/dev/null || echo "000")
assert_eq "validation error status 400" "$VAL_STATUS" "400"

VAL_BODY=$(curl -sS --max-time 5 \
  -X POST "${CHECKOUT_BFF_URL}/v1/checkout" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NEW_JWT}" \
  -H "Idempotency-Key: $(uuidgen | tr '[:upper:]' '[:lower:]')" \
  -d @"${SCRIPT_DIR}/fixtures/invalid-checkout.json" 2>/dev/null || echo '{}')
assert_json_field "problem details has .type"   "$VAL_BODY" ".type"
assert_json_field "problem details has .title"  "$VAL_BODY" ".title"
assert_json_field "problem details has .status" "$VAL_BODY" ".status" "400"

# ── Check 10: Auth failure → 401 ─────────────────────────────────────────────
echo ""
echo "[10] Auth failure (no JWT + no customer_id) returns 401"
AUTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
  -X POST "${CHECKOUT_BFF_URL}/v1/checkout" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen | tr '[:upper:]' '[:lower:]')" \
  -d '{"items":[{"sku":"TEST","qty":1,"unit_price_cents":100}],"payment_method":"card","currency":"USD"}' \
  2>/dev/null || echo "000")
assert_eq "no auth returns 401" "$AUTH_STATUS" "401"

# ── Results ───────────────────────────────────────────────────────────────────
SMOKE_END=$(date +%s)
DURATION=$(( SMOKE_END - SMOKE_START ))

smoke_results "${DURATION}"
