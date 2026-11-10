import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp, buildDeps } from '../src/app.js';
import { decryptNotifyResource, encryptNotifyResource, signWechatPay, verifyWechatPay, type WxPayCfg } from '../src/pay/wechat.js';
import { fakeFetch, mockCfg } from './helpers.js';

const apiV3Key = '0123456789abcdef0123456789abcdef';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function payCfg(over: Partial<WxPayCfg> = {}): WxPayCfg {
  return { appid: 'wx_app', mchId: 'mch_1', apiV3Key, privateKey: priv, certSerial: 'SERIAL', platformCert: pub, platformSerial: 'PLAT', notifyUrl: 'https://api.example.com/pay/wechat/notify', ...over };
}

describe('微信支付 v3', () => {
  it('回调解密与金额校验、重复通知不叠加会员', async () => {
    const plain = JSON.stringify({ out_trade_no: 'YS1', trade_state: 'SUCCESS', amount: { total: 1290 } });
    const nonce = 'nonce12bytes';
    const ciphertext = encryptNotifyResource(apiV3Key, { nonce, associated_data: 'transaction' }, plain);
    expect(decryptNotifyResource(apiV3Key, { ciphertext, nonce, associated_data: 'transaction' }).amount.total).toBe(1290);
    expect(() => decryptNotifyResource('short', { ciphertext, nonce, associated_data: 'transaction' })).toThrow(/32/);

    const { f, calls } = fakeFetch([
      { json: { openid: 'openid-1' } },
      { json: { prepay_id: 'wx_prepay_1' } },
      { json: { prepay_id: 'wx_prepay_2' } },
      { json: { trade_state: 'NOTPAY', out_trade_no: 'pending' } },
    ]);
    const cfg = {
      ...mockCfg(),
      mode: 'live' as const,
      llmLive: false,
      wx: { live: true, appid: 'wx_app', secret: 'sec' },
      wxPay: payCfg(),
      plans: mockCfg().plans,
    };
    for (const k of ['dashscope', 'tencent', 'oss'] as const) (cfg as any)[k] = { ...(cfg as any)[k], live: false };
    const deps = await buildDeps({ cfg, fetch: f });
    const app = buildApp(deps);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { code: 'c' } });
    const token = login.json().token as string;
    const authed = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
    const created = (await authed('POST', '/pay/orders', { sku: 'month' })).json();
    expect(created.mock).toBe(false);
    expect(created.amountFen).toBe(1290);
    expect(created.pay.package).toBe('prepay_id=wx_prepay_1');
    expect(created.pay.signType).toBe('RSA');
    const payMsg = `wx_app\n${created.pay.timeStamp}\n${created.pay.nonceStr}\n${created.pay.package}\n`;
    expect(verifyWechatPay(pub, payMsg, created.pay.paySign)).toBe(true);

    const orderCall = calls[1]!;
    expect(orderCall.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
    expect(orderCall.body).toMatchObject({ appid: 'wx_app', mchid: 'mch_1', out_trade_no: created.outTradeNo, amount: { total: 1290, currency: 'CNY' }, payer: { openid: 'openid-1' }, notify_url: payCfg().notifyUrl });
    const auth = orderCall.headers.authorization;
    const nonceStr = auth.match(/nonce_str="([^"]+)"/)?.[1];
    const timestamp = auth.match(/timestamp="([^"]+)"/)?.[1];
    const signature = auth.match(/signature="([^"]+)"/)?.[1];
    const raw = JSON.stringify(orderCall.body);
    expect(verifyWechatPay(pub, `POST\n/v3/pay/transactions/jsapi\n${timestamp}\n${nonceStr}\n${raw}\n`, signature!)).toBe(true);

    const notify = (resource: unknown) => {
      const body = JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext: encryptNotifyResource(apiV3Key, { nonce: 'n-notify-1', associated_data: 'transaction' }, JSON.stringify(resource)), nonce: 'n-notify-1', associated_data: 'transaction' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const n = 'notify-nonce';
      const message = `${ts}\n${n}\n${body}\n`;
      return app.inject({
        method: 'POST', url: '/pay/wechat/notify', payload: body,
        headers: { 'content-type': 'application/json', 'wechatpay-timestamp': ts, 'wechatpay-nonce': n, 'wechatpay-signature': signWechatPay(priv, message), 'wechatpay-serial': 'PLAT' },
      });
    };
    const resource = { out_trade_no: created.outTradeNo, trade_state: 'SUCCESS', amount: { total: 1290 }, mchid: 'mch_1', appid: 'wx_app', payer: { openid: 'openid-1' }, transaction_id: 'tx-1', success_time: '2026-11-05T00:00:00+08:00' };
    expect((await notify(resource)).json()).toMatchObject({ code: 'SUCCESS' });
    const member = (await authed('GET', '/member')).json();
    expect(member.active).toBe(true);
    expect(member.level).toBe('month');
    const expire = member.expireAt;
    expect((await notify(resource)).json().code).toBe('SUCCESS');
    expect((await authed('GET', '/member')).json().expireAt).toBe(expire);

    const again = (await authed('POST', '/pay/orders', { sku: 'year' })).json();
    expect((await notify({ ...resource, out_trade_no: again.outTradeNo, amount: { total: 1 }, transaction_id: 'tx-bad' })).statusCode).toBe(400);
    const queried = (await authed('GET', `/pay/orders/${again.outTradeNo}`)).json();
    expect(queried.status).toBe('CREATED');
    expect(calls.some(c => c.url.includes(`/v3/pay/transactions/out-trade-no/${again.outTradeNo}`))).toBe(true);
    expect((await authed('GET', '/member')).json().level).toBe('month');
  });

  it('mock 下单不触网，确认后按到期日续期', async () => {
    const { f, calls } = fakeFetch([]);
    const deps = await buildDeps({ cfg: mockCfg(), fetch: f });
    const app = buildApp(deps);
    const { token, userId } = (await app.inject({ method: 'POST', url: '/auth/login', payload: { code: 'm' } })).json();
    const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
    expect((await call('POST', '/pay/orders', { sku: 'nope' })).statusCode).toBe(400);
    const month = (await call('POST', '/pay/orders', { sku: 'month' })).json();
    expect(month).toMatchObject({ mock: true, amountFen: 1290, amountYuan: '12.9', pay: null, status: 'CREATED' });
    expect(calls).toHaveLength(0);
    const confirmed = (await call('POST', `/pay/orders/${month.outTradeNo}/mock-confirm`)).json();
    expect(confirmed.status).toBe('PAID');
    expect(confirmed.member.active).toBe(true);
    const plans = (await call('GET', '/member')).json().plans;
    expect(plans.map((p: any) => p.amountFen)).toEqual([1290, 2900, 19800]);

    const future = new Date(Date.now() + 10 * 86400_000);
    await deps.repo.setMember(userId, 'month', future);
    const year = (await call('POST', '/pay/orders', { sku: 'year' })).json();
    await call('POST', `/pay/orders/${year.outTradeNo}/mock-confirm`);
    const expire = new Date((await call('GET', '/member')).json().expireAt);
    const delta = expire.getTime() - future.getTime();
    expect(delta).toBeGreaterThan(364 * 86400_000);
    expect(delta).toBeLessThan(366 * 86400_000);
    expect((await call('POST', '/pay/orders/NO-SUCH/mock-confirm')).statusCode).toBe(404);
  });
});
