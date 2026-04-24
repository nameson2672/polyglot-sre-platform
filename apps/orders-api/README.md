# orders-api

.NET 10 Minimal API service that owns the `Order` aggregate. Persists to Postgres, publishes domain events via a transactional outbox to a Redis Stream (`orders.events`).

## Prerequisites

- .NET 10 SDK
- Docker (for local Postgres + Redis)

## Local Run

```bash
# From repo root — start Postgres and Redis
docker compose up -d

cd apps/orders-api
dotnet restore
dotnet run --project src/OrdersApi --launch-profile Development
```

The service listens on **http://localhost:8080**.

## Smoke Tests

```bash
# Liveness
curl http://localhost:8080/healthz

# Readiness (checks DB + Redis)
curl http://localhost:8080/readyz

# Info
curl http://localhost:8080/info | jq

# Prometheus metrics
curl http://localhost:8080/metrics | head -20

# Create an order
curl -X POST http://localhost:8080/v1/orders \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: dev-api-key-change-me" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"customer_id":"00000000-0000-0000-0000-000000000001","items":[{"sku":"ABC","qty":1,"unit_price_cents":1000}],"currency":"CAD"}' \
  | jq

# Fetch order (replace <id> with the id from above)
curl -H "X-Api-Key: dev-api-key-change-me" http://localhost:8080/v1/orders/<id> | jq

# List orders (paginated)
curl -H "X-Api-Key: dev-api-key-change-me" "http://localhost:8080/v1/orders?page=1&page_size=10" | jq

# Update status
curl -X PATCH http://localhost:8080/v1/orders/<id> \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: dev-api-key-change-me" \
  -d '{"status":"confirmed"}' | jq

# Cancel (soft delete)
curl -X DELETE -H "X-Api-Key: dev-api-key-change-me" http://localhost:8080/v1/orders/<id>

# Chaos: slow endpoint (~2s latency)
time curl -H "X-Api-Key: dev-api-key-change-me" http://localhost:8080/v1/orders/slow
```

## Verify outbox published to Redis

```bash
sleep 3
redis-cli XLEN orders.events        # should be >= 1
redis-cli XRANGE orders.events - + COUNT 3
```

## Run Tests

```bash
cd apps/orders-api
dotnet test OrdersApi.slnx
```

Requires Docker for Testcontainers (Postgres + Redis spun up automatically).

## Docker Build

```bash
cd apps/orders-api
docker build -t polyglot-sre/orders-api:dev .
docker images polyglot-sre/orders-api:dev --format "{{.Size}}"
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `POSTGRES_CONNECTION_STRING` | Postgres DSN | required |
| `REDIS_URL` | Redis URL (`redis://host:port`) | required |
| `ORDERS_API_KEY` | API key for `X-Api-Key` header | required |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP gRPC endpoint | `http://localhost:4317` |
| `ASPNETCORE_ENVIRONMENT` | Environment name | `Production` |

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/healthz` | No | Liveness probe |
| GET | `/readyz` | No | Readiness probe (checks DB+Redis) |
| GET | `/metrics` | No | Prometheus metrics |
| GET | `/info` | No | Service metadata |
| POST | `/v1/orders` | Yes | Create order (requires Idempotency-Key) |
| GET | `/v1/orders` | Yes | List orders (paginated) |
| GET | `/v1/orders/{id}` | Yes | Get order by ID |
| PATCH | `/v1/orders/{id}` | Yes | Update order status |
| DELETE | `/v1/orders/{id}` | Yes | Cancel order |
| GET | `/v1/orders/slow` | Yes | Chaos: 2s sleep |

## State Machine

```
pending → confirmed → shipped
pending → cancelled
confirmed → cancelled
```
