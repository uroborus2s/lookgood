import type { ChatMsg } from '../llm/client.js';
import type { Slots, State } from '../state/machine.js';
import type { ImageKind } from '../storage/oss.js';

export type Session = { id: string; userId: string; state: State; slots: Slots };
export type ImageRow = { id: string; userId: string; kind: ImageKind; ossKey: string; expireAt: Date | null; aiLabel: boolean; provider?: string };
export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type RenderTask = { id: string; userId: string; kind: 'tryon' | 'lip' | 'fulllook' | 'hair'; provider: string; providerTaskId?: string; status: TaskStatus; resultUrl?: string; error?: string; aiLabel?: Record<string, unknown>; costCny?: number | null; createdAt?: Date };

export type MemberState = { level: string; expireAt: Date | null };
export type OrderStatus = 'CREATED' | 'PAID' | 'CLOSED';
export type Order = {
  id: string;
  userId: string;
  sku: string;
  amountFen: number;
  planDays: number;
  status: OrderStatus;
  outTradeNo: string;
  prepayId?: string;
  wxTransactionId?: string;
  paidAt?: Date | null;
};
export type Favorite = { id: string; userId: string; kind: string; title: string; coverUrl?: string; payload: Record<string, unknown>; createdAt: Date };
export type UsageInput = { userId: string | null; kind: string; model: string; unitPriceCny: number | null; costCny: number | null; priced: boolean; refId?: string };
export type UsageRow = UsageInput & { createdAt: Date };
export type UsageSummary = { totalCny: string; calls: number; unpricedCalls: number; byModel: { model: string; calls: number; costCny: string; unpricedCalls: number }[] };
export type ModerationPending = { traceId: string; userId: string; taskId: string; sourceUrl: string; provider: string; model: string };

/** 仓储接口：memory（测试/mock）与 pg（线上）两种实现，由 REPO 环境变量选择 */
export interface Repo {
  upsertUser(openid: string): Promise<string>;
  getOpenid(userId: string): Promise<string | null>;
  getMember(userId: string): Promise<MemberState>;
  setMember(userId: string, level: string, expireAt: Date): Promise<void>;
  setFaceConsent(userId: string, agree: boolean, version: string): Promise<void>;
  createSession(userId: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  saveSession(s: Session): Promise<void>;
  appendMessage(sessionId: string, m: ChatMsg & { provider?: string }): Promise<void>;
  recentMessages(sessionId: string, n: number): Promise<ChatMsg[]>;
  addImage(img: ImageRow): Promise<void>;
  getImage(id: string): Promise<ImageRow | null>;
  /** 返回已过期且未删除的图片，并标记 deleted_at */
  takeExpiredImages(now: Date): Promise<ImageRow[]>;
  createTask(t: RenderTask): Promise<void>;
  updateTask(id: string, patch: Partial<RenderTask>): Promise<void>;
  getTask(id: string): Promise<RenderTask | null>;
  countRenderTasksSince(userId: string, since: Date): Promise<number>;
  createOrder(o: Omit<Order, 'id'>): Promise<Order>;
  getOrderByOutTradeNo(outTradeNo: string): Promise<Order | null>;
  setPrepayId(outTradeNo: string, prepayId: string): Promise<void>;
  /** 仅当状态不是 PAID 时置为 PAID。重复回调 newlyPaid=false */
  markOrderPaid(outTradeNo: string, wxTransactionId: string, paidAt: Date): Promise<{ order: Order; newlyPaid: boolean } | null>;
  addFavorite(f: Omit<Favorite, 'createdAt'> & { createdAt?: Date }): Promise<Favorite>;
  deleteFavorite(id: string, userId: string): Promise<boolean>;
  listFavorites(userId: string, limit: number, cursor?: { createdAt: Date; id: string } | null): Promise<{ items: Favorite[]; hasMore: boolean }>;
  addUsage(e: UsageInput): Promise<boolean>;
  listUsage(userId: string, from: Date, to: Date): Promise<UsageRow[]>;
  saveModeration(p: ModerationPending): Promise<void>;
  getModeration(traceId: string): Promise<ModerationPending | null>;
  deleteModeration(traceId: string): Promise<void>;
  audit(userId: string | null, action: string, detail: unknown): Promise<void>;
  close(): Promise<void>;
}

export function rollupUsage(rows: UsageRow[]): UsageSummary {
  const by = new Map<string, { calls: number; cost: number; unpriced: number }>();
  let total = 0;
  let unpricedCalls = 0;
  for (const r of rows) {
    const slot = by.get(r.model) ?? { calls: 0, cost: 0, unpriced: 0 };
    slot.calls += 1;
    if (r.priced && r.costCny != null) { slot.cost += r.costCny; total += r.costCny; }
    else { slot.unpriced += 1; unpricedCalls += 1; }
    by.set(r.model, slot);
  }
  const money = (n: number) => (Math.round(n * 10000) / 10000).toFixed(4);
  return {
    totalCny: money(total),
    calls: rows.length,
    unpricedCalls,
    byModel: [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([model, v]) => ({ model, calls: v.calls, costCny: money(v.cost), unpricedCalls: v.unpriced })),
  };
}
