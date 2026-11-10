import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../src/app.js';
import { assertProductionConfig, shannonEntropy } from '../src/auth/secrets.js';
import { parseMemberPlans, parseModelPrices, formatYuan } from '../src/config.js';
import { shanghaiDayStart } from '../src/quota.js';
import { invokeFc } from '../src/fc.js';
import { crc32, embedAigcMetadata, MINIMAL_JPEG, readAigcMetadata, buildAigcFields, type AigcFields } from '../src/storage/aigcMeta.js';
import { ArchivingAiLabeler, MemoryObjectStore } from '../src/storage/archive.js';
import { fakeFetch, mockCfg } from './helpers.js';

const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('配置与生产密钥', () => {
  it('会员价与模型单价可配置，缺单价不臆造', () => {
    expect(parseMemberPlans('')).toMatchObject([{ amountFen: 1290 }, { amountFen: 2900 }, { amountFen: 19800 }]);
    expect(parseMemberPlans('[{"sku":"week","title":"周卡","amountFen":100,"days":7}]')).toEqual([{ sku: 'week', title: '周卡', amountFen: 100, days: 7 }]);
    expect(() => parseMemberPlans('{"sku":"x"}')).toThrow(/JSON|数组/);
    expect(parseModelPrices('qwen-image-3.0=0.2, wan2.7-image=0')).toEqual({ 'qwen-image-3.0': 0.2, 'wan2.7-image': 0 });
    expect(parseModelPrices('')).toEqual({});
    expect(() => parseModelPrices('nope')).toThrow(/model=price/);
    expect(formatYuan(1290)).toBe('12.9');
    expect(formatYuan(2900)).toBe('29');
    expect(formatYuan(19800)).toBe('198');
  });

  it('生产环境拒绝过短或占位 JWT_SECRET', () => {
    const prod = { NODE_ENV: 'production' };
    expect(() => assertProductionConfig({ jwtSecret: 'test' }, prod)).toThrow(/32 字节/);
    expect(() => assertProductionConfig({ jwtSecret: 'x'.repeat(40) }, prod)).toThrow(/随机/);
    expect(() => assertProductionConfig({ jwtSecret: `change-me-${'a1'.repeat(20)}` }, prod)).toThrow(/占位/);
    const ok = randomBytes(32).toString('base64');
    expect(Buffer.byteLength(ok)).toBeGreaterThanOrEqual(32);
    expect(shannonEntropy(ok)).toBeGreaterThan(3.5);
    expect(() => assertProductionConfig({ jwtSecret: ok }, prod)).not.toThrow();
    expect(() => assertProductionConfig({ jwtSecret: 'test' }, { NODE_ENV: 'test' })).not.toThrow();
  });

  it('北京时间自然日', () => {
    expect(shanghaiDayStart(new Date('2026-11-05T11:00:00.000Z')).toISOString()).toBe('2026-11-04T16:00:00.000Z');
    expect(shanghaiDayStart(new Date('2026-11-04T15:59:59.000Z')).toISOString()).toBe('2026-11-03T16:00:00.000Z');
    expect(shanghaiDayStart(new Date('2026-11-04T16:00:00.000Z')).toISOString()).toBe('2026-11-04T16:00:00.000Z');
  });
});

describe('隐式 AI 标识与 OSS 归档', () => {
  const meta: AigcFields = buildAigcFields({ producer: '一身好看', propagator: '一身好看', produceId: 'task-1', secret: 'reserved-secret' });

  it('crc32 与 JPEG/PNG/WEBP 往返', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    for (const buf of [MINIMAL_JPEG, png1x1, fakeWebp()]) {
      const out = embedAigcMetadata(buf, meta);
      expect(readAigcMetadata(out)).toMatchObject({ Label: '1', ProduceID: 'task-1', ContentProducer: '一身好看' });
      expect(out.includes(Buffer.from(meta.ReservedCode1))).toBe(true);
    }
    const hmac = buildAigcFields({ producer: '一身好看', propagator: '一身好看', produceId: 'task-1', secret: 'reserved-secret' });
    const digest = buildAigcFields({ producer: '一身好看', propagator: '一身好看', produceId: 'task-1', secret: '' });
    expect(hmac.ReservedCode1).not.toBe(digest.ReservedCode1);
  });

  it('live 模式下载后写入 gen/，mock 模式不请求图片 URL', async () => {
    const jpeg = embedAigcMetadata(MINIMAL_JPEG, meta);
    const { f, calls } = fakeFetch([]);
    const store = new MemoryObjectStore();
    const mockLabeler = new ArchivingAiLabeler({ store, fetch: f, mode: 'mock', aigc: { producer: '一身好看', propagator: '一身好看', reservedSecret: '' } });
    const labeled = await mockLabeler.label('https://vendor.example/a.jpg', { taskId: 'tid', provider: 'qwen-image-3.0', userId: '7' });
    expect(calls).toHaveLength(0);
    expect(labeled.displayUrl).toBe('https://example.invalid/mock-oss/gen/7/tid.jpg');
    expect(labeled.implicit.AIGC).toBe('true');
    expect(readAigcMetadata(store.get('gen/7/tid.jpg')!.body)?.ProduceID).toBe('tid');

    const liveCalls: { url: string }[] = [];
    const liveStore = new MemoryObjectStore();
    const wrapped: typeof fetch = async (url) => {
      liveCalls.push({ url: String(url) });
      return new Response(new Uint8Array(jpeg), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    const live = new ArchivingAiLabeler({ store: liveStore, fetch: wrapped, mode: 'live', aigc: { producer: 'P', propagator: 'P', reservedSecret: 's' } });
    const again = await live.label('https://vendor.example/real.jpg', { taskId: 'tid2', provider: 'wan2.7-image', userId: '7' });
    expect(again.displayUrl).toContain('/gen/7/tid2.jpg');
    expect(liveCalls[0]!.url).toBe('https://vendor.example/real.jpg');
    expect(readAigcMetadata(liveStore.get('gen/7/tid2.jpg')!.body)?.ContentProducer).toBe('P');
  });
});

describe('收藏、额度与成本', () => {
  it('收藏增删分页只看见自己的', async () => {
    const deps = await buildDeps({ cfg: mockCfg() });
    const app = buildApp(deps);
    const login = async (code: string) => (await app.inject({ method: 'POST', url: '/auth/login', payload: { code } })).json().token as string;
    const a = await login('a');
    const b = await login('b');
    const call = (token: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
    expect((await call(a, 'GET', '/favorites')).json()).toEqual({ items: [], nextCursor: null });
    for (let i = 0; i < 3; i++) expect((await call(a, 'POST', '/favorites', { kind: 'tryon', title: `造型${i}`, coverUrl: 'https://example.invalid/a.jpg', payload: { i } })).statusCode).toBe(200);
    await call(b, 'POST', '/favorites', { kind: 'look', title: '别人的', payload: { secret: true } });
    const page = (await call(a, 'GET', '/favorites?limit=2')).json();
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    const rest = (await call(a, 'GET', `/favorites?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    const titles = [...page.items, ...rest.items].map((x: any) => x.title).sort();
    expect(titles).toEqual(['造型0', '造型1', '造型2']);
    const id = page.items[0].id;
    expect((await call(b, 'DELETE', `/favorites/${id}`)).statusCode).toBe(404);
    expect((await call(a, 'DELETE', `/favorites/${id}`)).json()).toEqual({ ok: true });
    expect((await call(a, 'POST', '/favorites', { kind: 'look', title: 'x', payload: { big: 'y'.repeat(9000) } })).statusCode).toBe(400);
  });

  it('非会员与会员每日生成次数不同，并按模型单价汇总', async () => {
    const cfg = { ...mockCfg(), freeDailyQuota: 1, memberDailyQuota: 3, modelPrices: { lip: 2, mock: 1 } };
    const deps = await buildDeps({ cfg });
    const app = buildApp(deps);
    const { token, userId } = (await app.inject({ method: 'POST', url: '/auth/login', payload: { code: 'q' } })).json();
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
    const lip = () => call('POST', '/render/lip', { faceUrl: 'https://x/f.jpg', hex: '#D9735F' });
    const first = await lip();
    expect(first.statusCode).toBe(200);
    await deps.render.settle(first.json().taskId);
    expect((await lip()).statusCode).toBe(429);
    expect((await lip()).json().error).toMatch(/1\/1/);
    await deps.repo.setMember(userId, 'month', new Date(Date.now() + 86400_000));
    const second = await lip();
    expect(second.statusCode).toBe(200);
    await deps.render.settle(second.json().taskId);
    await call('POST', '/chat/message', { text: '你好' });
    const summary = (await call('GET', '/usage/summary')).json();
    expect(summary.quota.member).toBe(true);
    expect(summary.quota.limit).toBe(3);
    expect(summary.quota.used).toBe(2);
    const lipRow = summary.cost.byModel.find((x: any) => x.model === 'lip');
    const chatRow = summary.cost.byModel.find((x: any) => x.model === 'mock');
    expect(lipRow).toMatchObject({ calls: 2, costCny: '4.0000', unpricedCalls: 0 });
    expect(chatRow.calls).toBeGreaterThanOrEqual(1);
    expect(chatRow.costCny).toBe(`${chatRow.calls}.0000`);
    const taskId = first.json().taskId as string;
    await call('GET', `/render/tasks/${taskId}`);
    const done = (await call('GET', `/render/tasks/${taskId}`)).json();
    expect(done.status).toBe('SUCCEEDED');
    const archived = (deps.store as MemoryObjectStore).get(done.aiLabel.ossKey);
    expect(readAigcMetadata(archived!.body)?.Label).toBe('1');
  });
});

describe('函数计算适配', () => {
  it('HTTP 事件转成 /health', async () => {
    const app = buildApp(await buildDeps({ cfg: mockCfg() }));
    const res = await invokeFc(app as any, { rawPath: '/health', headers: { 'x-request-id': 'r' }, requestContext: { http: { method: 'GET', path: '/health' } } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, mode: 'mock' });
    const b64 = Buffer.from(JSON.stringify({ code: 'fc' })).toString('base64');
    const login = await invokeFc(app as any, { rawPath: '/auth/login', isBase64Encoded: true, body: b64, headers: { 'content-type': 'application/json' }, requestContext: { http: { method: 'POST' } } });
    expect(login.statusCode).toBe(200);
    expect(JSON.parse(login.body).token).toBeTruthy();
  });
});

function fakeWebp() {
  const body = Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'),
    Buffer.from('VP8 '), Buffer.alloc(4),
  ]);
  body.writeUInt32LE(body.length - 8, 4);
  return body;
}
