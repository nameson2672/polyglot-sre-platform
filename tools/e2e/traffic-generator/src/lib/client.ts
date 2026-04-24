import { Pool } from 'undici';

const pools = new Map<string, Pool>();

export function getPool(origin: string): Pool {
  let pool = pools.get(origin);
  if (!pool) {
    pool = new Pool(origin, { connections: 20, pipelining: 1 });
    pools.set(origin, pool);
  }
  return pool;
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.close()));
  pools.clear();
}
