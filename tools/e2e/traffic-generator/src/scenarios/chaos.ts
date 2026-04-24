import type { Pool } from 'undici';
import { runWorkload, type RequestResult } from '../lib/workload.js';
import { config, type ScenarioConfig } from '../config.js';

// Chaos scenario: hits /v1/orders/slow on orders-api directly to generate latency-SLO burns.
// Requires --direct flag and --api-key (CLI handles this; config provides defaults).

async function makeRequest(pool: Pool, _cfg: ScenarioConfig): Promise<RequestResult> {
  const start = performance.now();
  let statusCode = 0;
  try {
    const resp = await pool.request({
      path: '/v1/orders/slow',
      method: 'GET',
      headers: { 'x-api-key': config.ordersApiKey },
    });
    statusCode = resp.statusCode;
    await resp.body.text();
    const latencyMs = Math.round(performance.now() - start);
    return { latencyMs, statusCode, outcome: statusCode < 400 ? 'success' : 'error' };
  } catch {
    return { latencyMs: Math.round(performance.now() - start), statusCode: 0, outcome: 'timeout' };
  }
}

export async function run(cfg: ScenarioConfig): Promise<void> {
  // Chaos always hits orders-api directly (bypasses checkout-bff)
  await runWorkload({ ...cfg, url: config.ordersApiUrl }, makeRequest);
}
