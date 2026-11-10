/** mock 模式全流程冒烟：真实监听端口，走 HTTP，不调用任何付费 API */
import { buildApp, buildDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const cfg = { ...loadConfig(), mode: 'mock' as const, llmLive: false, repo: 'memory' as const };
for (const k of ['dashscope', 'tencent', 'oss', 'wx'] as const) (cfg[k] as any).live = false;
const app = buildApp(await buildDeps({ cfg }));
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
let token = '';
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json(); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`); return j;
};
const step = (n: string, x: unknown) => console.log(`✓ ${n}`, typeof x === 'string' ? x : JSON.stringify(x));
const poll = async (id: string) => { for (let i = 0; i < 10; i++) { const t = await call('GET', `/render/tasks/${id}`); if (t.status === 'SUCCEEDED' || t.status === 'FAILED') return t; await new Promise(r => setTimeout(r, 50)); } throw new Error('timeout'); };

try {
  token = (await call('POST', '/auth/login', { code: 'smoke' })).token; step('登录', 'JWT ok');
  let r = await call('POST', '/chat/message', { text: '你好' }); step('问候', { state: r.state, slots: r.slots });
  const sid = r.sessionId;
  r = await call('POST', '/chat/message', { sessionId: sid, text: '下周面试，想要简约干净的风格' }); step('场合+风格', { state: r.state, slots: r.slots });
  r = await call('POST', '/chat/message', { sessionId: sid, text: '化妆新手，中长发' }); step('妆发习惯', { state: r.state });
  r = await call('POST', '/consent/face', { sessionId: sid, agree: true }); step('人脸授权', r.state);
  const body = await call('POST', '/photo/upload-ticket', { sessionId: sid, kind: 'body' });
  const face = await call('POST', '/photo/upload-ticket', { sessionId: sid, kind: 'face' }); step('上传凭证', { key: face.key, expireAt: face.expireAt });
  const look = await call('POST', '/look/generate', { sessionId: sid }); step('look_spec', look.lip.primary);
  for (const [path, payload] of [
    ['/render/tryon', { personUrl: body.publicUrl, garmentUrls: ['https://example.invalid/g1.jpg'] }],
    ['/render/lip', { faceUrl: face.publicUrl, hex: look.lip.primary.hex }],
    ['/render/hair', { baseUrl: face.publicUrl, instruction: look.hair.style }],
    ['/render/fulllook', { baseUrl: body.publicUrl, instruction: '整体造型' }],
  ] as const) { const t = await call('POST', path, payload); const d = await poll(t.taskId); step(path, { status: d.status, aiLabel: d.aiLabel?.explicit, ossKey: d.aiLabel?.ossKey }); if (d.status !== 'SUCCEEDED' || !String(d.aiLabel?.ossKey || '').startsWith('gen/')) throw new Error(path); }
  const fav = await call('POST', '/favorites', { kind: 'fulllook', title: '冒烟造型', coverUrl: 'https://example.invalid/mock-oss/gen/smoke.jpg', payload: { from: 'smoke' } });
  const listed = await call('GET', '/favorites?limit=10');
  if (!listed.items.some((x: any) => x.id === fav.id)) throw new Error('收藏未写入');
  await call('DELETE', `/favorites/${fav.id}`);
  if ((await call('GET', '/favorites')).items.length) throw new Error('收藏未删除');
  const member = await call('GET', '/member');
  if (!member.plans.some((p: any) => p.amountFen === 1290 && p.amountYuan === '12.9')) throw new Error('会员档位');
  const order = await call('POST', '/pay/orders', { sku: 'month' });
  if (!order.mock || order.amountFen !== 1290) throw new Error('下单');
  const paid = await call('POST', `/pay/orders/${order.outTradeNo}/mock-confirm`);
  if (paid.status !== 'PAID' || !paid.member.active) throw new Error('开通会员');
  const usage = await call('GET', '/usage/summary');
  if (usage.cost.calls < 4) throw new Error('用量 ' + JSON.stringify(usage.cost));
  step('收藏 / 会员 / 用量', { plan: order.amountYuan, calls: usage.cost.calls, quota: paid.member.quota });
  console.log('SMOKE OK');
} finally { await app.close(); }
