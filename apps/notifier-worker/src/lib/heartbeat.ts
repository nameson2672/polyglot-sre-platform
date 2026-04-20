let lastBeat = Date.now();

export function updateHeartbeat(): void {
  lastBeat = Date.now();
}

export function heartbeatAgeMs(): number {
  return Date.now() - lastBeat;
}

export function isHeartbeatHealthy(maxAgeMs = 30_000): boolean {
  return heartbeatAgeMs() < maxAgeMs;
}
