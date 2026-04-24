import { randomUUID } from 'crypto';
import type { Pool } from 'undici';
import { generateJwt } from '../lib/jwt.js';
import { runWorkload, type RequestResult } from '../lib/workload.js';
import { config, SKUS, CUSTOMER_IDS, type ScenarioConfig } from '../config.js';

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function makeRequest(pool: Pool, cfg: ScenarioConfig): Promise<RequestResult> {
  const customerId = randomItem(CUSTOMER_IDS.slice(0, cfg.customers));
  const jwt = generateJwt(customerId, config.jwtSecret);
  const body = JSON.stringify({
    items: [{ sku: randomItem(SKUS), qty: 1, unit_price_cents: 1000 }],
    payment_method: 'card',
    currency: 'USD',
  });

  const start = performance.now();
  let statusCode = 0;
  try {
    const resp = await pool.request({
      path: '/v1/checkout',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${jwt}`,
        'idempotency-key': randomUUID(),
      },
      body,
    });
    statusCode = resp.statusCode;
    await resp.body.text();

    const latencyMs = Math.round(performance.now() - start);
    let outcome: RequestResult['outcome'];
    if (statusCode === 201) outcome = 'success';
    else if (statusCode === 402) outcome = 'payment_failed';
    else if (statusCode === 400) outcome = 'validation_error';
    else outcome = 'error';
    return { latencyMs, statusCode, outcome };
  } catch {
    return { latencyMs: Math.round(performance.now() - start), statusCode: 0, outcome: 'timeout' };
  }
}

export async function run(cfg: ScenarioConfig): Promise<void> {
  // Ramp 1 → targetRps over rampSeconds, then sustain
  const startRps = 1;
  const targetRps = cfg.rps > 1 ? cfg.rps : 50;
  const rampSeconds = 50;
  const startMs = Date.now();

  const getRps = (): number => {
    const elapsed = (Date.now() - startMs) / 1000;
    if (elapsed >= rampSeconds) return targetRps;
    return startRps + ((targetRps - startRps) * elapsed) / rampSeconds;
  };

  await runWorkload({ ...cfg, url: config.checkoutBffUrl, rps: targetRps }, makeRequest, getRps);
}
