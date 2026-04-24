#!/usr/bin/env bash
# Shell JWT generator (HS256) using openssl only — no Node dependency.
# Source this file; don't execute directly.

jwt_generate() {
  local secret="${1:-dev-jwt-secret-change-me}"
  local customer_id="${2:-00000000-0000-0000-0000-000000000001}"
  local header='{"alg":"HS256","typ":"JWT"}'
  local payload
  payload=$(printf '{"customer_id":"%s","iat":%d}' "$customer_id" "$(date +%s)")
  local b64h
  b64h=$(printf '%s' "$header" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  local b64p
  b64p=$(printf '%s' "$payload" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  local sig
  sig=$(printf '%s' "${b64h}.${b64p}" \
    | openssl dgst -sha256 -hmac "$secret" -binary \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  printf '%s' "${b64h}.${b64p}.${sig}"
}
