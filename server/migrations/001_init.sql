-- 一身好看 初始表结构（PostgreSQL；MySQL 只需把 JSONB 改 JSON、TIMESTAMPTZ 改 DATETIME）
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  openid VARCHAR(64) UNIQUE NOT NULL,
  member_level VARCHAR(16) NOT NULL DEFAULT 'free',
  member_expire_at TIMESTAMPTZ,
  face_consent_at TIMESTAMPTZ,
  consent_version VARCHAR(16),
  age_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body_type VARCHAR(16), undertone VARCHAR(8), season VARCHAR(8), contrast VARCHAR(8),
  face_shape VARCHAR(16), hair_length VARCHAR(16), makeup_level VARCHAR(16),
  user_corrections JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state VARCHAR(24) NOT NULL, slots JSONB NOT NULL DEFAULT '{}', skipped_steps TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY, session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role VARCHAR(12) NOT NULL, content TEXT NOT NULL, provider VARCHAR(64), tokens INT, latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE looks (
  id BIGSERIAL PRIMARY KEY, session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  look_spec JSONB NOT NULL, favorited BOOLEAN NOT NULL DEFAULT FALSE, affiliate_links JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE images (
  id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('body','face','garment','tryon','lip','fulllook')),
  oss_key TEXT NOT NULL, provider VARCHAR(32), ai_label BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_result JSONB, expire_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_images_expire ON images (expire_at) WHERE deleted_at IS NULL;
-- 渲染任务：UUID 主键，前端轮询 /render/tasks/:id
CREATE TABLE render_tasks (
  id UUID PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  look_id BIGINT REFERENCES looks(id) ON DELETE CASCADE,
  kind VARCHAR(12) NOT NULL, provider VARCHAR(32) NOT NULL, provider_task_id VARCHAR(128),
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING', result_url TEXT, error TEXT, ai_label JSONB,
  cost_cny NUMERIC(8,4), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_render_tasks_user ON render_tasks (user_id, created_at);
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), sku VARCHAR(32) NOT NULL,
  amount_fen INT NOT NULL, status VARCHAR(12) NOT NULL, wx_transaction_id VARCHAR(64), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, action VARCHAR(32) NOT NULL, detail JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
