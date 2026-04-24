# traffic-generator

Realistic load generator for polyglot-sre-platform. Hits checkout-bff to exercise the full
`client → checkout-bff → orders-api → Redis → notifier-worker` chain.

## Quick start

```bash
cd tools/e2e/traffic-generator
npm install
npx tsx src/index.ts steady --rps 5
```

Or via Makefile from repo root:

```bash
make traffic-steady      # 5 RPS steady
make traffic-spike       # ramp 1 → 50 RPS over 50s (5-min run)
make traffic-mixed       # 80% valid / 20% validation-fail
make traffic-chaos       # hit /slow for SLO burn demos
```

## Scenarios

| Scenario | Description | Default RPS |
|----------|-------------|-------------|
| `steady` | Constant RPS, randomly rotates SKUs and customer IDs. Good for Week 2+ Grafana demos. | 5 |
| `spike` | Ramps 1 → target RPS over 50s then sustains. Shows auto-scaling signals. | 50 |
| `mixed` | 80% valid / 20% validation-fail mix. Exercises error counters and alert rules. | 10 |
| `chaos` | Hits `orders-api /v1/orders/slow` directly at low RPS to burn latency SLOs. | 2 |

## Options

```
polyglot-traffic <scenario> [options]

Options:
  -r, --rps <n>                Requests per second (default: 5)
  -d, --duration <secs>        Run duration — omit for forever (Ctrl-C to stop)
  -u, --url <url>              checkout-bff base URL (default: from env or localhost:8081)
  -c, --concurrency <n>        Max in-flight requests (default: 10)
  -s, --stats-interval <secs>  Print rolling stats every N seconds (default: 5)
  --customers <n>              Rotate through N customer IDs (default: 10)
  --direct                     (chaos only) Hit orders-api directly
  --api-key <key>              API key for direct mode
```

## Sample output

```
─── traffic-generator [steady] ─── t=00:01:30 ───
RPS (last 60s):      4.98
Success:             287 (96.0%)
Payment failed:      6 (2.0%)
Validation:          0 (0.0%)
5xx errors:          4 (1.3%)
Timeouts:            2 (0.7%)

Latency (ms):        p50=42   p95=178   p99=421
In-flight:           3 / 10

Press Ctrl-C to stop.
```

Stats are printed to **stderr** so stdout stays clean for piping.

## Leave running for Grafana (Week 2+)

```bash
# Terminal 1
make dev-up

# Terminal 2 — keeps Grafana dashboards populated
make traffic-steady

# Watch stats from outside
npx tsx src/index.ts steady --rps 10 2>/tmp/traffic-stats.txt &
watch -n 2 'tail -20 /tmp/traffic-stats.txt'
```

## SLO burn demo

```bash
# Generate slow requests to trigger latency alert rules
make traffic-chaos
# or:
npx tsx src/index.ts chaos --rps 2 --direct --api-key dev-api-key-change-me
```
