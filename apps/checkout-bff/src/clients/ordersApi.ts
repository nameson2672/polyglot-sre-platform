import { Pool } from 'undici';
import { config } from '../config.js';
import { ordersApiClientDuration } from '../lib/metrics.js';

export const pool = new Pool(config.ORDERS_API_URL, {
  connections: 10,
  pipelining: 1,
});

export interface OrderItem {
  sku: string;
  qty: number;
  unit_price_cents: number;
}

export interface CreateOrderPayload {
  customer_id: string;
  currency: string;
  items: OrderItem[];
}

export interface Order {
  id: string;
  customer_id: string;
  status: string;
  total_cents: number;
  currency: string;
  items: Array<{
    line_no: number;
    sku: string;
    qty: number;
    unit_price_cents: number;
  }>;
  created_at: string;
  updated_at: string;
}

export interface OrdersListResponse {
  total: number;
  page: number;
  page_size: number;
  items: Order[];
}

export class OrdersApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'OrdersApiError';
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  const baseDelays = [50, 150];
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof OrdersApiError && err.statusCode < 500) {
        throw err; // never retry 4xx
      }
      if (attempt < maxRetries) {
        const base = baseDelays[attempt] ?? 150;
        const jitter = Math.floor(Math.random() * base);
        await new Promise((r) => setTimeout(r, base + jitter));
      }
    }
  }
  throw lastError;
}

interface CallHeaders {
  traceparent?: string;
  'x-request-id'?: string;
  'idempotency-key'?: string;
}

async function callOrdersApi<T>(
  method: string,
  path: string,
  headers: CallHeaders,
  body?: unknown,
): Promise<T> {
  const start = performance.now();
  let statusCode = 0;
  try {
    const reqHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': config.ORDERS_API_KEY,
    };
    if (headers.traceparent) reqHeaders['traceparent'] = headers.traceparent;
    if (headers['x-request-id']) reqHeaders['x-request-id'] = headers['x-request-id'];
    if (headers['idempotency-key']) reqHeaders['idempotency-key'] = headers['idempotency-key'];

    const { statusCode: sc, body: responseBody } = await pool.request({
      method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
      bodyTimeout: 5000,
      headersTimeout: 5000,
    });
    statusCode = sc;

    const text = await responseBody.text();
    if (sc >= 400) {
      throw new OrdersApiError(sc, text);
    }
    return JSON.parse(text) as T;
  } finally {
    ordersApiClientDuration.observe(
      { status_code: String(statusCode) },
      (performance.now() - start) / 1000,
    );
  }
}

export async function createOrder(
  payload: CreateOrderPayload,
  headers: CallHeaders,
): Promise<Order> {
  return withRetry(() => callOrdersApi<Order>('POST', '/v1/orders', headers, payload));
}

export async function listOrders(
  customerId: string,
  page: number,
  pageSize: number,
  headers: CallHeaders,
): Promise<OrdersListResponse> {
  return withRetry(() =>
    callOrdersApi<OrdersListResponse>(
      'GET',
      `/v1/orders?customer_id=${encodeURIComponent(customerId)}&page=${page}&page_size=${pageSize}`,
      headers,
    ),
  );
}

export async function getOrderById(id: string, headers: CallHeaders): Promise<Order> {
  return withRetry(() => callOrdersApi<Order>('GET', `/v1/orders/${id}`, headers));
}
