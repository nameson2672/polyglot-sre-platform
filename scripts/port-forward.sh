#!/usr/bin/env bash
# Port-forward every dev app + monitoring/telemetry service from the cluster to
# localhost, one auto-restarting kubectl port-forward per tmux window.
# Session name: k-port-forward
#
# Usage:
#   port-forward.sh [--no-attach|-d] [--context <ctx>]
#   port-forward.sh --down            # kill the k-port-forward session
#   port-forward.sh --help
set -euo pipefail

SESSION="k-port-forward"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ATTACH=1
CONTEXT=""

# ── Forward table: windowName|namespace|service|localPort:remotePort ──────────
FORWARDS=(
  # App services (dev)
  "orders-api|dev|orders-api|8080:8080"
  "checkout-bff|dev|checkout-bff|8081:8081"
  "notifier-worker|dev|notifier-worker|8082:8082"
  # Infrastructure (dev)
  "postgres|dev|postgres-rw|5432:5432"
  "redis|dev|dev-redis-master|6379:6379"
  # Observability / telemetry (monitoring)
  "grafana|monitoring|kube-prometheus-stack-grafana|3000:80"
  "prometheus|monitoring|kube-prometheus-stack-prometheus|9090:9090"
  "alertmanager|monitoring|kube-prometheus-stack-alertmanager|9093:9093"
  "loki|monitoring|loki-gateway|3100:80"
  "tempo|monitoring|tempo|3200:3200"
  "alloy-otlp-grpc|monitoring|grafana-alloy|4317:4317"
  "alloy-otlp-http|monitoring|grafana-alloy|4318:4318"
)

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --down)            tmux kill-session -t "$SESSION" 2>/dev/null \
                         && echo "✓ Killed tmux session '$SESSION'." \
                         || echo "No tmux session '$SESSION' running."
                       exit 0 ;;
    --no-attach|-d)    ATTACH=0; shift ;;
    --context)         CONTEXT="${2:?--context requires a value}"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# kubectl wrapper that honours an optional --context
KUBECTL=(kubectl)
[[ -n "$CONTEXT" ]] && KUBECTL+=(--context "$CONTEXT")

# ── Preflight ─────────────────────────────────────────────────────────────────
command -v kubectl &>/dev/null || { echo "✗ kubectl not found on PATH" >&2; exit 1; }
command -v tmux    &>/dev/null || { echo "✗ tmux not found on PATH"    >&2; exit 1; }

CURRENT_CTX="${CONTEXT:-$(kubectl config current-context 2>/dev/null || true)}"
echo "Checking cluster connectivity (context: ${CURRENT_CTX:-<none>})..."
if ! "${KUBECTL[@]}" cluster-info &>/dev/null; then
  echo "✗ Cannot reach the cluster. Check your kubeconfig / context (--context <ctx>)." >&2
  exit 1
fi
echo "✓ Cluster reachable"

# ── (Re)create the session ────────────────────────────────────────────────────
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Build the per-window kubectl --context flag string (safe to be empty)
CTX_FLAG=""
[[ -n "$CONTEXT" ]] && CTX_FLAG="--context $CONTEXT"

started=0
skipped=0
for row in "${FORWARDS[@]}"; do
  IFS='|' read -r win ns svc ports <<<"$row"
  local_port="${ports%%:*}"
  remote_port="${ports##*:}"

  if ! "${KUBECTL[@]}" get svc -n "$ns" "$svc" &>/dev/null; then
    echo "⚠  Skipping ${ns}/${svc} — service not found"
    skipped=$((skipped + 1))
    continue
  fi

  # Auto-restarting port-forward so dropped connections reconnect.
  cmd="while true; do \
echo '↻ forwarding ${ns}/${svc}  ->  127.0.0.1:${local_port}'; \
kubectl ${CTX_FLAG} port-forward -n '${ns}' 'svc/${svc}' '${local_port}:${remote_port}' --address 127.0.0.1 || true; \
echo '✗ port-forward for ${svc} dropped — retrying in 2s'; sleep 2; \
done"

  if [[ "$started" -eq 0 ]]; then
    tmux new-session -d -s "$SESSION" -n "$win" "$cmd"
  else
    tmux new-window -t "$SESSION" -n "$win" "$cmd"
  fi
  started=$((started + 1))
  echo "→ ${win}: 127.0.0.1:${local_port} -> ${ns}/${svc}:${remote_port}"
done

if [[ "$started" -eq 0 ]]; then
  echo "✗ No services were available to forward. Nothing started." >&2
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  exit 1
fi

# ── Summary ───────────────────────────────────────────────────────────────────
cat <<EOF

┌─────────────────────────────────────────────────────────┐
│  k-port-forward ready (${started} forwarded, ${skipped} skipped)$(printf '%*s' $(( 18 - ${#started} - ${#skipped} )) '')│
├──────────────────────┬──────────────────────────────────┤
│  orders-api          │  http://localhost:8080           │
│  checkout-bff        │  http://localhost:8081           │
│  notifier-worker     │  http://localhost:8082           │
│  postgres            │  localhost:5432 (svc postgres-rw)│
│  redis               │  localhost:6379                  │
│  grafana             │  http://localhost:3000           │
│  prometheus          │  http://localhost:9090           │
│  alertmanager        │  http://localhost:9093           │
│  loki                │  http://localhost:3100           │
│  tempo               │  http://localhost:3200           │
│  alloy OTLP gRPC     │  localhost:4317                  │
│  alloy OTLP HTTP     │  http://localhost:4318           │
├──────────────────────┴──────────────────────────────────┤
│  detach            →  Ctrl-b d                           │
│  switch window     →  Ctrl-b <number>                    │
│  stop all          →  make port-forward-down            │
└─────────────────────────────────────────────────────────┘
EOF

if [[ "$ATTACH" -eq 1 ]]; then
  echo "Attaching to tmux session (detach with Ctrl-b d)..."
  tmux attach-session -t "$SESSION"
else
  echo "Session '$SESSION' started detached."
  echo "  attach:  tmux attach -t $SESSION"
  echo "  stop:    bash scripts/port-forward.sh --down"
fi
