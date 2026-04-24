#!/usr/bin/env bash
# Polls an HTTP URL until it returns 2xx, with timeout.
# Usage: wait-for.sh <url> [timeout_seconds]
set -euo pipefail

URL="${1:?url required}"
TIMEOUT="${2:-60}"

echo "Waiting for ${URL} (timeout ${TIMEOUT}s)..."
START=$(date +%s)
while true; do
  if curl -fsS -o /dev/null --max-time 2 "${URL}" 2>/dev/null; then
    echo "✓ ${URL} is ready"
    exit 0
  fi
  NOW=$(date +%s)
  if (( NOW - START > TIMEOUT )); then
    echo "✗ timeout waiting for ${URL}" >&2
    exit 1
  fi
  sleep 1
done
