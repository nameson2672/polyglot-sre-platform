CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY,
  customer_id     UUID NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','confirmed','shipped','cancelled')),
  total_cents     BIGINT NOT NULL CHECK (total_cents >= 0),
  currency        CHAR(3) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status) WHERE status != 'shipped';

CREATE TABLE IF NOT EXISTS order_items (
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no          INT NOT NULL,
  sku              TEXT NOT NULL,
  qty              INT NOT NULL CHECK (qty > 0),
  unit_price_cents BIGINT NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           UUID PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  response_body JSONB NOT NULL,
  response_code INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID NOT NULL UNIQUE,
  event_type   TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox(created_at) WHERE published_at IS NULL;