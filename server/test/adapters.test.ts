import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { qwenTryOn, wanEdit } from '../src/adapters/dashscope.js';
import { tc3Sign, tencentLip, hexToRgb } from '../src/adapters/tencent.js';
import { signPostPolicy } from '../src/storage/oss.js';
import { code2Session } from '../src/auth/wechat.js';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';
import { fakeFetch } from './helpers.js';

const dash = { apiKey: 'sk-test', baseURL: 'https://dashscope.aliyuncs.com/', tryonModel: 'qwen-image-3.0', lookModel: 'wan2.7-image' };

describe('DashScope', () => {
  it('qwen-image-3.0 试衣：请求体与取图', async () => {
    const { f, calls } = fakeFetch([{ json: { output: { choices: [{ message: { content: [{ image: 'https://r/1.png' }] } }] } } }]);
    const r = await qwenTryOn(dash, f).submit({ personUrl: 'https://p', garmentUrls: ['https://g1', 'https://g2', 'https://g3'] });
    expect(r.resultUrl).toBe('https://r/1.png');
    const c = calls[0];
    expect(c.url).toBe('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    expect(c.headers.authorization).toBe('Bearer sk-test');
    expect(c.body.model).toBe('qwen-image-3.0');
    const content = c.body.input.messages[0].content;
    expect(content.filter((x: any) => x.image)).toHaveLength(3); // 最多 3 张
    expect(content.at(-1).text).toContain('图1');
  });
  it('wan2.7-image 异步提交 + 轮询', async () => {
    const { f, calls } = fakeFetch([
      { json: { request_id: 'r', output: { task_status: 'PENDING', task_id: 'T1' } } },
      { json: { output: { task_status: 'RUNNING', task_id: 'T1' } } },
      { json: { output: { task_status: 'SUCCEEDED', task_id: 'T1', choices: [{ message: { content: [{ type: 'image', image: 'https://r/w.png' }] } }] } } },
    ]);
    const p = wanEdit(dash, f);
    expect(await p.submit({ baseUrl: 'https://b', instruction: '换成低马尾' })).toEqual({ providerTaskId: 'T1' });
    expect(calls[0].headers['x-dashscope-async']).toBe('enable');
    expect(calls[0].url).toMatch(/\/api\/v1\/services\/aigc\/image-generation\/generation$/);
    expect(calls[0].body.parameters).toMatchObject({ n: 1, watermark: false });
    expect((await p.poll!('T1')).status).toBe('RUNNING');
    expect(await p.poll!('T1')).toEqual({ status: 'SUCCEEDED', resultUrl: 'https://r/w.png' });
    expect(calls[1].url).toBe('https://dashscope.aliyuncs.com/api/v1/tasks/T1');
  });
  it('wan 失败与 HTTP 错误', async () => {
    const { f } = fakeFetch([{ json: { output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: 'x' } } }, { status: 401, json: { code: 'InvalidApiKey', message: 'bad' } }]);
    const p = wanEdit(dash, f);
    expect((await p.poll!('T')).error).toContain('DataInspectionFailed');
    await expect(p.submit({ baseUrl: 'https://b', instruction: 'x' })).rejects.toThrow('InvalidApiKey');
  });
});

describe('腾讯云 TC3', () => {
  // 官方文档示例 https://cloud.tencent.com/document/api/213/30654 （SecretKey 文档已打码，故校验到 CanonicalRequest 哈希为止）
  const payload = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';
  const s = tc3Sign({ secretId: 'test-secret-id', secretKey: 'k', service: 'cvm', host: 'cvm.tencentcloudapi.com', action: 'DescribeInstances', payload, timestamp: 1551113065 });
  it('payload 哈希与文档一致', () => expect(createHash('sha256').update(payload).digest('hex')).toBe('35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064'));
  it('CanonicalRequest 哈希与文档一致', () => expect(createHash('sha256').update(s.canonicalRequest).digest('hex')).toBe('7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84'));
  it('StringToSign 与 Authorization 格式', () => {
    expect(s.stringToSign).toBe('TC3-HMAC-SHA256\n1551113065\n2019-02-25/cvm/tc3_request\n7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84');
    expect(s.authorization).toMatch(/^TC3-HMAC-SHA256 Credential=test-secret-id\/2019-02-25\/cvm\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
  });
  it('TryLipstickPic 请求', async () => {
    const { f, calls } = fakeFetch([{ json: { Response: { ResultUrl: 'https://t/lip.jpg', RequestId: 'x' } } }]);
    const r = await tencentLip({ secretId: 'id', secretKey: 'key', region: 'ap-guangzhou' }, f, () => 1551113065).submit({ faceUrl: 'https://face', hex: '#D9735F' });
    expect(r.resultUrl).toBe('https://t/lip.jpg');
    const c = calls[0];
    expect(c.url).toBe('https://fmu.tencentcloudapi.com/');
    expect(c.headers['x-tc-action']).toBe('TryLipstickPic'); expect(c.headers['x-tc-version']).toBe('2019-12-13');
    expect(c.headers['x-tc-timestamp']).toBe('1551113065');
    expect(c.body).toEqual({ Url: 'https://face', LipColorInfos: [{ RGBA: { R: 217, G: 115, B: 95, A: 70 } }], RspImgType: 'url' });
    const expectSig = tc3Sign({ secretId: 'id', secretKey: 'key', service: 'fmu', host: 'fmu.tencentcloudapi.com', action: 'TryLipstickPic', payload: JSON.stringify(c.body), timestamp: 1551113065 }).authorization;
    expect(c.headers.authorization).toBe(expectSig);
  });
  it('错误码透出', async () => {
    const { f } = fakeFetch([{ json: { Response: { Error: { Code: 'FailedOperation.ImageFacedetectFailed', Message: 'no face' } } } }]);
    await expect(tencentLip({ secretId: 'i', secretKey: 'k', region: 'r' }, f).submit({ faceUrl: 'https://x', hex: '#000000' })).rejects.toThrow('ImageFacedetectFailed');
  });
  it('hexToRgb', () => expect(hexToRgb('#FF8000')).toEqual({ R: 255, G: 128, B: 0 }));
});

describe('OSS POST V4 策略', () => {
  const now = new Date('2026-11-05T01:02:03Z');
  const r = signPostPolicy({ accessKeyId: 'AK', accessKeySecret: 'SK', region: 'cn-beijing', bucket: 'b', key: 'raw/1/x.jpg', maxBytes: 100, now });
  it('表单字段', () => {
    expect(r.formData['x-oss-credential']).toBe('AK/20261105/cn-beijing/oss/aliyun_v4_request');
    expect(r.formData['x-oss-date']).toBe('20261105T010203Z');
    expect(r.formData['x-oss-signature-version']).toBe('OSS4-HMAC-SHA256');
    expect(r.policy.expiration).toBe('2026-11-05T01:12:03.000Z');
    expect(r.policy.conditions).toContainEqual(['content-length-range', 1, 100]);
    expect(r.policy.conditions).toContainEqual({ bucket: 'b' });
    expect(JSON.parse(Buffer.from(r.formData.policy, 'base64').toString())).toEqual(r.policy);
  });
  it('签名可独立复算', async () => {
    const { createHmac } = await import('node:crypto');
    const h = (k: any, m: string) => createHmac('sha256', k).update(m).digest();
    const key = h(h(h(h('aliyun_v4SK', '20261105'), 'cn-beijing'), 'oss'), 'aliyun_v4_request');
    expect(r.formData['x-oss-signature']).toBe(createHmac('sha256', key).update(r.formData.policy).digest('hex'));
  });
});

describe('微信登录 + JWT', () => {
  const wx = { live: true, appid: 'wxapp', secret: 's' };
  it('code2Session 请求与解析', async () => {
    const { f, calls } = fakeFetch([{ json: { openid: 'o1', session_key: 'sk' } }]);
    expect(await code2Session(wx, 'CODE', f)).toEqual({ openid: 'o1', unionid: undefined });
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.weixin.qq.com/sns/jscode2session');
    expect(Object.fromEntries(u.searchParams)).toEqual({ appid: 'wxapp', secret: 's', js_code: 'CODE', grant_type: 'authorization_code' });
  });
  it('errcode 抛错', async () => {
    const { f } = fakeFetch([{ json: { errcode: 40029, errmsg: 'invalid code' } }]);
    await expect(code2Session(wx, 'bad', f)).rejects.toThrow('40029');
  });
  it('mock 不联网', async () => expect(await code2Session({ ...wx, live: false }, 'c')).toEqual({ openid: 'mock_c' }));
  it('JWT 签发、校验、过期、篡改', () => {
    const t = signJwt({ sub: '1', openid: 'o' }, 's', 60, 1000);
    expect(verifyJwt(t, 's', 1030)?.sub).toBe('1');
    expect(verifyJwt(t, 's', 1061)).toBeNull();
    expect(verifyJwt(t, 'other', 1030)).toBeNull();
    expect(verifyJwt(t.slice(0, -2) + 'xx', 's', 1030)).toBeNull();
  });
});
