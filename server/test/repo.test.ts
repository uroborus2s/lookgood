import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import { migrate, PgRepo } from '../src/repo/pg.js';
import { MemoryRepo } from '../src/repo/memory.js';
import { purgeExpired } from '../src/storage/oss.js';
import type { Repo } from '../src/repo/types.js';

async function pgRepo() {
  const db = newDb();
  db.public.registerFunction({ name: 'now', returns: 'timestamptz' as any, implementation: () => new Date(), impure: true });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await migrate(pool);
  return new PgRepo(pool);
}

for (const [name, make] of [['memory', async () => new MemoryRepo()], ['pg(pg-mem)', pgRepo]] as const) {
  describe(`Repo ${name}`, () => {
    it('用户、会话、消息', async () => {
      const r: Repo = await make();
      const u = await r.upsertUser('o1'); expect(await r.upsertUser('o1')).toBe(u);
      const s = await r.createSession(u);
      s.state = 'STYLE'; s.slots = { occasion: '面试' }; await r.saveSession(s);
      expect(await r.getSession(s.id)).toMatchObject({ state: 'STYLE', slots: { occasion: '面试' }, userId: u });
      await r.appendMessage(s.id, { role: 'user', content: 'a' }); await r.appendMessage(s.id, { role: 'assistant', content: 'b' });
      expect(await r.recentMessages(s.id, 1)).toEqual([{ role: 'assistant', content: 'b' }]);
      await r.setFaceConsent(u, true, 'v1');
    });
    it('图片过期清理 + 任务', async () => {
      const r: Repo = await make();
      const u = await r.upsertUser('o2');
      const old = randomUUID(), fresh = randomUUID();
      await r.addImage({ id: old, userId: u, kind: 'face', ossKey: 'raw/x', expireAt: new Date(Date.now() - 1000), aiLabel: false });
      await r.addImage({ id: fresh, userId: u, kind: 'face', ossKey: 'raw/y', expireAt: new Date(Date.now() + 3600_000), aiLabel: false });
      const deleted: string[] = [];
      expect(await purgeExpired(r, async k => { deleted.push(...k); })).toBe(1);
      expect(deleted).toEqual(['raw/x']); expect(await r.getImage(old)).toBeNull(); expect(await r.getImage(fresh)).not.toBeNull();
      const tid = randomUUID();
      await r.createTask({ id: tid, userId: u, kind: 'lip', provider: 'p', status: 'PENDING' });
      await r.updateTask(tid, { status: 'SUCCEEDED', resultUrl: 'https://r', aiLabel: { AIGC: 'true' } });
      expect(await r.getTask(tid)).toMatchObject({ status: 'SUCCEEDED', resultUrl: 'https://r', aiLabel: { AIGC: 'true' } });
    });
    it('会员订单幂等、收藏分页、用量', async () => {
      const r: Repo = await make();
      const u = await r.upsertUser('o3');
      expect(await r.getOpenid(u)).toBe('o3');
      const base = new Date('2026-11-01T00:00:00.000Z');
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      for (let i = 0; i < 3; i++) await r.addFavorite({ id: ids[i]!, userId: u, kind: 'look', title: `方案${i}`, payload: { i }, createdAt: new Date(base.getTime() + i * 1000) });
      const page1 = await r.listFavorites(u, 2, null);
      expect(page1.items.map(x => x.title)).toEqual(['方案2', '方案1']);
      expect(page1.hasMore).toBe(true);
      const last = page1.items.at(-1)!;
      const page2 = await r.listFavorites(u, 2, { createdAt: last.createdAt, id: last.id });
      expect(page2.items.map(x => x.title)).toEqual(['方案0']);
      expect(page2.hasMore).toBe(false);
      expect(await r.deleteFavorite(ids[0]!, u)).toBe(true);
      expect(await r.deleteFavorite(ids[0]!, u)).toBe(false);
      const order = await r.createOrder({ userId: u, sku: 'month', amountFen: 1290, planDays: 30, status: 'CREATED', outTradeNo: 'YS-TEST-1' });
      const paidAt = new Date('2026-11-05T00:00:00.000Z');
      const first = await r.markOrderPaid(order.outTradeNo, 'tx', paidAt);
      const second = await r.markOrderPaid(order.outTradeNo, 'tx', paidAt);
      expect(first?.newlyPaid).toBe(true);
      expect(second?.newlyPaid).toBe(false);
      expect((await r.getOrderByOutTradeNo(order.outTradeNo))?.status).toBe('PAID');
      await r.setMember(u, 'month', new Date('2026-12-01T00:00:00.000Z'));
      expect(await r.getMember(u)).toMatchObject({ level: 'month' });
      expect(await r.addUsage({ userId: u, kind: 'render', model: 'tryon', unitPriceCny: 2, costCny: 2, priced: true, refId: 't1' })).toBe(true);
      expect(await r.addUsage({ userId: u, kind: 'render', model: 'tryon', unitPriceCny: 2, costCny: 2, priced: true, refId: 't1' })).toBe(false);
      await r.addUsage({ userId: u, kind: 'chat', model: 'mock', unitPriceCny: null, costCny: null, priced: false });
      const rows = await r.listUsage(u, new Date('2026-01-01T00:00:00.000Z'), new Date('2027-01-01T00:00:00.000Z'));
      expect(rows).toHaveLength(2);
    });
  });
}
