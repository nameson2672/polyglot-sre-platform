import { Pool } from 'undici';
import chalk from 'chalk';
import { RollingMetrics, type Sample } from './metrics.js';
import { getPool, closeAllPools } from './client.js';
import type { ScenarioConfig } from '../config.js';

export interface RequestResult {
  latencyMs: number;
  statusCode: number;
  outcome: Sample['outcome'];
}

export type RequestFn = (pool: Pool, config: ScenarioConfig) => Promise<RequestResult>;

class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(n: number) {
    this.permits = n;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  get inFlight(): number {
    return this.permits; // tracks how many are NOT in-flight
  }
}

function formatTime(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function printStats(
  metrics: RollingMetrics,
  config: ScenarioConfig,
  inFlight: number,
  startMs: number,
): void {
  const s = metrics.stats();
  const t = formatTime(startMs);

  process.stderr.write('\x1b[2J\x1b[H'); // clear screen

  const line = (label: string, value: string) =>
    process.stderr.write(`${chalk.cyan(label.padEnd(20))} ${value}\n`);

  process.stderr.write(
    chalk.bold(`─── traffic-generator [${config.scenario}] ─── t=${t} ───\n`),
  );
  line('RPS (last 60s):', s.rps.toFixed(2));
  line('Success:', `${s.success} (${s.n > 0 ? ((s.success / s.n) * 100).toFixed(1) : 0}%)`);
  line('Payment failed:', `${s.paymentFailed} (${s.n > 0 ? ((s.paymentFailed / s.n) * 100).toFixed(1) : 0}%)`);
  line('Validation:', `${s.validationError} (${s.n > 0 ? ((s.validationError / s.n) * 100).toFixed(1) : 0}%)`);
  line('5xx errors:', `${s.errors5xx} (${s.n > 0 ? ((s.errors5xx / s.n) * 100).toFixed(1) : 0}%)`);
  line('Timeouts:', `${s.timeouts} (${s.n > 0 ? ((s.timeouts / s.n) * 100).toFixed(1) : 0}%)`);
  process.stderr.write('\n');
  line('Latency (ms):', `p50=${s.p50}   p95=${s.p95}   p99=${s.p99}`);
  line('In-flight:', `${inFlight} / ${config.concurrency}`);
  process.stderr.write('\nPress Ctrl-C to stop.\n');
}

function printFinalSummary(metrics: RollingMetrics, config: ScenarioConfig, startMs: number): void {
  const s = metrics.stats();
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  process.stderr.write('\n');
  process.stderr.write(chalk.bold('─── Final Summary ───────────────────────────────────\n'));
  process.stderr.write(`Scenario:    ${config.scenario}\n`);
  process.stderr.write(`Duration:    ${elapsed}s\n`);
  process.stderr.write(`Total reqs:  ${s.total}\n`);
  process.stderr.write(`Success:     ${s.success} (${s.n > 0 ? ((s.success / s.n) * 100).toFixed(1) : 0}%)\n`);
  process.stderr.write(`Latency:     p50=${s.p50}ms  p95=${s.p95}ms  p99=${s.p99}ms\n`);
  process.stderr.write('─────────────────────────────────────────────────────\n');
}

export async function runWorkload(
  config: ScenarioConfig,
  requestFn: RequestFn,
  getRps?: () => number, // for spike scenario dynamic RPS
): Promise<void> {
  const metrics = new RollingMetrics(60);
  const startMs = Date.now();
  let inFlight = 0;
  let stopped = false;

  const sem = new Semaphore(config.concurrency);
  const pool = getPool(config.url);

  const statsHandle = setInterval(
    () => printStats(metrics, config, inFlight, startMs),
    config.statsInterval * 1000,
  );

  const onStop = () => {
    stopped = true;
  };
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);

  // Rate limiter: track when the next request should fire
  let nextFireMs = Date.now();

  const fireOne = () => {
    inFlight++;
    sem.acquire().then(async () => {
      const reqStart = performance.now();
      let result: RequestResult;
      try {
        result = await requestFn(pool, config);
      } catch {
        result = { latencyMs: Math.round(performance.now() - reqStart), statusCode: 0, outcome: 'timeout' };
      } finally {
        inFlight--;
        sem.release();
      }
      metrics.record({ ts: Date.now(), ...result });
    }).catch(() => {
      inFlight--;
    });
  };

  while (!stopped) {
    if (config.duration !== undefined && Date.now() - startMs >= config.duration * 1000) break;

    const currentRps = getRps ? getRps() : config.rps;
    const intervalMs = 1000 / Math.max(currentRps, 0.1);

    const now = Date.now();
    const waitMs = nextFireMs - now;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(waitMs, 100)));
      continue;
    }

    nextFireMs = Math.max(now, nextFireMs) + intervalMs;
    fireOne();
  }

  clearInterval(statsHandle);
  process.off('SIGINT', onStop);
  process.off('SIGTERM', onStop);

  // Drain in-flight requests (up to 10s)
  const drainDeadline = Date.now() + 10_000;
  while (inFlight > 0 && Date.now() < drainDeadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  printFinalSummary(metrics, config, startMs);
  await closeAllPools();
}
