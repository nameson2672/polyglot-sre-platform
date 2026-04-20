# API Contracts & Shared Types

This document defines the shared domain model and API contracts used across all services in the polyglot SRE platform.

## Domain Types

### Order

```typescript
interface Order {
  id: string;                    // UUID
  customerId: string;           // UUID
  status: OrderStatus;
  totalCents: number;          // Price in cents to avoid floating point issues
  currency: string;            // ISO 3-letter currency code (e.g., "USD")
  items: OrderItem[];
  createdAt: Date;
  updatedAt: Date;
}

type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'cancelled';
```

### OrderItem

```typescript
interface OrderItem {
  orderId: string;             // UUID - foreign key to Order
  lineNo: number;              // Line number within the order (1-based)
  sku: string;                 // Stock keeping unit identifier
  qty: number;                 // Quantity (positive integer)
  unitPriceCents: number;      // Unit price in cents
}
```

### CheckoutRequest

```typescript
interface CheckoutRequest {
  customerId: string;          // UUID
  items: CheckoutItem[];
  idempotencyKey?: string;     // UUID for idempotent processing
}

interface CheckoutItem {
  sku: string;
  qty: number;
  unitPriceCents: number;
}
```

### CheckoutResponse

```typescript
interface CheckoutResponse {
  success: boolean;
  orderId?: string;            // UUID - present if success=true
  error?: string;              // Error message if success=false
  totalCents: number;
}
```

### PaymentRequest

```typescript
interface PaymentRequest {
  orderId: string;             // UUID
  totalCents: number;
  currency: string;
  customerId: string;          // UUID
}

interface PaymentResponse {
  success: boolean;
  transactionId?: string;      // Present if success=true
  error?: string;              // Error message if success=false
  processingTimeMs: number;
}
```

## Event Contracts

### Redis Streams Configuration

- **Stream name**: `orders.events`
- **Consumer group**: `notifier-workers`
- **DLQ stream**: `orders.events.dlq`
- **Consumer timeout**: 30 seconds
- **Max delivery attempts**: 3

### Event Schema

All events in Redis Streams have these fields (stored as strings, parsed on read):

```typescript
interface RedisStreamEvent {
  event_id: string;            // UUID - unique event identifier
  event_type: string;          // Type of event (see EventType below)
  order_id: string;            // UUID - affected order ID
  customer_id: string;         // UUID - customer who owns the order
  occurred_at: string;         // ISO 8601 timestamp
  trace_id: string;            // OpenTelemetry trace ID for distributed tracing
  span_id: string;             // OpenTelemetry span ID for distributed tracing
  payload: string;             // JSON-encoded event-specific data
}

type EventType = 
  | 'order.created'
  | 'order.confirmed'  
  | 'order.shipped'
  | 'order.cancelled'
  | 'payment.attempted'
  | 'payment.completed'
  | 'payment.failed';
```

### Event Payloads

#### order.created

```typescript
interface OrderCreatedPayload {
  order: Order;
  source: 'checkout-bff';
}
```

#### order.confirmed

```typescript
interface OrderConfirmedPayload {
  orderId: string;
  paymentTransactionId: string;
  confirmedAt: Date;
  source: 'orders-api';
}
```

#### order.shipped / order.cancelled

```typescript
interface OrderStatusChangedPayload {
  orderId: string;
  previousStatus: OrderStatus;
  newStatus: OrderStatus;
  reason?: string;             // Optional reason for cancellation
  source: 'orders-api';
}
```

#### payment.attempted / payment.completed / payment.failed

```typescript
interface PaymentEventPayload {
  orderId: string;
  paymentRequest: PaymentRequest;
  paymentResponse?: PaymentResponse;  // Present for completed/failed events
  attemptNumber: number;       // 1-based attempt counter
  source: 'checkout-bff';
}
```

## HTTP API Endpoints

### orders-api (Port 8080)

- `POST /orders` - Create new order
- `GET /orders/{id}` - Get order by ID  
- `PUT /orders/{id}/status` - Update order status
- `GET /orders/customer/{customerId}` - Get orders for customer
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

### checkout-bff (Port 8081)

- `POST /checkout` - Process checkout request
- `GET /checkout/{orderId}/status` - Get checkout status
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

### notifier-worker (Port 8082)

- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics
- `GET /status` - Worker status and consumer group info

## Error Handling

### Standard Error Response

```typescript
interface ErrorResponse {
  error: {
    code: string;              // Machine-readable error code
    message: string;           // Human-readable error message
    details?: any;             // Optional additional error details
    traceId?: string;          // Trace ID for debugging
  };
  timestamp: Date;
  path: string;               // API path that generated the error
}
```

### Common Error Codes

- `INVALID_REQUEST` - Malformed or invalid request data
- `ORDER_NOT_FOUND` - Order does not exist
- `CUSTOMER_NOT_FOUND` - Customer does not exist
- `PAYMENT_FAILED` - Payment processing failed
- `INSUFFICIENT_INVENTORY` - Not enough inventory for requested items
- `DUPLICATE_REQUEST` - Idempotency key already used
- `INTERNAL_ERROR` - Unexpected server error

## Authentication & Authorization

### API Key Authentication (orders-api)

- Header: `X-API-Key: <api_key>`
- Used for service-to-service communication

### JWT Authentication (checkout-bff)

- Header: `Authorization: Bearer <jwt_token>`
- Used for customer-facing endpoints
- JWT should contain `customerId` claim

## Content Types

- All HTTP APIs accept and return `application/json`
- All timestamps are in ISO 8601 format (UTC)
- All monetary amounts are in cents to avoid floating point precision issues