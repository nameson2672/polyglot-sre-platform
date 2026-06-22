# Observability Dashboards & Metrics Scraping

How Grafana dashboards and the apps' custom `/metrics` get wired up — both locally
(`docker-compose` / `otel-lgtm`) and in the cluster (k8s / ArgoCD). The **same dashboard JSON**
([platform/observability/dashboards/json/polyglot-telemetry-health.json](platform/observability/dashboards/json/polyglot-telemetry-health.json))
is the single source of truth for both. Datasource UIDs (`prometheus`, `loki`, `tempo`) are
identical in both environments, so the JSON is portable unchanged.

## The two gaps this solves

1. **Dashboards weren't provisioned** — Grafana came up empty. We commit dashboard JSON to the
   repo and auto-load it.
2. **Custom `/metrics` weren't in Prometheus** — `orders-api` exports its custom metrics over
   OTLP, but `checkout-bff` and `notifier-worker` expose prom-client metrics
   (`checkout_attempts_total`, `payment_stub_*`, `notifier_events_consumed_total`,
   `notifier_consumer_lag`, …) on a `/metrics` endpoint that nothing scraped. We scrape them.

> `orders-api` has no `/metrics` endpoint (metrics flow via OTLP); `webhook-sink` emits no
> OTLP/metrics. So only `checkout-bff` and `notifier-worker` are scraped.

---

## Local (docker-compose) — already wired

The all-in-one `grafana/otel-lgtm` container is configured via three read-only mounts in
[docker-compose.monitoring.yml](docker-compose.monitoring.yml):

| File | Mounted to | Purpose |
|------|------------|---------|
| [platform/observability/local/prometheus.yaml](platform/observability/local/prometheus.yaml) | `/otel-lgtm/prometheus.yaml` | bundled OTLP config **+ scrape_configs** for the apps' `/metrics` |
| [platform/observability/dashboards/provider.yaml](platform/observability/dashboards/provider.yaml) | `/otel-lgtm/grafana/conf/provisioning/dashboards/polyglot.yaml` | Grafana dashboard provider → "Polyglot" folder |
| [platform/observability/dashboards/json/](platform/observability/dashboards/json/) | `/var/lib/grafana/dashboards/polyglot` | the dashboard JSON files |

Run / refresh:

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

Then open <http://localhost:3000> → **Dashboards → Polyglot → Polyglot Telemetry Health**.

---

## Kubernetes (ArgoCD) — for the new cluster

In-cluster the data paths differ but the gaps are the same, so there are k8s equivalents:

| Concern | Local | Kubernetes |
|---------|-------|------------|
| Dashboard delivery | Grafana file provider + mounted JSON | Grafana **sidecar** imports a **ConfigMap** labeled `grafana_dashboard=1` |
| `/metrics` scraping | Prometheus `scrape_configs` | **ServiceMonitor** per app (Prometheus Operator) |

### What's committed

- [platform/observability/dashboards/k8s/polyglot-dashboards-configmap.yaml](platform/observability/dashboards/k8s/polyglot-dashboards-configmap.yaml)
  — the dashboard JSON inlined into a ConfigMap (namespace `monitoring`, label
  `grafana_dashboard: "1"`, annotation `grafana_folder: Polyglot`).
- [platform/observability/dashboards/k8s/servicemonitor-checkout-bff.yaml](platform/observability/dashboards/k8s/servicemonitor-checkout-bff.yaml)
  and [servicemonitor-notifier-worker.yaml](platform/observability/dashboards/k8s/servicemonitor-notifier-worker.yaml)
  — scrape `/metrics` on the `http` port of the apps in namespace `dev`.
- [platform/observability/kube-prometheus-stack/values.yaml](platform/observability/kube-prometheus-stack/values.yaml)
  — `grafana.sidecar.dashboards` block (label + Polyglot folder).
- [platform/argocd/apps/polyglot-observability.yaml](platform/argocd/apps/polyglot-observability.yaml)
  — ArgoCD `directory` Application (sync-wave `7`) that syncs the `k8s/` folder above.

### What you need to do (new cluster)

Because the bootstrap ArgoCD app
([platform/argocd/bootstrap/argocd.yaml](platform/argocd/bootstrap/argocd.yaml)) syncs
`platform/argocd/` **recursively**, there is **no manual `kubectl apply`** for these resources —
they roll out via GitOps. Steps:

1. **Commit & push** these files to `main`.
2. Bring up the cluster and bootstrap ArgoCD as usual (the existing flow). ArgoCD picks up the new
   `polyglot-observability` Application automatically and syncs it at wave 7 (after the monitoring
   stack and the app workloads exist).
3. The `kube-prometheus-stack` Application re-syncs the `grafana.sidecar` values change; the
   Grafana pod restarts to pick up the sidecar settings.

### Verify in-cluster

Once `kubectl` is configured for the new cluster:

```bash
# App synced & healthy
kubectl get application polyglot-observability -n argocd

# Dashboard ConfigMap present and labeled
kubectl get configmap polyglot-dashboards -n monitoring --show-labels

# ServiceMonitors present
kubectl get servicemonitor -n monitoring checkout-bff notifier-worker
```

- Grafana → folder **Polyglot** → **Polyglot Telemetry Health** loads and panels render.
- Prometheus UI → **Status → Targets**: `checkout-bff` and `notifier-worker` `/metrics` targets
  are **up**; `checkout_attempts_total` and `notifier_events_consumed_total` return series
  carrying a `service_name` label.

### One thing to confirm

The dashboard pins the Prometheus datasource UID to `prometheus`. Loki/Tempo UIDs are pinned by
our values (`additionalDataSources`), and kube-prometheus-stack provisions Prometheus with
UID `prometheus` by default. If the Prometheus panels show **"datasource not found"**, the chart
assigned a different UID — fix by either setting that UID in the chart values or adding a
Prometheus *datasource template variable* to the dashboard JSON.

---

## Adding more dashboards later

1. Drop the new dashboard JSON in `platform/observability/dashboards/json/` (auto-loads locally).
2. Add it to the k8s ConfigMap as another key under `data:` (or create another ConfigMap labeled
   `grafana_dashboard: "1"`). Regenerate the inlined JSON with:

   ```bash
   kubectl create configmap polyglot-dashboards -n monitoring \
     --from-file=platform/observability/dashboards/json/ \
     --dry-run=client -o yaml
   ```

   then re-add the `grafana_dashboard: "1"` label and `grafana_folder: Polyglot` annotation.
   (`--dry-run=client` is local-only; it does not need a cluster.)
