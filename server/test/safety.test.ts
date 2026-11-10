import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AliyunSafety, signAcs3, verdictFromRisk } from '../src/safety/aliyun.js';
import { createSafety, MockSafety } from '../src/safety/index.js';
import { decryptWechatMessage, encryptWechatMessage, WechatSafety, wechatMsgSignature } from '../src/safety/wechat.js';
import { readAigcMetadata } from '../src/storage/aigcMeta.js';
import { MemoryObjectStore } from '../src/storage/archive.js';
import { fakeFetch, mockCfg } from './helpers.js';

const green = { accessKeyId: 'ak', accessKeySecret: 'sk', region: 'cn-shanghai', endpoint: 'https://green-cip.cn-shanghai.aliyuncs.com', textService: 'comment_detection_pro', imageService: 'baselineCheck' };

describe('内容安全 provider', () => {
  it('mock 模式即使 provider=aliyun 也不出网', async () => {
    const { f, calls } = fakeFetch([]);
    const cfg = loadConfig();
    const safety = createSafety({ ...cfg, mode: 'mock', safety: { ...cfg.safety, provider: 'aliyun' } }, f);
    expect(safety).toBeInstanceOf(MockSafety);
    expect((await safety.checkText('赌博')).pass).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('live + 缺 key 的阿里云实现在调用时失败，而不是假装通过', async () => {
    const { f, calls } = fakeFetch([]);
    const cfg = loadConfig();
    const safety = createSafety({ ...cfg, mode: 'live', safety: { ...cfg.safety, provider: 'aliyun', aliyun: { ...green, accessKeyId: '', accessKeySecret: '' } } }, f);
    expect(safety).toBeInstanceOf(AliyunSafety);
    await expect(safety.checkText('你好')).rejects.toThrow(/ALIYUN_GREEN_ACCESS_KEY_ID/);
    expect(calls).toHaveLength(0);
  });

  it('阿里云文本/图片：签名头、Service 与 RiskLevel', async () => {
    const fixed = { timestamp: '2026-11-05T00:00:00Z', nonce: 'nonce-1' };
    const signed = signAcs3({ method: 'POST', host: 'green-cip.cn-shanghai.aliyuncs.com', action: 'TextModerationPlus', version: '2022-03-02', body: '{}', accessKeyId: 'ak', accessKeySecret: 'sk', ...fixed });
    expect(signed.authorization).toMatch(/^ACS3-HMAC-SHA256 Credential=ak,SignedHeaders=content-type;host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[0-9a-f]{64}$/);
    expect(signAcs3({ method: 'POST', host: 'green-cip.cn-shanghai.aliyuncs.com', action: 'TextModerationPlus', version: '2022-03-02', body: '{}', accessKeyId: 'ak', accessKeySecret: 'sk', ...fixed }).signature).toBe(signed.signature);
    expect(signAcs3({ method: 'POST', host: 'green-cip.cn-shanghai.aliyuncs.com', action: 'TextModerationPlus', version: '2022-03-02', body: '{"a":1}', accessKeyId: 'ak', accessKeySecret: 'sk', ...fixed }).signature).not.toBe(signed.signature);

    const { f, calls } = fakeFetch([
      { json: { Code: 200, Data: { RiskLevel: 'none' } } },
      { json: { Code: 200, Data: { RiskLevel: 'high', Result: [{ Label: 'porn' }] } } },
      { json: { Code: 200, Data: { RiskLevel: 'medium' } } },
    ]);
    const s = new AliyunSafety(green, f, () => fixed);
    expect(await s.checkText('今天穿什么')).toMatchObject({ pass: true, suggest: 'pass', provider: 'aliyun' });
    expect(calls[0]!.url).toBe('https://green-cip.cn-shanghai.aliyuncs.com/');
    expect(calls[0]!.headers['x-acs-action']).toBe('TextModerationPlus');
    expect(calls[0]!.headers.authorization).toMatch(/^ACS3-HMAC-SHA256 /);
    expect(calls[0]!.body).toEqual({ Service: 'comment_detection_pro', ServiceParameters: JSON.stringify({ content: '今天穿什么' }) });
    expect(await s.checkImage('https://img.example/a.jpg')).toMatchObject({ pass: false, suggest: 'block', label: 'porn' });
    expect(calls[1]!.headers['x-acs-action']).toBe('ImageModeration');
    expect(JSON.parse(calls[1]!.body.ServiceParameters).imageUrl).toBe('https://img.example/a.jpg');
    expect(await s.checkText('边界')).toMatchObject({ pass: false, suggest: 'review' });
    expect(() => verdictFromRisk({ RiskLevel: 'weird' }, 'aliyun')).toThrow(/RiskLevel/);
  });

  it('微信 msgSecCheck / mediaCheckAsync 与回调加解密', async () => {
    const { f, calls } = fakeFetch([
      { json: { access_token: 'tok', expires_in: 7200 } },
      { json: { errcode: 0, result: { suggest: 'pass', label: 100 } } },
      { json: { errcode: 0, result: { suggest: 'risky', label: 20001 } } },
      { json: { errcode: 0, trace_id: 'trace-1' } },
    ]);
    const wx = { appid: 'wx123', secret: 'sec' };
    const opt = { scene: 2, token: 'callback-token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' };
    const s = new WechatSafety(wx, opt, f, () => 1_700_000_000_000);
    expect(await s.checkText('你好', 'openid-1')).toMatchObject({ pass: true, provider: 'wechat' });
    expect(await s.checkText('不好', 'openid-1')).toMatchObject({ pass: false, suggest: 'block', label: '20001' });
    expect(calls.filter(c => c.url.includes('/cgi-bin/token'))).toHaveLength(1);
    const textCall = calls.find(c => c.url.includes('msg_sec_check'))!;
    expect(textCall.url).toContain('access_token=tok');
    expect(textCall.body).toEqual({ content: '你好', version: 2, scene: 2, openid: 'openid-1' });
    const pending = await s.checkImage('https://img.example/a.jpg', 'openid-1');
    expect(pending).toMatchObject({ pending: true, traceId: 'trace-1', provider: 'wechat' });
    expect(calls.at(-1)!.body).toMatchObject({ media_url: 'https://img.example/a.jpg', media_type: 2, version: 2, openid: 'openid-1' });
    await expect(s.checkText('x')).rejects.toThrow(/openid/);

    const ts = '1700000000';
    const nonce = 'abc';
    const echoSig = wechatMsgSignature(opt.token, ts, nonce);
    expect((await s.handleCallback({ timestamp: ts, nonce, signature: echoSig, echostr: 'hello' }, '')).echo).toBe('hello');
    await expect(s.handleCallback({ timestamp: ts, nonce, signature: 'deadbeef', echostr: 'hello' }, '')).rejects.toThrow(/签名/);

    const payload = JSON.stringify({ trace_id: 'trace-9', errcode: 0, result: { suggest: 'pass', label: 100 } });
    const sig = wechatMsgSignature(opt.token, ts, nonce);
    expect((await s.handleCallback({ timestamp: ts, nonce, signature: sig }, payload)).verdict).toMatchObject({ pass: true });

    const aes = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    expect(Buffer.from(aes + '=', 'base64')).toHaveLength(32);
    const plain = JSON.stringify({ trace_id: 'trace-enc', errcode: 0, result: { suggest: 'review', label: 10001 } });
    const enc = encryptWechatMessage(aes, 'wx123', plain, Buffer.alloc(16, 7));
    expect(decryptWechatMessage(aes, 'wx123', enc)).toBe(plain);
    const msgSig = wechatMsgSignature(opt.token, ts, nonce, enc);
    const wrapped = JSON.stringify({ Encrypt: enc });
    const parsed = await s.handleCallback({ timestamp: ts, nonce, msg_signature: msgSig }, wrapped);
    expect(parsed.verdict).toMatchObject({ pass: false, suggest: 'review' });
    expect(parsed.traceId).toBe('trace-enc');
  });

  it('图片异步回调通过后才归档到 gen/ 并写入隐式标识', async () => {
    const { f } = fakeFetch([
      { json: { access_token: 'tok', expires_in: 7200 } },
      { json: { errcode: 0, trace_id: 'trace-img' } },
    ]);
    const token = 'callback-token';
    const safety = new WechatSafety({ appid: 'wx123', secret: 'sec' }, { scene: 2, token, encodingAesKey: '' }, f, () => 1_700_000_000_000);
    const deps = await buildDeps({ cfg: mockCfg(), safety });
    const app = buildApp(deps);
    const { token: jwt } = (await app.inject({ method: 'POST', url: '/auth/login', payload: { code: 'c1' } })).json();
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${jwt}` } });
    const created = (await call('POST', '/render/lip', { faceUrl: 'https://x/f.jpg', hex: '#D9735F' })).json();
    await deps.render.settle(created.taskId);
    expect((await call('GET', `/render/tasks/${created.taskId}`)).json().status).toBe('RUNNING');
    expect((await call('GET', `/render/tasks/${created.taskId}`)).json()).toMatchObject({ status: 'RUNNING', aiLabel: { moderation: 'pending', traceId: 'trace-img' } });

    const ts = '1700000000';
    const nonce = 'n1';
    const raw = JSON.stringify({ trace_id: 'trace-img', errcode: 0, result: { suggest: 'pass', label: 100 } });
    const signature = wechatMsgSignature(token, ts, nonce);
    const cb = await app.inject({ method: 'POST', url: `/safety/wechat/callback?signature=${signature}&timestamp=${ts}&nonce=${nonce}`, payload: raw, headers: { 'content-type': 'application/json' } });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toBe('success');
    const done = (await call('GET', `/render/tasks/${created.taskId}`)).json();
    expect(done.status).toBe('SUCCEEDED');
    expect(done.resultUrl).toMatch(/\/gen\//);
    expect(done.aiLabel.ossKey).toMatch(/^gen\//);
    const stored = (deps.store as MemoryObjectStore).get(done.aiLabel.ossKey);
    expect(readAigcMetadata(stored!.body)?.ProduceID).toBe(created.taskId);
    expect(readAigcMetadata(stored!.body)?.Label).toBe('1');

    const bad = await app.inject({ method: 'POST', url: '/safety/wechat/callback?signature=no&timestamp=1&nonce=2', payload: raw, headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(401);
  });
});

describe('签名小工具不被空 nonce 破坏', () => {
  it('sha1 排序稳定', () => {
    const a = wechatMsgSignature('t', '2', '1');
    expect(a).toBe(createHash('sha1').update(['1', '2', 't'].sort().join('')).digest('hex'));
  });
});
