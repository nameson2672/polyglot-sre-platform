import { config } from '../config.js';

export class PaymentFailedError extends Error {
  constructor(message = 'Payment declined by stub') {
    super(message);
    this.name = 'PaymentFailedError';
  }
}

export interface PaymentResult {
  transactionId: string;
  processingTimeMs: number;
}

export async function processPayment(
  totalCents: number,
  customerId: string,
): Promise<PaymentResult> {
  // Use params to satisfy strict mode — they are semantically relevant for future real impl
  const _totalCents = totalCents;
  const _customerId = customerId;

  const jitter =
    config.PAYMENT_STUB_LATENCY_JITTER_MS > 0
      ? Math.floor(Math.random() * config.PAYMENT_STUB_LATENCY_JITTER_MS)
      : 0;
  const latency = config.PAYMENT_STUB_LATENCY_MS + jitter;

  await new Promise((resolve) => setTimeout(resolve, latency));

  if (Math.random() < config.PAYMENT_STUB_FAILURE_RATE) {
    throw new PaymentFailedError();
  }

  return {
    transactionId: `txn_${_totalCents}_${_customerId.slice(0, 8)}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    processingTimeMs: latency,
  };
}
