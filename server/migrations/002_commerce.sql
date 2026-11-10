-- 会员订单补充字段、收藏、用量、异步内容安全跟踪
ALTER TABLE orders ADD COLUMN out_trade_no VARCHAR(32);
ALTER TABLE orders ADD COLUMN plan_days INT;
ALTER TABLE orders ADD COLUMN prepay_id VARCHAR(64);
ALTER TABLE orders ADD COLUMN paid_at TIMESTAMPTZ;
CREATE UNIQUE INDEX idx_orders_out_trade_no ON orders (out_trade_no);

CREATE TABLE favorites (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(24) NOT NULL,
  title VARCHAR(80) NOT NULL,
  cover_url TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_favorites_user_created ON favorites (user_id, created_at);

CREATE TABLE usage_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  kind VARCHAR(24) NOT NULL,
  model VARCHAR(80) NOT NULL,
  unit_price_cny NUMERIC(12, 6),
  cost_cny NUMERIC(12, 6),
  priced BOOLEAN NOT NULL DEFAULT FALSE,
  ref_id VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_user_created ON usage_events (user_id, created_at);
CREATE INDEX idx_usage_ref ON usage_events (ref_id);

CREATE TABLE moderation_tasks (
  trace_id VARCHAR(128) PRIMARY KEY,
  user_id BIGINT,
  task_id UUID NOT NULL,
  source_url TEXT NOT NULL,
  provider VARCHAR(64) NOT NULL,
  model VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
