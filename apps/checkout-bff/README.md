# checkout-bff

Backend-for-Frontend service that orchestrates checkout flows for the polyglot SRE platform. Wraps `orders-api` with payment stubbing, Redis caching, JWT identity extraction, Prometheus metrics, and OpenTelemetry tracing.

## Architecture

```
client → checkout-bff (:8081)
            ├── payment stub (configurable latency + failure rate)
            ├── orders-api (:8080)  [X-Api-Key, Idempotency-Key, retry w/ backoff]
            └── Redis (:6379)       [session cache, order list cache]
```

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | /healthz | Liveness probe |
| GET | /readyz | Readiness probe (checks orders-api + Redis) |
| GET | /info | Service metadata |
| GET | /metrics | Prometheus metrics |
| POST | /v1/checkout | Initiate checkout (requires `Idempotency-Key` header) |
| GET | /v1/checkout/:id | Get checkout session from cache |
| POST | /v1/checkout/:id/confirm | Confirm checkout session |
| GET | /v1/checkout/leak | CHAOS: fd leak demo — never use in production |
| GET | /v1/customer/orders | Paginated order list for authenticated customer |

## Running locally

```bash
cp ../../.env.example .env
# edit .env as needed

npm install
npm run dev
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHECKOUT_BFF_PORT` | `8081` | HTTP listen port |
| `ORDERS_API_URL` | — | Base URL for orders-api |
| `ORDERS_API_KEY` | — | API key sent as `X-Api-Key` |
| `JWT_SECRET` | — | JWT verification secret (stub decoder only checks structure) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `PAYMENT_STUB_LATENCY_MS` | `300` | Base latency for payment stub |
| `PAYMENT_STUB_FAILURE_RATE` | `0.02` | Fraction of payments that fail (0–1) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP gRPC endpoint |
| `LOG_LEVEL` | `info` | Pino log level |
| `APP_ENV` | `dev` | Enables pino-pretty in dev mode |

## Auth

JWT tokens are decoded from the `Authorization: Bearer <token>` header. The stub decoder reads `customer_id` from the payload without verifying the signature (dev only). Replace `jwtStub.ts` with `@fastify/jwt` verification for production.

## Chaos endpoints

`GET /v1/checkout/leak` intentionally creates a new `undici.Agent` per request without closing it, demonstrating a file descriptor leak. This is for SRE training purposes only.

## Tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

## Build

```bash
npm run build     # TypeScript → dist/
npm run typecheck # type-check without emit
npm run lint      # ESLint
```

## Docker

```bash
docker build -t checkout-bff .
docker run -p 8081:8081 --env-file .env checkout-bff
```
