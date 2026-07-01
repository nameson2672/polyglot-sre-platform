// Probe and scrape paths. These are hit every 10–15s by Kubernetes probes and
// Prometheus, so they must never produce logs (only metrics) — otherwise they
// drown out the logs that matter. Shared by the request logger (skip these) and
// the chaos plugin (never inject errors into them).
export const EXEMPT_PATHS = new Set(['/healthz', '/readyz', '/metrics', '/info']);

export function isExemptPath(url: string): boolean {
  return EXEMPT_PATHS.has(url.split('?')[0]!);
}
