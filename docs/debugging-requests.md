# Debugging a Failing Request (tracing a 500)

How to go from "I'm seeing 500s" to the exact line that failed, using the platform's
traces (Tempo), logs (Loki) and metrics (Prometheus). Every request carries a W3C
`traceparent` that propagates across **all** hops — including the async Redis-stream
boundary — so one trace ID tells the whole story.

## Request flow

```
client
  │  POST /v1/checkout            (traceparent generated here)
  ▼
checkout-bff :8081 ──HTTP──▶ orders-api :8080 ──▶ Postgres :5432
                                   │                 Redis :6379
                                   │ transactional outbox
                                   ▼
                         Redis stream "orders.events"   (trace_id/span_id embedded)
                                   ▼
                         notifier-worker :8082 ──HTTP──▶ webhook-sink :8083
```

A 500 can surface in `checkout-bff` (its own bug, or it surfaces an orders-api failure
as 503) or in `orders-api` (DB error, unhandled exception). Both now mark their span as
**errored** with the exception attached, so the failing request is filterable in Tempo.

## Get access to the dashboards

```bash
make port-forward     # cluster: forwards Grafana/Tempo/Loki/Prometheus to localhost
# — or, for the local docker stack —
make obs-up           # local LGTM, then generate traffic (make traffic-steady)
```

| UI | URL |
|----|-----|
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Loki (via Grafana Explore) | http://localhost:3100 |
| Tempo (via Grafana Explore) | http://localhost:3200 |

## Step 1 — Spot the 5xx (which service, how bad)

Grafana → **Explore** → **Prometheus**, or Prometheus at :9090:

```promql
# 5xx request rate per service over the last 5 minutes
sum(rate(http_server_duration_seconds_count{status_code=~"5.."}[5m])) by (service_name)

# as a percentage of all traffic for that service
sum(rate(http_server_duration_seconds_count{status_code=~"5.."}[5m])) by (service_name)
  / sum(rate(http_server_duration_seconds_count[5m])) by (service_name) * 100
```

A non-zero series tells you **which** service is erroring. Note the `service_name`.

## Step 2 — Find the failing trace

Grafana → **Explore** → **Tempo** → **TraceQL**:

```traceql
{ status = error }                                  # every errored span (works now that 500s set ERROR)
{ span.http.response.status_code >= 500 }           # filter by HTTP status specifically
{ resource.service.name = "orders-api" && status = error }   # scope to one service
```

Each result row is a failing request. Click one to open the waterfall.

## Step 3 — Read the waterfall (where it broke)

In the trace view:

- The **red span** is the failing operation. The waterfall shows the chain
  (`checkout-bff` POST → `orders-api` POST → EF Core `db` span, etc.) so you can see how
  far the request got before it died.
- Open the red span's **events** → the `exception` event carries the **stack trace**
  (`exception.type`, `exception.message`, `exception.stacktrace`).
- Check span attributes: `db.statement` (the failing query), `http.url`, `http.method`,
  and the span **duration** (was it a timeout?).

## Step 4 — Jump to the correlated logs

From the red span, click **Logs** (Tempo → Loki correlation is preconfigured via
`tracesToLogsV2`). Or query Loki directly in **Explore** → **Loki**:

```logql
{service_name="orders-api"} | json | trace_id="<paste-trace-id>"   # everything for this request
{service_name="orders-api"} | json | level="error"                # recent errors, then grab the trace_id
{service_name="checkout-bff"} | json | level="error"
```

The structured log line for the 500 includes the full message (e.g. the
`ProblemDetailsMiddleware` "Unhandled exception at {Path}" entry) plus `trace_id` — and
from a log you can click the trace ID to jump **back** into Tempo (Loki `derivedFields`).

## The async hop (orders-api → notifier-worker)

If the failure is downstream of order creation (webhook delivery), the trace still
continues: `orders-api` stamps `trace_id`/`span_id` onto the Redis stream message in
[OutboxPublisher.cs](../apps/orders-api/src/OrdersApi/Services/OutboxPublisher.cs), and
`notifier-worker` rebuilds the span from those fields
([lib/tracing.ts](../apps/notifier-worker/src/lib/tracing.ts)). So a single trace spans
the HTTP request **and** the eventual webhook call — search the same trace ID to see the
`notifier.process_event` → webhook spans and whether the webhook returned 5xx.

## Quick reference

| Symptom | First query |
|---------|-------------|
| "Which service is 500ing?" | `sum(rate(http_server_duration_seconds_count{status_code=~"5.."}[5m])) by (service_name)` |
| "Show me a failing request" | Tempo: `{ status = error }` |
| "What threw?" | Open red span → `exception` event (stack trace) |
| "Full story for one request" | Loki: `{service_name="<svc>"} | json | trace_id="<id>"` |
| "Did the webhook fail?" | Same trace ID → look for `notifier.process_event` span |
