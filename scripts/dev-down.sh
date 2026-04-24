#!/usr/bin/env bash
# Stops all 3 services. Pass --full to also tear down Docker infra.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/tmp/polyglot-sre-logs"
FULL_TEARDOWN=0

for arg in "$@"; do
  [[ "$arg" == "--full" ]] && FULL_TEARDOWN=1
done

cd "$REPO_ROOT"

# Kill tmux session if present
if command -v tmux &>/dev/null && tmux has-session -t polyglot-dev 2>/dev/null; then
  echo "Killing tmux session polyglot-dev..."
  tmux kill-session -t polyglot-dev
fi

# Kill background services via PID files
if [[ -d "$LOG_DIR" ]]; then
  for pidfile in "$LOG_DIR"/*.pid; do
    [[ -f "$pidfile" ]] || continue
    pid=$(cat "$pidfile" 2>/dev/null || true)
    [[ -z "$pid" ]] && continue
    svc=$(basename "$pidfile" .pid)
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping ${svc} (PID ${pid})..."
      kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done

  # Also kill child processes (dotnet run spawns the actual binary as a child)
  for pidfile in "$LOG_DIR"/*.pid; do
    [[ -f "$pidfile" ]] && true  # already removed above, but double-check
  done
  # Kill all children of the dotnet run process (the compiled OrdersApi binary)
  pkill -TERM -f 'OrdersApi$' 2>/dev/null || true
  pkill -TERM -f 'tsx.*checkout-bff' 2>/dev/null || true
  pkill -TERM -f 'tsx.*notifier-worker' 2>/dev/null || true

  # Give processes up to 10 seconds to exit gracefully
  DEADLINE=$(( $(date +%s) + 10 ))
  while pgrep -f 'OrdersApi|tsx.*checkout-bff|tsx.*notifier-worker' &>/dev/null; do
    if (( $(date +%s) > DEADLINE )); then
      echo "Force-killing survivors..."
      pkill -9 -f 'OrdersApi' 2>/dev/null || true
      pkill -9 -f 'tsx.*checkout-bff' 2>/dev/null || true
      pkill -9 -f 'tsx.*notifier-worker' 2>/dev/null || true
      break
    fi
    sleep 1
  done
fi

# Final safety net for any remaining processes
pkill -f 'net10.0/OrdersApi' 2>/dev/null || true
pkill -f 'dotnet.*OrdersApi' 2>/dev/null || true

if [[ "$FULL_TEARDOWN" -eq 1 ]]; then
  echo "Stopping Docker infra..."
  docker compose down
  echo "✓ Infra stopped"
fi

echo "✓ Services stopped"
