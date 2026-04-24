# Developer Workflow

Local development guide for polyglot-sre-platform.

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| .NET SDK | 10+ | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) |
| Node.js | 22 LTS | `brew install node` or [nodejs.org](https://nodejs.org) |
| Docker Desktop | any | [docker.com](https://www.docker.com/products/docker-desktop) |
| psql client | any | `brew install libpq` |
| redis-cli | 7+ | `brew install redis` |
| jq | any | `brew install jq` |
| tmux (optional) | any | `brew install tmux` — enables split-pane log view |

## First-time setup

```bash
# 1. Clone and enter repo
git clone <repo-url> polyglot-sre-platform
cd polyglot-sre-platform

# 2. Configure environment
cp .env.example .env
# Edit .env if needed — defaults work for local dev

# 3. Install Node dependencies for each service
(cd apps/checkout-bff && npm install)
(cd apps/notifier-worker && npm install)
(cd tools/e2e/traffic-generator && npm install)

# 4. Restore .NET dependencies
(cd apps/orders-api && dotnet restore)

# 5. Start infra + all services
make dev-up
```

## Daily workflow

```bash
# Terminal 1 — start everything
make dev-up
# (If tmux is installed, you'll be attached to a split-pane view.
#  Detach with Ctrl-b d. Services keep running.)

# Terminal 2 — verify it all works
make smoke
# Expect: 10/10 passed

# Terminal 2 (continued) — leave traffic running for Grafana demos (Week 2+)
make traffic-steady

# When done
make dev-down        # stop services, keep Postgres + Redis
make dev-down-full   # stop everything including Docker infra
```

## Available targets

```bash
make help            # list all targets
make dev-up          # start infra + all 3 services
make dev-down        # stop services (keep infra)
make dev-down-full   # stop everything
make dev-logs        # tail all logs (/tmp/polyglot-sre-logs/*.log)
make smoke           # 10-check E2E test
make traffic-steady  # 5 RPS steady load (for Grafana)
make traffic-spike   # ramp 1→50 RPS spike (5 min)
make traffic-mixed   # 80% valid / 20% invalid mix
make traffic-chaos   # hit /slow for SLO burn demos
make e2e-full        # full cycle: up → smoke → traffic → down
```

## Service URLs

| Service | URL | Auth |
|---------|-----|------|
| orders-api | http://localhost:8080 | `X-Api-Key: dev-api-key-change-me` |
| checkout-bff | http://localhost:8081 | `Authorization: Bearer <jwt>` |
| notifier-worker | http://localhost:8082 | none (ops endpoints only) |

## Quick API checks

```bash
# Health
curl http://localhost:8080/healthz
curl http://localhost:8081/healthz
curl http://localhost:8082/healthz

# Create a checkout (generates a JWT using openssl)
source tools/e2e/lib/jwt.sh
JWT=$(jwt_generate "dev-jwt-secret-change-me" "00000000-0000-0000-0000-000000000001")
curl -X POST http://localhost:8081/v1/checkout \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d @tools/e2e/fixtures/valid-checkout.json | jq

# Check Redis stream
redis-cli XLEN orders.events
redis-cli XRANGE orders.events - + COUNT 3

# Check Postgres
psql "postgresql://orders:orders_dev@localhost:5432/orders" \
  -c "SELECT id, status, total_cents FROM orders ORDER BY created_at DESC LIMIT 5;"
```

## Troubleshooting

### `make dev-up` hangs waiting for orders-api

orders-api takes up to 60s on a cold cache (first `dotnet run` downloads NuGet packages).
Check: `tail -f /tmp/polyglot-sre-logs/orders-api.log`

If it fails with a DB error: `docker compose ps` to confirm postgres is healthy. Run `make reset-db` to recreate.

### `checkout-bff` starts but `make smoke` fails check 4

Ensure orders-api is ready first: `curl http://localhost:8080/readyz` should return `{"status":"ok"}`.
checkout-bff's `/readyz` checks connectivity to orders-api — if that returns 503, orders-api isn't up yet.

### Redis `XPENDING` shows messages stuck in pending

The notifier-worker's consumer group may not have started. Check:
```bash
redis-cli XINFO GROUPS orders.events
curl http://localhost:8082/readyz
```
Restart notifier-worker: `bash scripts/dev-down.sh && cd apps/notifier-worker && npm run dev &`

### `pgrep` shows leftover processes after `dev-down`

```bash
pkill -f 'dotnet.*OrdersApi' 2>/dev/null || true
pkill -f 'tsx.*checkout-bff' 2>/dev/null || true
pkill -f 'tsx.*notifier-worker' 2>/dev/null || true
```

### Port already in use

Find and kill the process occupying a port:
```bash
lsof -ti :8080 | xargs kill -9
lsof -ti :8081 | xargs kill -9
lsof -ti :8082 | xargs kill -9
```

### `.env` missing required variable

`make dev-up` auto-copies `.env.example → .env` on first run. If services fail to start, check that all variables in `.env.example` have values in your `.env`.
