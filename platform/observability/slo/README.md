# SLOs & Burn-Rate Alerting (Pyrra)

Service Level Objectives for the three core services, defined with
[Pyrra](https://github.com/pyrra-dev/pyrra) (**v0.10.1**). Pyrra turns each
`ServiceLevelObjective` into Prometheus recording rules plus Google-SRE
**multi-window, multi-burn-rate** alerting rules — we do not hand-write burn-rate math.

## SLOs

| Service | SLO | Type | Target (4w window) | Indicator metric |
|---|---|---|---|---|
| orders-api | `orders-api-latency` | latency | 95% < 500ms | `http_server_request_duration_seconds` (OTLP) |
| orders-api | `orders-api-availability` | ratio | 99.5% non-5xx | `http_server_request_duration_seconds_count` |
| checkout-bff | `checkout-bff-latency` | latency | 95% < 500ms | `http_server_duration_seconds` (prom-client) |
| checkout-bff | `checkout-bff-availability` | ratio | 99.5% non-5xx | `http_server_duration_seconds_count` (4xx like 402 excluded) |
| notifier-worker | `notifier-worker-latency` | latency | 95% < 500ms | `notifier_event_processing_duration_seconds` (event processing, not HTTP) |
| notifier-worker | `notifier-worker-availability` | ratio | 99.5% success | `notifier_events_consumed_total{status}` |

**Saturation (CPU/memory) is intentionally NOT a Pyrra SLO** — utilisation does not fit an
error-budget/burn-rate model. It's a plain threshold `PrometheusRule` in `saturation/`
(>85% of limit for 10m → Slack). Those rules use in-cluster cAdvisor / kube-state-metrics
series and therefore only fire in the cluster.

## Layout

```text
pyrra/         Vendored upstream install manifests (CRD + operator + UI), pinned to v0.10.1
definitions/   The 6 ServiceLevelObjective CRs (shared by local + cluster)
saturation/    Plain PrometheusRule for CPU/memory thresholds (cluster-only)
```

## Alert routing (Google SRE)

Pyrra emits `alertname=ErrorBudgetBurn` with `severity` + `slo` labels across four windows
(5m/1h + 30m/6h = `critical`, 2h/1d + 6h/4d = `warning`). Routing:

- `ErrorBudgetBurn`, `severity=critical` → **PagerDuty + Slack**
- `ErrorBudgetBurn`, `severity=warning` → **Slack**
- `kind=saturation` → **Slack**

Local routing lives in [`../local/alertmanager.yml`](../local/alertmanager.yml); cluster
routing in [`../kube-prometheus-stack/values.yaml`](../kube-prometheus-stack/values.yaml)
(`alertmanager.config`). Both read the Slack webhook + PagerDuty routing key via `*_file`.

## Cluster deployment (Argo CD)

Two app-of-apps Applications:
- `platform/argocd/apps/pyrra.yaml` (wave 7) — CRD + operator + UI.
- `platform/argocd/apps/slo-definitions.yaml` (wave 8) — the SLO CRs + saturation rule.

The Pyrra operator writes `PrometheusRule` objects; `ruleSelectorNilUsesHelmValues: false`
in the kube-prometheus-stack values makes Prometheus load them. Alertmanager secrets come
from Infisical via `../secrets/alertmanager-pyrra-external.yaml` (needs
`SLACK_SLO_WEBHOOK_URL` and `PAGERDUTY_ROUTING_KEY`).

## Local validation

The same SLO definitions are rendered locally by the `pyrra` service (filesystem mode) in
`docker-compose.monitoring.yml` into `../local/pyrra-rules/`, loaded by the bundled
Prometheus, with a local `alertmanager` for routing.

```bash
# 1. Bring up the stack (pyrra generates rules, alertmanager starts)
docker compose -f docker-compose.monitoring.yml up -d

# 2. Prometheus loads rule files at startup; reload after pyrra generates them
docker compose -f docker-compose.monitoring.yml restart otel-lgtm

# 3. (optional) real Slack delivery: drop a test webhook into the gitignored file
cp platform/observability/local/secrets/slack_api_url.example \
   platform/observability/local/secrets/slack_api_url   # then edit it

# 4. Confirm rules + routing
curl -s localhost:9090/api/v1/rules | jq '.data.groups[].name'
docker exec polyglot-alertmanager amtool config routes test \
  --config.file=/etc/alertmanager/alertmanager.yml alertname=ErrorBudgetBurn severity=critical

# 5. Drive a latency burn against orders-api /v1/orders/slow (note: --direct + correct URL/key)
cd tools/e2e/traffic-generator
ORDERS_API_URL=http://localhost:8080 npx tsx src/index.ts chaos \
  --rps 12 --duration 600 --direct --api-key dev-api-key-change-me
# watch localhost:9090/alerts and localhost:9093 for ErrorBudgetBurn (orders-api-latency)
```

Pyrra filesystem API: <http://localhost:9444> (the full web UI is the in-cluster
`pyrra-api` component). Prometheus: <http://localhost:9090>.
Alertmanager: <http://localhost:9093>.
