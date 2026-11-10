import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMsg } from '../llm/client.js';
import type { Favorite, ImageRow, ModerationPending, Order, RenderTask, Repo, Session, UsageInput, UsageRow } from './types.js';

/** 只依赖 query 方法，pg.Pool 与 pg-mem 的适配器都满足 */
export type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>; end?: () => Promise<void> };

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** 顺序执行 migrations/*.sql，schema_migrations 记录已执行文件 */
export async function migrate(db: Queryable, dir = MIG_DIR) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await db.query(readFileSync(join(dir, f), 'utf8'));
    await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
  }
}

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const toImg = (r: any): ImageRow => ({ id: r.id, userId: String(r.user_id), kind: r.kind, ossKey: r.oss_key, expireAt: r.expire_at ? new Date(r.expire_at) : null, aiLabel: r.ai_label, provider: r.provider ?? undefined });
const toTask = (r: any): RenderTask => ({ id: r.id, userId: String(r.user_id), kind: r.kind, provider: r.provider, providerTaskId: r.provider_task_id ?? undefined, status: r.status, resultUrl: r.result_url ?? undefined, error: r.error ?? undefined, aiLabel: r.ai_label ? json(r.ai_label) : undefined, costCny: r.cost_cny == null ? undefined : Number(r.cost_cny), createdAt: r.created_at ? new Date(r.created_at) : undefined });
const toOrder = (r: any): Order => ({ id: String(r.id), userId: String(r.user_id), sku: r.sku, amountFen: Number(r.amount_fen), planDays: Number(r.plan_days ?? 0), status: r.status, outTradeNo: r.out_trade_no, prepayId: r.prepay_id ?? undefined, wxTransactionId: r.wx_transaction_id ?? undefined, paidAt: r.paid_at ? new Date(r.paid_at) : null });
const toFav = (r: any): Favorite => ({ id: r.id, userId: String(r.user_id), kind: r.kind, title: r.title, coverUrl: r.cover_url ?? undefined, payload: json(r.payload) ?? {}, createdAt: new Date(r.created_at) });
const toUsage = (r: any): UsageRow => ({ userId: r.user_id == null ? null : String(r.user_id), kind: r.kind, model: r.model, unitPriceCny: r.unit_price_cny == null ? null : Number(r.unit_price_cny), costCny: r.cost_cny == null ? null : Number(r.cost_cny), priced: !!r.priced, refId: r.ref_id ?? undefined, createdAt: new Date(r.created_at) });
const toMod = (r: any): ModerationPending => ({ traceId: r.trace_id, userId: String(r.user_id), taskId: r.task_id, sourceUrl: r.source_url, provider: r.provider, model: r.model });

export class PgRepo implements Repo {
  constructor(private db: Queryable) {}
  async upsertUser(openid: string) {
    const r = await this.db.query('INSERT INTO users(openid) VALUES ($1) ON CONFLICT (openid) DO UPDATE SET openid = EXCLUDED.openid RETURNING id', [openid]);
    return String(r.rows[0].id);
  }
  async getOpenid(userId: string) {
    const r = await this.db.query('SELECT openid FROM users WHERE id = $1', [userId]);
    return r.rows[0]?.openid ?? null;
  }
  async getMember(userId: string) {
    const r = await this.db.query('SELECT member_level, member_expire_at FROM users WHERE id = $1', [userId]);
    const x = r.rows[0];
    return { level: x?.member_level ?? 'free', expireAt: x?.member_expire_at ? new Date(x.member_expire_at) : null };
  }
  async setMember(userId: string, level: string, expireAt: Date) {
    await this.db.query('UPDATE users SET member_level = $2, member_expire_at = $3 WHERE id = $1', [userId, level, expireAt]);
  }
  async setFaceConsent(userId: string, agree: boolean, version: string) {
    await this.db.query('UPDATE users SET face_consent_at = $2, consent_version = $3 WHERE id = $1', [userId, agree ? new Date() : null, agree ? version : null]);
  }
  async createSession(userId: string) {
    const id = crypto.randomUUID();
    await this.db.query("INSERT INTO sessions(id, user_id, state, slots) VALUES ($1,$2,'GREETING','{}')", [id, userId]);
    return { id, userId, state: 'GREETING', slots: {} } as Session;
  }
  async getSession(id: string) {
    const r = await this.db.query('SELECT id, user_id, state, slots FROM sessions WHERE id = $1', [id]);
    const x = r.rows[0]; if (!x) return null;
    return { id: x.id, userId: String(x.user_id), state: x.state, slots: json(x.slots) };
  }
  async saveSession(s: Session) {
    await this.db.query('UPDATE sessions SET state = $2, slots = $3, updated_at = now() WHERE id = $1', [s.id, s.state, JSON.stringify(s.slots)]);
  }
  async appendMessage(sessionId: string, m: ChatMsg & { provider?: string }) {
    await this.db.query('INSERT INTO messages(session_id, role, content, provider) VALUES ($1,$2,$3,$4)', [sessionId, m.role, typeof m.content === 'string' ? m.content : JSON.stringify(m.content), m.provider ?? null]);
  }
  async recentMessages(sessionId: string, n: number) {
    const r = await this.db.query('SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2', [sessionId, n]);
    return r.rows.reverse().map(x => ({ role: x.role, content: x.content }));
  }
  async addImage(i: ImageRow) {
    await this.db.query('INSERT INTO images(id, user_id, kind, oss_key, provider, ai_label, expire_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [i.id, i.userId, i.kind, i.ossKey, i.provider ?? null, i.aiLabel, i.expireAt]);
  }
  async getImage(id: string) {
    const r = await this.db.query('SELECT * FROM images WHERE id = $1 AND deleted_at IS NULL', [id]);
    return r.rows[0] ? toImg(r.rows[0]) : null;
  }
  async takeExpiredImages(now: Date) {
    const r = await this.db.query('UPDATE images SET deleted_at = $1 WHERE deleted_at IS NULL AND expire_at <= $1 RETURNING *', [now]);
    return r.rows.map(toImg);
  }
  async createTask(t: RenderTask) {
    await this.db.query('INSERT INTO render_tasks(id, user_id, kind, provider, provider_task_id, status) VALUES ($1,$2,$3,$4,$5,$6)', [t.id, t.userId, t.kind, t.provider, t.providerTaskId ?? null, t.status]);
  }
  async updateTask(id: string, p: Partial<RenderTask>) {
    await this.db.query(
      `UPDATE render_tasks SET status = COALESCE($2, status), provider_task_id = COALESCE($3, provider_task_id), result_url = COALESCE($4, result_url), error = COALESCE($5, error), ai_label = COALESCE($6, ai_label), cost_cny = COALESCE($7, cost_cny), updated_at = now() WHERE id = $1`,
      [id, p.status ?? null, p.providerTaskId ?? null, p.resultUrl ?? null, p.error ?? null, p.aiLabel ? JSON.stringify(p.aiLabel) : null, p.costCny ?? null]);
  }
  async getTask(id: string) {
    const r = await this.db.query('SELECT * FROM render_tasks WHERE id = $1', [id]);
    return r.rows[0] ? toTask(r.rows[0]) : null;
  }
  async countRenderTasksSince(userId: string, since: Date) {
    const r = await this.db.query('SELECT COUNT(*) AS n FROM render_tasks WHERE user_id = $1 AND created_at >= $2', [userId, since]);
    return Number(r.rows[0]?.n ?? 0);
  }
  async createOrder(o: Omit<Order, 'id'>) {
    const r = await this.db.query(
      'INSERT INTO orders(user_id, sku, amount_fen, status, out_trade_no, plan_days, prepay_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [o.userId, o.sku, o.amountFen, o.status, o.outTradeNo, o.planDays, o.prepayId ?? null]);
    return toOrder(r.rows[0]);
  }
  async getOrderByOutTradeNo(outTradeNo: string) {
    const r = await this.db.query('SELECT * FROM orders WHERE out_trade_no = $1', [outTradeNo]);
    return r.rows[0] ? toOrder(r.rows[0]) : null;
  }
  async setPrepayId(outTradeNo: string, prepayId: string) {
    await this.db.query('UPDATE orders SET prepay_id = $2 WHERE out_trade_no = $1', [outTradeNo, prepayId]);
  }
  async markOrderPaid(outTradeNo: string, wxTransactionId: string, paidAt: Date) {
    const r = await this.db.query(
      `UPDATE orders SET status = 'PAID', wx_transaction_id = $2, paid_at = $3 WHERE out_trade_no = $1 AND status = 'CREATED' RETURNING *`,
      [outTradeNo, wxTransactionId, paidAt]);
    if (r.rows[0]) return { order: toOrder(r.rows[0]), newlyPaid: true };
    const cur = await this.getOrderByOutTradeNo(outTradeNo);
    return cur ? { order: cur, newlyPaid: false } : null;
  }
  async addFavorite(f: Omit<Favorite, 'createdAt'> & { createdAt?: Date }) {
    const createdAt = f.createdAt ?? new Date();
    const r = await this.db.query(
      'INSERT INTO favorites(id, user_id, kind, title, cover_url, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [f.id, f.userId, f.kind, f.title, f.coverUrl ?? null, JSON.stringify(f.payload ?? {}), createdAt]);
    return toFav(r.rows[0]);
  }
  async deleteFavorite(id: string, userId: string) {
    const r = await this.db.query('DELETE FROM favorites WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
    return r.rows.length > 0;
  }
  async listFavorites(userId: string, limit: number, cursor?: { createdAt: Date; id: string } | null) {
    const createdAt = cursor?.createdAt ?? new Date('9999-12-31T00:00:00.000Z');
    const id = cursor?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const r = await this.db.query(
      `SELECT * FROM favorites WHERE user_id = $1 AND (created_at < $2 OR (created_at = $2 AND id < $3)) ORDER BY created_at DESC, id DESC LIMIT $4`,
      [userId, createdAt, id, limit + 1]);
    const items = r.rows.map(toFav);
    const hasMore = items.length > limit;
    return { items: items.slice(0, limit), hasMore };
  }
  async addUsage(e: UsageInput) {
    if (e.refId) {
      const hit = await this.db.query('SELECT 1 FROM usage_events WHERE ref_id = $1', [e.refId]);
      if (hit.rows.length) return false;
    }
    await this.db.query(
      'INSERT INTO usage_events(user_id, kind, model, unit_price_cny, cost_cny, priced, ref_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [e.userId, e.kind, e.model, e.unitPriceCny, e.costCny, e.priced, e.refId ?? null]);
    return true;
  }
  async listUsage(userId: string, from: Date, to: Date) {
    const r = await this.db.query('SELECT * FROM usage_events WHERE user_id = $1 AND created_at >= $2 AND created_at < $3', [userId, from, to]);
    return r.rows.map(toUsage);
  }
  async saveModeration(p: ModerationPending) {
    await this.db.query(
      `INSERT INTO moderation_tasks(trace_id, user_id, task_id, source_url, provider, model) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (trace_id) DO UPDATE SET source_url = EXCLUDED.source_url`,
      [p.traceId, p.userId, p.taskId, p.sourceUrl, p.provider, p.model]);
  }
  async getModeration(traceId: string) {
    const r = await this.db.query('SELECT * FROM moderation_tasks WHERE trace_id = $1', [traceId]);
    return r.rows[0] ? toMod(r.rows[0]) : null;
  }
  async deleteModeration(traceId: string) {
    await this.db.query('DELETE FROM moderation_tasks WHERE trace_id = $1', [traceId]);
  }
  async audit(userId: string | null, action: string, detail: unknown) {
    await this.db.query('INSERT INTO audit_logs(user_id, action, detail) VALUES ($1,$2,$3)', [userId, action, JSON.stringify(detail)]);
  }
  async close() { await this.db.end?.(); }
}
