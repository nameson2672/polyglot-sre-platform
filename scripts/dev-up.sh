#!/usr/bin/env bash
# One-command startup: infra (Docker) + all 3 services.
# Uses tmux if available; otherwise background processes with log files.
# Usage: dev-up.sh [--full-teardown]  (--full-teardown only relevant to the INT/TERM cleanup path)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/tmp/polyglot-sre-logs"
STARTUP_DONE=0

ORDERS_API_PID=""
CHECKOUT_BFF_PID=""
NOTIFIER_PID=""
declare -a TAIL_PIDS=()

cleanup() {
  for pid in "${TAIL_PIDS[@]+"${TAIL_PIDS[@]}"}"; do
    kill "$pid" 2>/dev/null || true
  done
  if [[ "$STARTUP_DONE" -eq 0 ]]; then
    echo "" >&2
    echo "Startup failed or interrupted — cleaning up background processes..." >&2
    [[ -n "$ORDERS_API_PID" ]] && kill "$ORDERS_API_PID" 2>/dev/null || true
    [[ -n "$CHECKOUT_BFF_PID" ]] && kill "$CHECKOUT_BFF_PID" 2>/dev/null || true
    [[ -n "$NOTIFIER_PID" ]] && kill "$NOTIFIER_PID" 2>/dev/null || true
    rm -f "$LOG_DIR"/*.pid 2>/dev/null || true
  else
    echo ""
    echo "Log view detached. Services still running. Use 'make dev-down' to stop."
  fi
}
trap cleanup EXIT

cd "$REPO_ROOT"
mkdir -p "$LOG_DIR"

# ── Ensure .env exists ───────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "⚠  Created .env from .env.example — review it before continuing."
fi

# Export env vars for child processes
set -a
# shellcheck source=/dev/null
source .env
set +a

# ── Docker infra ─────────────────────────────────────────────────────────────
echo "Starting Docker infra (postgres + redis)..."
docker compose up -d

# Wait for Postgres (TCP)
echo "Waiting for Postgres on localhost:5432..."
DEADLINE=$(( $(date +%s) + 60 ))
until nc -z localhost 5432 2>/dev/null; do
  (( $(date +%s) > DEADLINE )) && { echo "✗ Timeout waiting for Postgres" >&2; exit 1; }
  sleep 1
done
echo "✓ Postgres ready"

# Wait for Redis
echo "Waiting for Redis on localhost:6379..."
DEADLINE=$(( $(date +%s) + 30 ))
until redis-cli -u "${REDIS_URL:-redis://localhost:6379}" ping 2>/dev/null | grep -q PONG; do
  (( $(date +%s) > DEADLINE )) && { echo "✗ Timeout waiting for Redis" >&2; exit 1; }
  sleep 1
done
echo "✓ Redis ready"

# ── tmux or background ───────────────────────────────────────────────────────
if command -v tmux &>/dev/null; then
  echo "tmux detected — creating session polyglot-dev..."

  # Kill existing session if present
  tmux kill-session -t polyglot-dev 2>/dev/null || true

  # Window 0: infra logs
  tmux new-session -d -s polyglot-dev -n infra \
    "docker compose logs -f; read"

  # Window 1: orders-api
  tmux new-window -t polyglot-dev -n orders-api \
    "cd '${REPO_ROOT}/apps/orders-api' && dotnet run --project src/OrdersApi --launch-profile Development; read"

  # Window 2: checkout-bff
  tmux new-window -t polyglot-dev -n checkout-bff \
    "cd '${REPO_ROOT}/apps/checkout-bff' && npm run dev; read"

  # Window 3: notifier-worker
  tmux new-window -t polyglot-dev -n notifier-worker \
    "cd '${REPO_ROOT}/apps/notifier-worker' && npm run dev; read"

  echo "Waiting for services to become ready..."
  bash "${REPO_ROOT}/scripts/wait-for.sh" "http://localhost:${ORDERS_API_PORT:-8080}/readyz" 90
  bash "${REPO_ROOT}/scripts/wait-for.sh" "http://localhost:${CHECKOUT_BFF_PORT:-8081}/readyz" 90
  bash "${REPO_ROOT}/scripts/wait-for.sh" "http://localhost:${NOTIFIER_WORKER_PORT:-8082}/readyz" 60

  STARTUP_DONE=1

  echo ""
  echo "┌─────────────────────────────────────────────────────────┐"
  echo "│  polyglot-sre dev environment ready (tmux)              │"
  echo "├──────────────────────┬──────────────────────────────────┤"
  echo "│  orders-api          │  http://localhost:${ORDERS_API_PORT:-8080}            │"
  echo "│  checkout-bff        │  http://localhost:${CHECKOUT_BFF_PORT:-8081}            │"
  echo "│  notifier-worker     │  http://localhost:${NOTIFIER_WORKER_PORT:-8082}            │"
  echo "├──────────────────────┴──────────────────────────────────┤"
  echo "│  make smoke          →  run 10-check E2E smoke test     │"
  echo "│  make traffic-steady →  start 5 RPS realistic load      │"
  echo "│  make dev-down       →  stop all services               │"
  echo "└─────────────────────────────────────────────────────────┘"
  echo ""
  echo "Attaching to tmux session (detach with Ctrl-b d)..."
  tmux attach-session -t polyglot-dev

else
  # ── Background process mode ─────────────────────────────────────────────────
  echo "tmux not found — starting services as background processes."
  echo "Logs: ${LOG_DIR}/"

  # orders-api
  echo "Starting orders-api..."
  (cd "${REPO_ROOT}/apps/orders-api" && \
    dotnet run --project src/OrdersApi --launch-profile Development \
  ) > "${LOG_DIR}/orders-api.log" 2>&1 &
  ORDERS_API_PID=$!
  echo "$ORDERS_API_PID" > "${LOG_DIR}/orders-api.pid"

  bash "${REPO_ROOT}/scripts/wait-for.sh" "http://localhost:${ORDERS_API_PORT:-8080}/readyz" 90

  # checkout-bff
  echo "Starting checkout-bff..."
  (cd "${REPO_ROOT}/apps/checkout-bff" && npm run dev) \
    > "${LOG_DIR}/checkout-bff.log" 2>&1 &
  CHECKOUT_BFF_PID=$!
  echo "$CHECKOUT_BFF_PID" > "${LOG_DIR}/checkout-bff.pid"

  bash "${REPO_ROOT}/scripts/wait-for.sh" "http://localhost:${CHECKOUT_BFF_PORT:-8081}/readyz" 60

  # notifier-worker
  echo "Starting notifier-worker..."
  (cd "${REPO_ROOT}/apps/notifier-worker" && npm run dev) \
    > "${LOG_DIR}/notifier-worker.log" 2>&1 &
  NOTIFIER_PID=$!
  echo "$NOTIFIER_PID" > "${LOG_DIR}/notifier-worker.pid"

  bash "${REPO_ROOT}/scripts/wait-for.sh" "http://localhost:${NOTIFIER_WORKER_PORT:-8082}/readyz" 60

  STARTUP_DONE=1

  echo ""
  echo "┌─────────────────────────────────────────────────────────────────────────┐"
  echo "│  polyglot-sre dev environment ready                                     │"
  echo "├────────────────────────┬────────────────────────────────────────────────┤"
  printf "│  orders-api (PID %-6s)│  http://localhost:%-5s                       │\n" \
    "$ORDERS_API_PID" "${ORDERS_API_PORT:-8080}"
  printf "│  checkout-bff (PID %-5s)│  http://localhost:%-5s                       │\n" \
    "$CHECKOUT_BFF_PID" "${CHECKOUT_BFF_PORT:-8081}"
  printf "│  notifier-worker (PID %-3s)│  http://localhost:%-5s                       │\n" \
    "$NOTIFIER_PID" "${NOTIFIER_WORKER_PORT:-8082}"
  echo "├────────────────────────┴────────────────────────────────────────────────┤"
  echo "│  make smoke          →  run 10-check E2E smoke test                     │"
  echo "│  make traffic-steady →  start 5 RPS realistic load (separate terminal)  │"
  echo "│  make dev-logs       →  tail all logs                                   │"
  echo "│  make dev-down       →  stop all services                               │"
  echo "└─────────────────────────────────────────────────────────────────────────┘"
  echo ""
  echo "Tailing logs (Ctrl-C detaches; services keep running)..."
  echo ""

  # Tail all 3 logs with service name prefix
  tail -F "${LOG_DIR}/orders-api.log" 2>/dev/null \
    | sed 's/^/[orders-api]     /' &
  TAIL_PIDS+=($!)
  tail -F "${LOG_DIR}/checkout-bff.log" 2>/dev/null \
    | sed 's/^/[checkout-bff]   /' &
  TAIL_PIDS+=($!)
  tail -F "${LOG_DIR}/notifier-worker.log" 2>/dev/null \
    | sed 's/^/[notifier-worker]/' &
  TAIL_PIDS+=($!)

  wait "${TAIL_PIDS[0]}" 2>/dev/null || true
fi
