import { randomUUID } from 'crypto';
import type { Pool } from 'undici';
import { generateJwt } from '../lib/jwt.js';
import { runWorkload, type RequestResult } from '../lib/workload.js';
import { config, SKUS, CUSTOMER_IDS, type ScenarioConfig } from '../config.js';

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function buildCart(numItems: number) {
  return Array.from({ length: numItems }, () => ({
    sku: randomItem(SKUS),
    qty: Math.floor(Math.random() * 3) + 1,
    unit_price_cents: (Math.floor(Math.random() * 50) + 5) * 100,
  }));
}

async function makeRequest(pool: Pool, cfg: ScenarioConfig): Promise<RequestResult> {
  const customerId = randomItem(CUSTOMER_IDS.slice(0, cfg.customers));
  const jwt = generateJwt(customerId, config.jwtSecret);
  const body = JSON.stringify({
    items: buildCart(Math.floor(Math.random() * 3) + 1),
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
    await resp.body.text(); // drain

    const latencyMs = Math.round(performance.now() - start);
    let outcome: RequestResult['outcome'];
    if (statusCode === 201) outcome = 'success';
    else if (statusCode === 402) outcome = 'payment_failed';
    else if (statusCode === 400) outcome = 'validation_error';
    else outcome = 'error';

    return { latencyMs, statusCode, outcome };
  } catch {
    return {
      latencyMs: Math.round(performance.now() - start),
      statusCode: 0,
      outcome: 'timeout',
    };
  }
}

export async function run(cfg: ScenarioConfig): Promise<void> {
  await runWorkload({ ...cfg, url: config.checkoutBffUrl }, makeRequest);
}
