#!/usr/bin/env bash
# Bash assertion helpers for smoke tests.
# Source this file; don't execute directly.

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  local name="$1"
  echo "  ✓ ${name}"
  (( PASS_COUNT++ )) || true
}

fail() {
  local name="$1"
  local msg="${2:-}"
  echo "  ✗ ${name}${msg:+ — ${msg}}"
  (( FAIL_COUNT++ )) || true
}

assert_http_status() {
  local name="$1"
  local expected="$2"
  local url="$3"
  shift 3
  local actual
  actual=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$@" "${url}" 2>/dev/null || echo "000")
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected HTTP ${expected}, got ${actual} from ${url}"
  fi
}

assert_http_200() {
  assert_http_status "$1" "200" "$2"
}

assert_eq() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "expected '${expected}', got '${actual}'"
  fi
}

assert_not_empty() {
  local name="$1"
  local val="$2"
  if [[ -n "$val" && "$val" != "null" && "$val" != "undefined" ]]; then
    pass "$name"
  else
    fail "$name" "value is empty or null"
  fi
}

assert_gt() {
  local name="$1"
  local actual="$2"
  local min="$3"
  if [[ "$actual" =~ ^[0-9]+$ ]] && (( actual > min )); then
    pass "$name"
  else
    fail "$name" "expected > ${min}, got '${actual}'"
  fi
}

assert_contains() {
  local name="$1"
  local haystack="$2"
  local needle="$3"
  if echo "${haystack}" | grep -qE "${needle}"; then
    pass "$name"
  else
    fail "$name" "string does not contain '${needle}'"
  fi
}

assert_uuid() {
  local name="$1"
  local val="$2"
  if echo "${val}" | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    pass "$name"
  else
    fail "$name" "'${val}' is not a UUID"
  fi
}

assert_json_field() {
  local name="$1"
  local json="$2"
  local field="$3"
  local expected="${4:-}"
  local actual
  actual=$(echo "${json}" | jq -r "${field}" 2>/dev/null || echo "")
  if [[ -n "$expected" ]]; then
    assert_eq "$name" "$actual" "$expected"
  else
    assert_not_empty "$name" "$actual"
  fi
}

smoke_results() {
  local duration="${1:-}"
  echo ""
  echo "─────────────────────────────────────"
  echo "E2E Smoke Test Results"
  echo "─────────────────────────────────────"
  printf "Passed:  %d / %d\n" "$PASS_COUNT" "$(( PASS_COUNT + FAIL_COUNT ))"
  [[ -n "$duration" ]] && echo "Duration: ${duration}s"
  echo ""
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    return 1
  fi
  return 0
}
