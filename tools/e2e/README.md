# tools/e2e

End-to-end testing and traffic generation for polyglot-sre-platform.

## Smoke test

```bash
make smoke
# or directly:
bash tools/e2e/smoke.sh
```

10 deterministic checks (exits 0 on all pass):

1. All 3 service health probes return 200
2. All 3 `/info` endpoints return a `service` field
3. All 3 `/metrics` endpoints serve Prometheus format
4. Create order via checkout-bff returns a UUID `order_id`
5. Order row exists in Postgres
6. Outbox event published to Redis stream `orders.events`
7. notifier-worker consumed the event (no pending messages)
8. Idempotency: same key returns same `order_id`, 1 DB row
9. Invalid body → 400 Problem Details
10. No auth → 401

Idempotent — safe to run multiple times in a row.

## Traffic generator

See [traffic-generator/README.md](traffic-generator/README.md).

## Fixtures

| File | Purpose |
|------|---------|
| `fixtures/valid-checkout.json` | 2-item valid checkout body |
| `fixtures/invalid-checkout.json` | Missing `items` → triggers 400 |
| `fixtures/large-checkout.json` | 50 line items for payload size testing |

## Lib

| File | Purpose |
|------|---------|
| `lib/assertions.sh` | `pass`/`fail`/`assert_*` helpers — source in bash tests |
| `lib/jwt.sh` | HS256 JWT generator using openssl — source in bash scripts |
