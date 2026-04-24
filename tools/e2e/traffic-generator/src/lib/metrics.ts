export type Outcome = 'success' | 'payment_failed' | 'validation_error' | 'error' | 'timeout';

export interface Sample {
  ts: number;
  latencyMs: number;
  statusCode: number;
  outcome: Outcome;
}

export class RollingMetrics {
  private samples: Sample[] = [];
  private readonly windowMs: number;
  private totalRequests = 0;
  private windowStart = Date.now();

  constructor(windowSeconds = 60) {
    this.windowMs = windowSeconds * 1000;
  }

  record(sample: Sample): void {
    this.samples.push(sample);
    this.totalRequests++;
  }

  private prune(): Sample[] {
    const cutoff = Date.now() - this.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
    return this.samples;
  }

  stats() {
    const samples = this.prune();
    const n = samples.length;
    const elapsedSec = (Date.now() - this.windowStart) / 1000;
    const windowSec = Math.min(elapsedSec, this.windowMs / 1000);

    if (n === 0) {
      return { n: 0, rps: 0, p50: 0, p95: 0, p99: 0, success: 0, paymentFailed: 0, validationError: 0, errors5xx: 0, timeouts: 0, total: this.totalRequests };
    }

    const latencies = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
    const pct = (p: number) => latencies[Math.max(0, Math.floor(n * p) - 1)] ?? latencies[n - 1]!;

    const count = (pred: (s: Sample) => boolean) => samples.filter(pred).length;

    return {
      n,
      rps: windowSec > 0 ? n / windowSec : 0,
      p50: pct(0.5),
      p95: pct(0.95),
      p99: pct(0.99),
      success: count((s) => s.outcome === 'success'),
      paymentFailed: count((s) => s.outcome === 'payment_failed'),
      validationError: count((s) => s.outcome === 'validation_error'),
      errors5xx: count((s) => s.statusCode >= 500),
      timeouts: count((s) => s.outcome === 'timeout'),
      total: this.totalRequests,
    };
  }
}
