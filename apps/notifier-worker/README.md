# notifier-worker

TypeScript background worker that consumes the `orders.events` Redis Stream and dispatches webhook notifications. Exposes a Fastify sidecar on port 8082 for Kubernetes health probes and Prometheus scraping.

## Architecture

```
Redis Stream: orders.events
        │
        ▼  XREADGROUP (consumer group: notifier-workers)
┌──────────────────┐
│  consumer.ts     │  10 msgs / 5s block / 30s stale reclaim
│  processor.ts    │  parse → validate → trace → webhook
│  webhook.ts      │  undici, 3 retries, exp backoff ±50% jitter
└──────────────────┘
        │ on failure (3 attempts)
        ▼
Redis Stream: orders.events.dlq   (requires ENABLE_DLQ=true)

Sidecar (port 8082): /healthz /readyz /metrics /info
```

## Prerequisites

- Node.js 22 LTS
- Redis 7+ running on localhost:6379
- A webhook receiver URL (get one free at https://webhook.site)

## Local development

```bash
# 1. Start infra (Postgres + Redis)
docker compose up -d

# 2. Configure environment
cd apps/notifier-worker
cp ../../.env.example .env
# Edit .env — set WEBHOOK_URL to your webhook.site URL

# 3. Install and run
npm install
npm run dev
```

## Producing a test event

```bash
redis-cli XADD orders.events '*' \
  event_id "$(uuidgen)" \
  event_type "order.confirmed" \
  order_id "$(uuidgen)" \
  customer_id "00000000-0000-0000-0000-000000000001" \
  occurred_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  trace_id "0af7651916cd43dd8448eb211c80319c" \
  span_id "b7ad6b7169203331" \
  payload '{"total_cents":1000,"currency":"CAD"}'
```

## Probes

```bash
curl http://localhost:8082/healthz   # 200 if loop alive
curl http://localhost:8082/readyz    # 200 if Redis connected + group joined
curl http://localhost:8082/info | jq
curl -s http://localhost:8082/metrics | grep notifier_
```

## Key metrics (SLIs)

| Metric | Description |
|---|---|
| `notifier_consumer_lag` | Pending unacked messages — primary SLI |
| `notifier_events_consumed_total` | Counter by event_type and status |
| `notifier_webhook_duration_seconds` | Webhook latency histogram |
| `notifier_event_processing_duration_seconds` | End-to-end latency |
| `notifier_dlq_events_total` | Messages sent to DLQ |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `NOTIFIER_WORKER_PORT` | `8082` | Sidecar HTTP port |
| `WEBHOOK_URL` | *(required)* | Webhook receiver URL |
| `WEBHOOK_AUTH_TOKEN` | `""` | Bearer token for webhook auth |
| `CONSUMER_GROUP` | `notifier-workers` | Redis consumer group name |
| `ENABLE_DLQ` | `false` | Enable dead-letter queue (set `true` in production) |
| `LOG_LEVEL` | `info` | Pino log level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTel collector endpoint |

## Deliberate chaos behaviors

- **No retry budget**: Total retries across all events are unbounded. Under sustained 5xx from the webhook, this causes a retry storm. Demo in Week 4.
- **Synchronous JSON parsing**: `payload` is parsed synchronously with `JSON.parse`. Large payloads block the Node.js event loop. Demo target for profiling in Week 3.
- **DLQ disabled by default**: Set `ENABLE_DLQ=true` to enable the dead-letter queue. Week 5 postmortem action item.

## Scripts

```bash
npm run dev        # Run with tsx (hot reload friendly)
npm run build      # Compile TypeScript → dist/
npm run start      # Run compiled output
npm run test       # Run vitest
npm run typecheck  # Type check without emitting
npm run lint       # ESLint
npm run format     # Prettier
```

## Docker

```bash
docker build -t polyglot-sre/notifier-worker:dev .
docker run --rm \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e WEBHOOK_URL=https://webhook.site/YOUR-UUID \
  -p 8082:8082 \
  polyglot-sre/notifier-worker:dev
```
