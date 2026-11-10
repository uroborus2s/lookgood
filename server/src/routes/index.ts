import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordModelUsage } from '../cost.js';
import { formatYuan, type Config } from '../config.js';
import { completeWithFallback, type ChatMsg, type Router } from '../llm/client.js';
import { confirmMockPaid, createMembershipOrder, handlePayNotify, refreshOrder } from '../pay/service.js';
import { assertDailyQuota, quotaSnapshot } from '../quota.js';
import { advanceAll, RULES } from '../state/machine.js';
import { mergeSlots, type Extractor } from '../state/slots.js';
import { SYSTEM_PROMPT } from '../prompts/index.js';
import { rollupUsage, type Repo } from '../repo/types.js';
import { parseLookSpec } from '../schema/lookSpec.js';
import type { RenderService } from '../render/service.js';
import type { ContentSafety } from '../safety/index.js';
import { createUploadTicket } from '../storage/oss.js';
import type { ObjectStore } from '../storage/archive.js';
import { signJwt, verifyJwt } from '../auth/jwt.js';
import { code2Session } from '../auth/wechat.js';
import { HttpError, type Fetch } from '../http.js';

export type Deps = { cfg: Config; repo: Repo; llm: Router; extractor: Extractor; render: RenderService; safety: ContentSafety; fetch?: Fetch; store: ObjectStore };
export const CONSENT_VERSION = '2026-11';

const url = z.string().url().max(2048);
const FAVORITE_KINDS = ['look', 'tryon', 'lip', 'hair', 'fulllook', 'makeup'] as const;

function isPublic(urlPath: string) {
  const path = urlPath.split('?')[0] ?? urlPath;
  return path === '/health' || path.startsWith('/auth/') || path === '/pay/wechat/notify' || path === '/safety/wechat/callback';
}

export function encodeCursor(f: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({ t: f.createdAt.toISOString(), id: f.id })).toString('base64url');
}
export function decodeCursor(s: string) {
  try {
    const j = JSON.parse(Buffer.from(s, 'base64url').toString());
    const createdAt = new Date(j.t);
    if (!j.id || Number.isNaN(createdAt.getTime())) throw new Error('bad');
    return { createdAt, id: String(j.id) };
  } catch { throw new HttpError(400, 'cursor 非法'); }
}

export function routes(d: Deps) {
  return async (app: FastifyInstance) => {
    const uid = (req: FastifyRequest) => (req as any).userId as string;
    const openid = (req: FastifyRequest) => (req as any).openid as string;

    app.addHook('preHandler', async (req) => {
      if (isPublic(req.url)) return;
      const tok = req.headers.authorization?.replace(/^Bearer /, '');
      const c = tok ? verifyJwt(tok, d.cfg.jwtSecret) : null;
      if (!c) throw new HttpError(401, '未登录或登录已过期');
      (req as any).userId = c.sub;
      (req as any).openid = c.openid;
    });

    const ownSession = async (req: FastifyRequest, id: string) => {
      const s = await d.repo.getSession(id);
      if (!s || s.userId !== uid(req)) throw new HttpError(404, '会话不存在');
      return s;
    };

    const meter = async (userId: string, kind: string, model: string) => {
      await recordModelUsage(d.repo, d.cfg.modelPrices, { userId, kind, model });
    };

    app.get('/health', async () => ({ ok: true, mode: d.cfg.mode }));

    app.post('/auth/login', async (req) => {
      const { code } = z.object({ code: z.string().min(1).max(128) }).parse(req.body);
      const { openid: oid } = await code2Session(d.cfg.wx, code, d.fetch);
      const userId = await d.repo.upsertUser(oid);
      return { userId, token: signJwt({ sub: userId, openid: oid }, d.cfg.jwtSecret, d.cfg.jwtTtlSec), expiresIn: d.cfg.jwtTtlSec };
    });

    app.post('/consent/face', async (req) => {
      const { sessionId, agree } = z.object({ sessionId: z.string().uuid(), agree: z.boolean() }).parse(req.body);
      const s = await ownSession(req, sessionId);
      await d.repo.setFaceConsent(uid(req), agree, CONSENT_VERSION);
      await d.repo.audit(uid(req), agree ? 'face_consent' : 'face_consent_revoke', { version: CONSENT_VERSION });
      s.slots.face_consent = agree; s.state = advanceAll(s.state, s.slots);
      await d.repo.saveSession(s);
      return { state: s.state, ask: RULES[s.state].ask };
    });

    app.post('/chat/message', async (req) => {
      const body = z.object({ sessionId: z.string().uuid().optional(), text: z.string().min(1).max(500) }).parse(req.body);
      const s = body.sessionId ? await ownSession(req, body.sessionId) : await d.repo.createSession(uid(req));
      const v = await d.safety.checkText(body.text, openid(req));
      if (!v.pass) return { sessionId: s.id, state: s.state, reply: '这句话我没法回应哦，我们聊聊穿搭吧～', quickReplies: RULES[s.state].quick ?? [], blocked: true };
      const { ex, source } = await d.extractor(body.text, s.state, s.slots);
      s.slots = mergeSlots(s.slots, ex);
      s.state = advanceAll(s.state, s.slots);
      await d.repo.saveSession(s);
      await d.repo.appendMessage(s.id, { role: 'user', content: body.text });
      const history = await d.repo.recentMessages(s.id, 12);
      const rule = RULES[s.state];
      const { text, provider, model } = await completeWithFallback(d.llm.chat, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: `当前状态 ${s.state}；已知信息 ${JSON.stringify(s.slots)}；用户意图 ${ex.intent}；下一步要问：${rule.ask ?? '按流程继续'}` },
        ...history,
      ]);
      await meter(uid(req), 'chat', model);
      const reply = rule.ask ? `${text}\n${rule.ask}` : text;
      await d.repo.appendMessage(s.id, { role: 'assistant', content: reply, provider });
      return { sessionId: s.id, state: s.state, slots: s.slots, intent: ex.intent, reply, quickReplies: rule.quick ?? [], provider, extractor: source };
    });

    app.post('/photo/upload-ticket', async (req) => {
      const { kind } = z.object({ kind: z.enum(['body', 'face', 'garment']) }).parse(req.body);
      if (kind !== 'garment') {
        const sessions = (req.body as any).sessionId ? await ownSession(req, (req.body as any).sessionId) : null;
        if (sessions && sessions.slots.face_consent !== true) throw new HttpError(403, '请先完成人脸信息授权');
      }
      const t = createUploadTicket(d.cfg, uid(req), kind);
      await d.repo.addImage(t.row);
      const { row: _r, ...ticket } = t;
      return ticket;
    });

    app.post('/analysis', async (req) => {
      const { bodyUrl, faceUrl } = z.object({ bodyUrl: url, faceUrl: url }).parse(req.body);
      const { text, model } = await completeWithFallback(d.llm.vision, [
        { role: 'system', content: '根据两张照片判断体型、冷暖皮、四季型、对比度、脸型并给出依据，只输出 JSON。' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: bodyUrl } }, { type: 'image_url', image_url: { url: faceUrl } }] },
      ], { json: true });
      await meter(uid(req), 'vision', model);
      const j = JSON.parse(text); return j.diagnosis ?? j;
    });

    app.post('/look/generate', async (req, reply) => {
      const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(req.body);
      const s = await ownSession(req, sessionId);
      const msgs: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `已知信息：${JSON.stringify(s.slots)}。请输出 look_spec JSON。` }];
      for (let attempt = 0; attempt < 2; attempt++) {
        const { text, model } = await completeWithFallback(d.llm.spec, msgs, { json: true, temperature: 0.4 });
        await meter(uid(req), 'spec', model);
        const r = parseLookSpec(text);
        if (r.ok) return r.data;
        msgs.push({ role: 'assistant', content: text }, { role: 'user', content: `JSON 校验失败：${r.error}。请修正后只输出 JSON。` });
      }
      return reply.code(502).send({ error: 'look_spec 生成失败' });
    });

    const pub = (t: any) => ({ taskId: t.id, kind: t.kind, status: t.status, resultUrl: t.resultUrl, error: t.error, aiLabel: t.aiLabel });
    const render = async (kind: 'tryon' | 'lip' | 'hair' | 'fulllook', userId: string, input: any) => {
      await assertDailyQuota(d.repo, d.cfg, userId);
      return pub(await d.render.start(kind, userId, input));
    };
    app.post('/render/tryon', async (req) => { const b = z.object({ personUrl: url, garmentUrls: z.array(url).min(1).max(2) }).parse(req.body); return render('tryon', uid(req), b); });
    app.post('/render/lip', async (req) => { const b = z.object({ faceUrl: url, hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/) }).parse(req.body); return render('lip', uid(req), b); });
    app.post('/render/fulllook', async (req) => { const b = z.object({ baseUrl: url, instruction: z.string().min(1).max(800), refUrls: z.array(url).max(8).optional() }).parse(req.body); return render('fulllook', uid(req), b); });
    app.post('/render/hair', async (req) => { const b = z.object({ baseUrl: url, instruction: z.string().min(1).max(800) }).parse(req.body); return render('hair', uid(req), { baseUrl: b.baseUrl, instruction: `只修改发型与发饰：${b.instruction}。保持脸部、五官、服装与背景不变。` }); });
    app.get('/render/tasks/:id', async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const t = await d.render.get(id, uid(req));
      if (!t) throw new HttpError(404, '任务不存在');
      return pub(t);
    });

    app.get('/favorites', async (req) => {
      const q = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
      const page = await d.repo.listFavorites(uid(req), q.limit, q.cursor ? decodeCursor(q.cursor) : null);
      const last = page.items.at(-1);
      return {
        items: page.items.map(f => ({ id: f.id, kind: f.kind, title: f.title, coverUrl: f.coverUrl ?? null, payload: f.payload, createdAt: f.createdAt.toISOString() })),
        nextCursor: page.hasMore && last ? encodeCursor(last) : null,
      };
    });

    app.post('/favorites', async (req) => {
      const b = z.object({
        kind: z.enum(FAVORITE_KINDS),
        title: z.string().min(1).max(80),
        coverUrl: url.optional(),
        payload: z.record(z.any()).optional(),
      }).parse(req.body);
      const payload = b.payload ?? {};
      if (JSON.stringify(payload).length > 8000) throw new HttpError(400, '收藏内容过大');
      const row = await d.repo.addFavorite({ id: crypto.randomUUID(), userId: uid(req), kind: b.kind, title: b.title, coverUrl: b.coverUrl, payload });
      return { id: row.id, kind: row.kind, title: row.title, coverUrl: row.coverUrl ?? null, payload: row.payload, createdAt: row.createdAt.toISOString() };
    });

    app.delete('/favorites/:id', async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const ok = await d.repo.deleteFavorite(id, uid(req));
      if (!ok) throw new HttpError(404, '收藏不存在');
      return { ok: true };
    });

    const memberView = async (userId: string) => {
      const q = await quotaSnapshot(d.repo, d.cfg, userId);
      const plan = d.cfg.plans.find(p => p.sku === q.level);
      return {
        active: q.active,
        level: q.level,
        levelTitle: plan?.title ?? (q.active ? q.level : '免费'),
        expireAt: q.expireAt ? q.expireAt.toISOString() : null,
        quota: { limit: q.limit, used: q.used, remaining: q.remaining, resetsAt: q.resetsAt },
        freeDailyQuota: d.cfg.freeDailyQuota,
        memberDailyQuota: d.cfg.memberDailyQuota,
        plans: d.cfg.plans.map(p => ({ ...p, amountYuan: formatYuan(p.amountFen) })),
      };
    };

    app.get('/member', async (req) => memberView(uid(req)));

    app.get('/usage/summary', async (req) => {
      const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
      const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400_000);
      const to = q.to ? new Date(q.to) : new Date(Date.now() + 1000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(400, '时间范围非法');
      const rows = await d.repo.listUsage(uid(req), from, to);
      const quota = await quotaSnapshot(d.repo, d.cfg, uid(req));
      return { from: from.toISOString(), to: to.toISOString(), quota: { limit: quota.limit, used: quota.used, remaining: quota.remaining, member: quota.active, resetsAt: quota.resetsAt }, cost: rollupUsage(rows) };
    });

    app.post('/pay/orders', async (req) => {
      const { sku } = z.object({ sku: z.string().min(1).max(32) }).parse(req.body);
      const created = await createMembershipOrder(d.cfg, d.repo, uid(req), sku, d.fetch ?? fetch);
      return { outTradeNo: created.order.outTradeNo, sku: created.order.sku, amountFen: created.order.amountFen, amountYuan: formatYuan(created.order.amountFen), status: created.order.status, mock: created.mock, pay: created.pay };
    });

    app.post('/pay/orders/:outTradeNo/mock-confirm', async (req) => {
      const { outTradeNo } = z.object({ outTradeNo: z.string().min(6).max(32) }).parse(req.params);
      const order = await confirmMockPaid(d.cfg, d.repo, uid(req), outTradeNo);
      return { outTradeNo: order.outTradeNo, status: order.status, member: await memberView(uid(req)) };
    });

    app.get('/pay/orders/:outTradeNo', async (req) => {
      const { outTradeNo } = z.object({ outTradeNo: z.string().min(6).max(32) }).parse(req.params);
      const found = await d.repo.getOrderByOutTradeNo(outTradeNo);
      if (!found || found.userId !== uid(req)) throw new HttpError(404, '订单不存在');
      const order = await refreshOrder(d.cfg, d.repo, found, d.fetch ?? fetch);
      return { outTradeNo: order.outTradeNo, sku: order.sku, amountFen: order.amountFen, status: order.status, paidAt: order.paidAt ? order.paidAt.toISOString() : null };
    });

    app.post('/pay/wechat/notify', async (req, reply) => {
      try {
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
        await handlePayNotify(d.cfg, d.repo, headers, (req as any).rawBody ?? '');
        return reply.code(200).send({ code: 'SUCCESS', message: '成功' });
      } catch (e: any) {
        const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
        return reply.code(status).send({ code: 'FAIL', message: e.message ?? '失败' });
      }
    });

    app.route({
      method: ['GET', 'POST'],
      url: '/safety/wechat/callback',
      handler: async (req, reply) => {
        if (!d.safety.handleCallback) return reply.code(404).send({ error: '未启用微信内容安全回调' });
        const q = req.query as Record<string, string | undefined>;
        const raw = typeof (req as any).rawBody === 'string' ? (req as any).rawBody : '';
        const r = await d.safety.handleCallback(q, raw);
        if (r.echo != null) return reply.type('text/plain').send(r.echo);
        if (r.traceId && r.verdict) await d.render.applyModeration(r.traceId, r.verdict);
        return reply.type('text/plain').send('success');
      },
    });
  };
}
