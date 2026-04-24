import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load repo-root .env if present (for local development without shell sourcing)
function loadDotenv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../../../..');
  const envPath = resolve(repoRoot, '.env');
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env not required if vars are already in environment
  }
}

loadDotenv();

export const config = {
  checkoutBffUrl: process.env['CHECKOUT_BFF_URL'] ?? `http://localhost:${process.env['CHECKOUT_BFF_PORT'] ?? '8081'}`,
  ordersApiUrl: process.env['ORDERS_API_URL'] ?? `http://localhost:${process.env['ORDERS_API_PORT'] ?? '8080'}`,
  ordersApiKey: process.env['ORDERS_API_KEY'] ?? 'dev-api-key-change-me',
  jwtSecret: process.env['JWT_SECRET'] ?? 'dev-jwt-secret-change-me',
} as const;

export interface ScenarioConfig {
  url: string;
  rps: number;
  duration?: number;
  concurrency: number;
  statsInterval: number;
  customers: number;
  scenario: string;
}

export const SKUS = [
  'SKU-WIDGET-001', 'SKU-GADGET-007', 'SKU-DOOHICKEY-X',
  'SKU-THINGAMAJIG', 'SKU-WHATSIT-42', 'SKU-GIZMO-PRO',
  'SKU-CONTRAPTION', 'SKU-DOODAD-LITE', 'SKU-WIDGET-002', 'SKU-ACCESSORY-Z',
];

export const CUSTOMER_IDS = Array.from({ length: 100 }, (_, i) => {
  const n = String(i + 1).padStart(12, '0');
  return `00000000-0000-0000-0000-${n}`;
});
