import { randomUUID } from 'node:crypto';
import type { ChatMsg } from '../llm/client.js';
import type { Favorite, ImageRow, MemberState, ModerationPending, Order, RenderTask, Repo, Session, UsageInput, UsageRow } from './types.js';

type User = { id: string; openid: string; faceConsent?: boolean; memberLevel: string; memberExpireAt: Date | null };

export class MemoryRepo implements Repo {
  users = new Map<string, User>();
  sessions = new Map<string, Session>();
  messages = new Map<string, ChatMsg[]>();
  images = new Map<string, ImageRow & { deleted?: boolean }>();
  tasks = new Map<string, RenderTask>();
  orders = new Map<string, Order>();
  favorites = new Map<string, Favorite>();
  usage: UsageRow[] = [];
  moderation = new Map<string, ModerationPending>();
  audits: { userId: string | null; action: string; detail: unknown }[] = [];
  private seq = 0;
  private orderSeq = 0;

  private userById(id: string) { for (const u of this.users.values()) if (u.id === id) return u; return undefined; }

  async upsertUser(openid: string) {
    let u = this.users.get(openid);
    if (!u) { u = { id: String(++this.seq), openid, memberLevel: 'free', memberExpireAt: null }; this.users.set(openid, u); }
    return u.id;
  }
  async getOpenid(userId: string) { return this.userById(userId)?.openid ?? null; }
  async getMember(userId: string): Promise<MemberState> {
    const u = this.userById(userId);
    return { level: u?.memberLevel ?? 'free', expireAt: u?.memberExpireAt ?? null };
  }
  async setMember(userId: string, level: string, expireAt: Date) {
    const u = this.userById(userId);
    if (u) { u.memberLevel = level; u.memberExpireAt = expireAt; }
  }
  async setFaceConsent(userId: string, agree: boolean) { const u = this.userById(userId); if (u) u.faceConsent = agree; }
  async createSession(userId: string) { const s: Session = { id: randomUUID(), userId, state: 'GREETING', slots: {} }; this.sessions.set(s.id, structuredClone(s)); return s; }
  async getSession(id: string) { const s = this.sessions.get(id); return s ? structuredClone(s) : null; }
  async saveSession(s: Session) { this.sessions.set(s.id, structuredClone(s)); }
  async appendMessage(id: string, m: ChatMsg) { const a = this.messages.get(id) ?? []; a.push({ role: m.role, content: m.content }); this.messages.set(id, a); }
  async recentMessages(id: string, n: number) { return (this.messages.get(id) ?? []).slice(-n); }
  async addImage(img: ImageRow) { this.images.set(img.id, { ...img }); }
  async getImage(id: string) { const i = this.images.get(id); return i && !i.deleted ? i : null; }
  async takeExpiredImages(now: Date) { const out: ImageRow[] = []; for (const i of this.images.values()) if (!i.deleted && i.expireAt && i.expireAt <= now) { i.deleted = true; out.push(i); } return out; }
  async createTask(t: RenderTask) { this.tasks.set(t.id, { ...t, createdAt: t.createdAt ?? new Date() }); }
  async updateTask(id: string, p: Partial<RenderTask>) { const t = this.tasks.get(id); if (t) Object.assign(t, p); }
  async getTask(id: string) { const t = this.tasks.get(id); return t ? { ...t } : null; }
  async countRenderTasksSince(userId: string, since: Date) {
    let n = 0;
    for (const t of this.tasks.values()) if (t.userId === userId && t.createdAt && t.createdAt >= since) n++;
    return n;
  }
  async createOrder(o: Omit<Order, 'id'>) {
    const order: Order = { ...o, id: String(++this.orderSeq) };
    this.orders.set(order.outTradeNo, order);
    return { ...order };
  }
  async getOrderByOutTradeNo(outTradeNo: string) { const o = this.orders.get(outTradeNo); return o ? { ...o } : null; }
  async setPrepayId(outTradeNo: string, prepayId: string) { const o = this.orders.get(outTradeNo); if (o) o.prepayId = prepayId; }
  async markOrderPaid(outTradeNo: string, wxTransactionId: string, paidAt: Date) {
    const o = this.orders.get(outTradeNo);
    if (!o) return null;
    if (o.status === 'PAID') return { order: { ...o }, newlyPaid: false };
    o.status = 'PAID'; o.wxTransactionId = wxTransactionId; o.paidAt = paidAt;
    return { order: { ...o }, newlyPaid: true };
  }
  async addFavorite(f: Omit<Favorite, 'createdAt'> & { createdAt?: Date }) {
    const row: Favorite = { ...f, payload: { ...f.payload }, createdAt: f.createdAt ?? new Date() };
    this.favorites.set(row.id, row);
    return { ...row, payload: { ...row.payload } };
  }
  async deleteFavorite(id: string, userId: string) {
    const f = this.favorites.get(id);
    if (!f || f.userId !== userId) return false;
    this.favorites.delete(id);
    return true;
  }
  async listFavorites(userId: string, limit: number, cursor?: { createdAt: Date; id: string } | null) {
    let rows = [...this.favorites.values()].filter(f => f.userId === userId);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    if (cursor) rows = rows.filter(f => f.createdAt < cursor.createdAt || (f.createdAt.getTime() === cursor.createdAt.getTime() && f.id < cursor.id));
    const page = rows.slice(0, limit + 1);
    const hasMore = page.length > limit;
    return { items: page.slice(0, limit).map(f => ({ ...f, payload: { ...f.payload } })), hasMore };
  }
  async addUsage(e: UsageInput) {
    if (e.refId && this.usage.some(u => u.refId === e.refId)) return false;
    this.usage.push({ ...e, createdAt: new Date() });
    return true;
  }
  async listUsage(userId: string, from: Date, to: Date) {
    return this.usage.filter(u => u.userId === userId && u.createdAt >= from && u.createdAt < to).map(u => ({ ...u }));
  }
  async saveModeration(p: ModerationPending) { this.moderation.set(p.traceId, { ...p }); }
  async getModeration(traceId: string) { const m = this.moderation.get(traceId); return m ? { ...m } : null; }
  async deleteModeration(traceId: string) { this.moderation.delete(traceId); }
  async audit(userId: string | null, action: string, detail: unknown) { this.audits.push({ userId, action, detail }); }
  async close() {}
}
