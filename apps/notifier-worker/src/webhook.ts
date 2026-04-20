import { fetch } from 'undici';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { webhookDuration } from './lib/metrics.js';
import type { NotificationEvent } from './schemas/event.js';

export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

const RETRY_DELAYS_MS = [0, 200, 800, 2000] as const;

function applyJitter(delayMs: number): number {
  return delayMs + delayMs * 0.5 * (Math.random() * 2 - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callWebhook(
  event: NotificationEvent,
  traceparent?: string,
): Promise<{ attempts: number }> {
  let lastError: Error = new Error('No attempts made');

  // CHAOS: no global retry budget; retry storm possible under sustained 5xx
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = applyJitter(RETRY_DELAYS_MS[attempt]);
      await sleep(delay);
    }

    const start = performance.now();
    let statusLabel = 'error';

    try {
      const response = await fetch(config.WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.WEBHOOK_AUTH_TOKEN}`,
          ...(traceparent ? { traceparent } : {}),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3_000),
      });

      const durationSec = (performance.now() - start) / 1000;
      statusLabel = String(response.status);
      webhookDuration.observe({ status_code: statusLabel }, durationSec);

      logger.debug(
        { event_id: event.event_id, status: response.status, attempt: attempt + 1 },
        'Webhook response received',
      );

      // Non-retryable: client errors except 429 (rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new WebhookError(`Non-retryable HTTP ${response.status}`, response.status, false);
      }

      if (!response.ok) {
        throw new WebhookError(`HTTP error ${response.status}`, response.status, true);
      }

      return { attempts: attempt + 1 };
    } catch (err) {
      const durationSec = (performance.now() - start) / 1000;

      if (err instanceof WebhookError) {
        webhookDuration.observe({ status_code: statusLabel }, durationSec);
        if (!err.retryable) throw err;
        lastError = err;
      } else {
        const isTimeout = err instanceof Error && err.name === 'TimeoutError';
        const label = isTimeout ? 'timeout' : 'error';
        webhookDuration.observe({ status_code: label }, durationSec);
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      logger.warn(
        { event_id: event.event_id, attempt: attempt + 1, error: lastError.message },
        'Webhook attempt failed',
      );
    }
  }

  throw lastError;
}
