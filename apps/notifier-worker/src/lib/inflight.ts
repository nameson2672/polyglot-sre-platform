import { inflightEvents } from './metrics.js';

let count = 0;

export function incInflight(): void {
  count++;
  inflightEvents.inc();
}

export function decInflight(): void {
  count = Math.max(0, count - 1);
  inflightEvents.dec();
}

export async function waitForInflight(maxMs = 10_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (count > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
