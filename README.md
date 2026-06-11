# Polyglot SRE Platform

A production-style multi-service platform for practising SRE skills — distributed
tracing, structured logging, metrics, alerting, and Kubernetes deployment on Hetzner.
Three languages, one observability stack, real end-to-end request flows.

---

## TL;DR

```bash
make up          # start Postgres + Redis + all 4 app containers
make obs-up      # start local Grafana / Loki / Tempo / Prometheus
make traffic-steady   # generate load at 5 RPS
# Open http://localhost:3000 (Grafana)
```

---

## Architecture

```
User (HTTP)
    │
    ▼
checkout-bff :8081   (Node.js 22 / Fastify)
    │  JWT auth, payment stub, session cache (Redis)
    │
    ▼ HTTP POST /v1/orders
orders-api :8080     (.NET 10 / ASP.NET Minimal API)
    │  Postgres for orders + outbox table
    │  Background OutboxPublisher → XADD → Redis Stream orders.events
    │
    ▼ (async via Redis Streams XREADGROUP)
notifier-worker :8082  (Node.js 22)
    │  Validates event schema, creates OTEL CONSUMER span
    │
    ▼ HTTP POST webhook
webhook-sink :8083     (Node.js, accepts any POST)

Infrastructure:
  Postgres 16    :5432   — orders + outbox
  Redis 7        :6379   — streams + session cache
  otel-lgtm      :3000 :4317 :9090  — Grafana/Loki/Tempo/Prometheus/OTel Collector
```

---

## Services

| Service | Language | Port | Role |
|---------|----------|------|------|
| `checkout-bff` | Node.js 22 / Fastify | 8081 | BFF — handles auth, calls orders-api, session cache |
| `orders-api` | .NET 10 / ASP.NET | 8080 | Core API — persists orders, publishes events |
| `notifier-worker` | Node.js 22 | 8082 | Redis Streams consumer — webhook delivery |
| `webhook-sink` | Node.js | 8083 | Local webhook receiver for dev |

Infrastructure:

| Container | Image | Port |
|-----------|-------|------|
| `polyglot-postgres` | postgres:16-alpine | 5432 |
| `polyglot-redis` | redis:7-alpine | 6379 |
| `polyglot-otel-lgtm` | grafana/otel-lgtm | 3000, 4317, 9090 |

---

## Observability Stack

Everything pushes to `grafana/otel-lgtm` — a single Docker image that bundles the
OTel Collector, Loki, Tempo, Prometheus, Grafana and Pyroscope.

| Signal | What ships it | Where it lands |
|--------|--------------|----------------|
| **Traces** | OTLP gRPC → `otel-lgtm:4317` | Tempo |
| **Logs** | OTLP gRPC → `otel-lgtm:4317` | Loki |
| **Metrics** | OTLP gRPC → `otel-lgtm:4317` | Prometheus |

### Grafana URLs (local)

| UI | URL |
|----|-----|
| Grafana | http://localhost:3000 |
| Prometheus query | http://localhost:9090 |
| OTLP gRPC ingest | localhost:4317 |

### Useful Loki queries

```logql
# All notifier-worker logs, fully parsed
{service_name="notifier-worker"} | json

# Filter to a specific event type
{service_name="notifier-worker"} | json | event_type="order.created"

# checkout-bff HTTP errors
{service_name="checkout-bff"} | json | level="error"

# Linked log + trace (click trace ID in Tempo → jump to Loki)
{service_name="orders-api"} | json | traceId="<paste id>"
```

### Distributed trace topology

```
checkout-bff (SERVER)
  └─ orders-api (CLIENT→SERVER)
       └─ postgres (CLIENT via EF Core)
       └─ orders.events publish (PRODUCER)
            └─ notifier.process_event (CONSUMER — notifier-worker)
                 └─ POST webhook (CLIENT)
```

Trace IDs propagate across the Redis hop via W3C traceparent fields embedded in the
stream message. Open any trace in Tempo to see the full waterfall.

---

## Local Quickstart

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | any | [docker.com](https://www.docker.com/products/docker-desktop) |
| Node.js | 22 LTS | `brew install node` |
| .NET SDK | 10 | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) |
| jq | any | `brew install jq` |

### First run

```bash
# 1. Clone
git clone <repo-url> polyglot-sre-platform
cd polyglot-sre-platform

# 2. Start infrastructure + all app containers
make up

# 3. Start observability stack
make obs-up

# 4. Verify everything is healthy
make smoke          # 10-check E2E test — expect 10/10 passed

# 5. Generate load so Grafana has data
make traffic-steady  # runs at 5 RPS — leave open in a terminal
```

### Daily workflow

```bash
make up             # start infra + app containers (idempotent)
make obs-up         # start LGTM stack (run once per day)

make traffic-steady # load at 5 RPS (separate terminal)
make traffic-spike  # ramp 1→50 RPS (5 min stress test)
make traffic-mixed  # 80% valid / 20% invalid mix
make traffic-chaos  # hit /slow for SLO burn

make down           # stop app containers, keep infra
make obs-down       # stop LGTM stack
```

### All `make` targets

```
make help            List all targets
make up              Start Postgres + Redis + 4 app containers
make down            Stop app containers
make logs            Tail all container logs
make ps              Show container status
make psql            Open psql shell to Postgres
make redis-cli       Open redis-cli
make reset-db        Drop + recreate dev database
make obs-up          Start LGTM stack (Grafana, Loki, Tempo, Prometheus)
make obs-down        Stop LGTM stack
make obs-logs        Tail LGTM container logs
make smoke           10-check E2E smoke test
make traffic-steady  5 RPS realistic load
make traffic-spike   Ramp 1→50 RPS spike (5 min)
make traffic-mixed   80/20 valid/invalid at 10 RPS
make traffic-chaos   /slow endpoint for SLO burn
make clean           Remove node_modules, bin, obj
```

### Service endpoints

| Service | URL | Auth |
|---------|-----|------|
| orders-api | http://localhost:8080 | `X-Api-Key: dev-api-key-change-me` |
| checkout-bff | http://localhost:8081 | `Authorization: Bearer <jwt>` |
| notifier-worker | http://localhost:8082 | none (health + metrics only) |
| webhook-sink | http://localhost:8083 | none |

### Quick API check

```bash
# Health checks
curl http://localhost:8080/healthz
curl http://localhost:8081/healthz
curl http://localhost:8082/healthz

# Create an order via the BFF (generates a JWT)
source tools/e2e/lib/jwt.sh
JWT=$(jwt_generate "dev-jwt-secret-change-me" "00000000-0000-0000-0000-000000000001")
curl -X POST http://localhost:8081/v1/checkout \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d @tools/e2e/fixtures/valid-checkout.json | jq

# Watch the Redis stream
redis-cli XLEN orders.events
redis-cli XRANGE orders.events - + COUNT 3

# Check orders in Postgres
psql "postgresql://orders:orders_dev@localhost:5432/orders" \
  -c "SELECT id, status, total_cents FROM orders ORDER BY created_at DESC LIMIT 5;"
```

---

## How the Event Flow Works

1. **User → checkout-bff** — `POST /v1/checkout` with JWT auth. BFF validates the
   request, calls orders-api, caches the session in Redis.

2. **checkout-bff → orders-api** — `POST /v1/orders` with API key. orders-api writes
   the order + an outbox message to Postgres in the same transaction (no dual-write).

3. **orders-api OutboxPublisher** — a background loop polls the outbox table every
   second. For each unpublished message it emits an OTEL PRODUCER span and calls
   Redis `XADD orders.events` with the event fields + trace context. Marks the message
   as published.

4. **notifier-worker** — reads from the `orders.events` Redis Stream via `XREADGROUP`.
   Validates the event schema, extracts the W3C traceparent from the message, creates an
   OTEL CONSUMER span (linked to the orders-api producer span), calls the webhook URL,
   and ACKs the message.

5. **webhook-sink** — local Node.js server that accepts any POST and returns 200. In
   production this would be replaced by a real webhook endpoint.

---

## Environment Variables

All services read config from environment variables. Docker Compose sets defaults for
local dev — no `.env` file is required to get started.

| Variable | Service | Default (dev) | Purpose |
|----------|---------|---------------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | `http://otel-lgtm:4317` | OTLP collector address |
| `OTEL_SERVICE_NAME` | notifier-worker | `notifier-worker` | Service name in traces/logs |
| `LOG_LEVEL` | Node services | `debug` | Pino log level |
| `APP_ENV` | Node services | `dev` | Enables pino-pretty console output |
| `POSTGRES_CONNECTION_STRING` | orders-api | (local postgres) | DB connection |
| `REDIS_URL` | all | `redis://redis:6379` | Redis address |
| `ORDERS_API_KEY` | checkout-bff, orders-api | `dev-api-key-change-me` | Inter-service API key |
| `JWT_SECRET` | checkout-bff | `dev-jwt-secret-change-me` | JWT signing key |
| `WEBHOOK_URL` | notifier-worker | `http://webhook-sink:8083/webhook` | Webhook delivery target |
| `ENABLE_DLQ` | notifier-worker | `true` | Send failed events to DLQ stream |

---

## Deploying to Hetzner (Production)

The production target is a k3s Kubernetes cluster on Hetzner Cloud, provisioned with
[hetzner-k3s](https://github.com/vitobotta/hetzner-k3s).

### Cluster spec (`infra/hetzner/cluster.yaml`)

| Role | Instance type | Count | Location |
|------|--------------|-------|----------|
| Master | cx23 (2 vCPU, 8 GB RAM) | 1 | fsn1 |
| Worker | cx23 (2 vCPU, 8 GB RAM) | 1 | fsn1 |

Private network: `10.0.0.0/16`, CNI: Flannel.

### Create a cluster

```bash
# Install hetzner-k3s
brew install vitobotta/tap/hetzner-k3s

# Set your Hetzner API token
export HCLOUD_TOKEN=<your-token>

# Provision
hetzner-k3s create --config infra/hetzner/cluster.yaml

# kubeconfig is written to ./kubeconfig
export KUBECONFIG=./kubeconfig
kubectl get nodes
```

### Tear down a cluster

```bash
hetzner-k3s delete --config infra/hetzner/cluster.yaml
```

### DNS / Cloudflare (`infra/cloudflare/`)

Cloudflare is used for DNS and proxying public traffic. Config lives in
`infra/cloudflare/`. Requires a Cloudflare API token with Zone:Edit permissions.

---

## CI/CD (GitHub Actions → GitOps)

The `.github/workflows/build-and-bump.yml` workflow automates image delivery for the three
app services (`orders-api`, `checkout-bff`, `notifier-worker`).

On every push to `main` that touches `apps/<service>/**` it:

1. **Detects** which service(s) changed (`dorny/paths-filter`).
2. **Builds + pushes** only those images to `ghcr.io/nameson2672/<service>`, tagged with the
   immutable git short-SHA (`sha-<short>`) plus `:latest`.
3. **Opens a PR** (`ci/image-bump-<short>`) that bumps `image.tag` in the matching
   `platform/workloads/<service>/values-dev.yaml`.

You review and merge that PR; ArgoCD (which tracks `main`) then rolls out the new image.
Because the tag is immutable, no `kubectl rollout restart` is needed.

**No build loop:** the build only triggers on `apps/**`, while the bump PR only changes
`platform/workloads/**`, so merging it never re-runs the build.

**One-time repo setting:** Settings → Actions → General → Workflow permissions → enable
"Read and write permissions" **and** "Allow GitHub Actions to create and approve pull
requests" (required for the bump PR). No extra secrets are needed — the workflow uses the
built-in `GITHUB_TOKEN`.

---

## Troubleshooting

### orders-api takes a long time to start

Cold start downloads NuGet packages — allow up to 90 seconds. Check:
```bash
docker logs polyglot-orders-api 2>&1 | tail -20
```
Look for `Now listening on http://+:8080`. If it errors on DB: `make reset-db`.

### notifier-worker shows "Event failed" in logs

The default webhook URL is `http://webhook-sink:8083/webhook`. Confirm the sink is
running: `curl http://localhost:8083/healthz`. If it returns 404, the path may differ
— check the WEBHOOK_URL env var.

### Loki / Tempo shows no data

1. Confirm the LGTM stack is running: `make obs-logs` — look for "Loki is up".
2. Generate traffic first: `make traffic-steady` (data takes ~10s to appear).
3. In Grafana → Explore → Loki, run `{service_name="checkout-bff"}`.

### Redis messages stuck in XPENDING

```bash
redis-cli XINFO GROUPS orders.events        # check consumer group state
redis-cli XPENDING orders.events notifier-workers - + 10   # list stuck messages
docker compose restart notifier-worker      # restarts consumer; reclaims after 60s idle
```

### Port already in use

```bash
lsof -ti :8080 | xargs kill -9   # orders-api
lsof -ti :8081 | xargs kill -9   # checkout-bff
lsof -ti :8082 | xargs kill -9   # notifier-worker
lsof -ti :3000 | xargs kill -9   # Grafana
```

---

## Project Layout

```
polyglot-sre-platform/
├── apps/
│   ├── checkout-bff/        Node.js 22 / Fastify BFF
│   ├── orders-api/          .NET 10 / ASP.NET Minimal API
│   ├── notifier-worker/     Node.js 22 Redis Streams consumer
│   └── webhook-sink/        Local webhook receiver
├── infra/
│   ├── hetzner/             k3s cluster config (cluster.yaml)
│   └── cloudflare/          DNS / proxy config
├── tools/
│   └── e2e/
│       ├── traffic-generator/  Load generator (steady/spike/mixed/chaos)
│       └── smoke.sh            10-check smoke test
├── scripts/
│   ├── dev-up.sh            Start services locally
│   └── dev-down.sh          Stop services
├── docs/
│   ├── dev-workflow.md      Detailed developer workflow
│   └── api-contracts.md     API contracts between services
├── docker-compose.yml       App + infra containers
├── docker-compose.monitoring.yml  LGTM observability stack
└── Makefile                 All common tasks
```
