import { createDecipheriv, createCipheriv, createSign, createVerify, randomBytes } from 'node:crypto';
import { HttpError, UpstreamError, type Fetch } from '../http.js';

/**
 * 微信支付 API v3
 * - JSAPI 下单：https://pay.weixin.qq.com/doc/v3/merchant/4012791856
 * - 调起支付签名：https://pay.weixin.qq.com/doc/v3/merchant/4012365341
 * - 回调验签与 AEAD_AES_256_GCM 解密：https://pay.weixin.qq.com/doc/v3/merchant/4012071382
 * - 商户订单号查询：https://pay.weixin.qq.com/doc/v3/merchant/4012791858
 * 请求签名串：method\nurl\ntimestamp\nnonce\nbody\n
 * 回调验签串：timestamp\nnonce\nbody\n
 */

export type WxPayCfg = {
  appid: string;
  mchId: string;
  apiV3Key: string;
  privateKey: string;
  certSerial: string;
  platformCert: string;
  platformSerial: string;
  notifyUrl: string;
};

export type PayParams = { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string };

export function signWechatPay(privateKeyPem: string, message: string) {
  const sign = createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(privateKeyPem, 'base64');
}

export function verifyWechatPay(publicKeyPem: string, message: string, signatureB64: string) {
  const verify = createVerify('RSA-SHA256');
  verify.update(message);
  verify.end();
  return verify.verify(publicKeyPem, signatureB64, 'base64');
}

export function authorizationHeader(cfg: Pick<WxPayCfg, 'mchId' | 'certSerial' | 'privateKey'>, method: string, urlPath: string, body: string, timestamp: string, nonce: string) {
  const message = `${method.toUpperCase()}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = signWechatPay(cfg.privateKey, message);
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${cfg.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${cfg.certSerial}"`;
  return { message, signature, authorization };
}

export function buildPayParams(cfg: Pick<WxPayCfg, 'appid' | 'privateKey'>, prepayId: string, timestamp: string, nonceStr: string): PayParams {
  const pack = `prepay_id=${prepayId}`;
  const message = `${cfg.appid}\n${timestamp}\n${nonceStr}\n${pack}\n`;
  return { timeStamp: timestamp, nonceStr, package: pack, signType: 'RSA', paySign: signWechatPay(cfg.privateKey, message) };
}

export function decryptNotifyResource(apiV3Key: string, resource: { ciphertext: string; nonce: string; associated_data?: string }) {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new HttpError(503, 'WX_PAY_API_V3_KEY 必须是 32 字节');
  const buf = Buffer.from(resource.ciphertext, 'base64');
  if (buf.length < 16) throw new HttpError(400, '回调密文长度非法');
  const data = buf.subarray(0, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** 测试构造回调用，算法与 decryptNotifyResource 互逆 */
export function encryptNotifyResource(apiV3Key: string, resource: { nonce: string; associated_data?: string }, plaintext: string) {
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new Error('apiV3Key 必须是 32 字节');
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  if (resource.associated_data) cipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
}

export function verifyNotifySignature(cfg: Pick<WxPayCfg, 'platformCert' | 'platformSerial'>, headers: Record<string, string | undefined>, rawBody: string, nowSec = Math.floor(Date.now() / 1000)) {
  if (!cfg.platformCert) throw new HttpError(503, '微信支付未配置：缺少 WX_PAY_PLATFORM_CERT');
  const timestamp = headers['wechatpay-timestamp'] ?? '';
  const nonce = headers['wechatpay-nonce'] ?? '';
  const signature = headers['wechatpay-signature'] ?? '';
  const serial = headers['wechatpay-serial'] ?? '';
  if (cfg.platformSerial && serial !== cfg.platformSerial) throw new HttpError(401, '微信支付平台证书序列号不匹配');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) throw new HttpError(401, '微信支付回调时间戳超出 5 分钟');
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
  let ok = false;
  try { ok = verifyWechatPay(cfg.platformCert, message, signature); } catch { ok = false; }
  if (!ok) throw new HttpError(401, '微信支付回调签名错误');
  return message;
}

const nonceOf = () => randomBytes(16).toString('hex');

export async function jsapiPrepay(cfg: WxPayCfg, order: { description: string; outTradeNo: string; amountFen: number; openid: string }, f: Fetch, now = () => Math.floor(Date.now() / 1000)) {
  assertPayReady(cfg);
  const path = '/v3/pay/transactions/jsapi';
  const body = JSON.stringify({
    appid: cfg.appid,
    mchid: cfg.mchId,
    description: order.description,
    out_trade_no: order.outTradeNo,
    notify_url: cfg.notifyUrl,
    amount: { total: order.amountFen, currency: 'CNY' },
    payer: { openid: order.openid },
  });
  const timestamp = String(now());
  const nonce = nonceOf();
  const { authorization } = authorizationHeader(cfg, 'POST', path, body, timestamp, nonce);
  const res = await f(`https://api.mch.weixin.qq.com${path}`, { method: 'POST', headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' }, body });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.prepay_id) throw new UpstreamError('wxpay', res.status, String(j.code ?? res.status), j.message ?? 'JSAPI 下单失败');
  return { prepayId: String(j.prepay_id), pay: buildPayParams(cfg, j.prepay_id, timestamp, nonceOf()) };
}

export async function queryByOutTradeNo(cfg: WxPayCfg, outTradeNo: string, f: Fetch, now = () => Math.floor(Date.now() / 1000)) {
  assertPayReady(cfg);
  const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(cfg.mchId)}`;
  const timestamp = String(now());
  const nonce = nonceOf();
  const { authorization } = authorizationHeader(cfg, 'GET', path, '', timestamp, nonce);
  const res = await f(`https://api.mch.weixin.qq.com${path}`, { method: 'GET', headers: { Authorization: authorization, Accept: 'application/json' } });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new UpstreamError('wxpay', res.status, String(j.code ?? res.status), j.message ?? '查询订单失败');
  return j as { trade_state?: string; transaction_id?: string; amount?: { total?: number }; payer?: { openid?: string }; success_time?: string };
}

export function assertPayReady(cfg: WxPayCfg) {
  if (!cfg.appid || !cfg.mchId || !cfg.privateKey || !cfg.certSerial || !cfg.notifyUrl) throw new HttpError(503, '微信支付未配置：需要 WX_APPID、WX_PAY_MCH_ID、WX_PAY_PRIVATE_KEY、WX_PAY_CERT_SERIAL、WX_PAY_NOTIFY_URL');
  if (Buffer.byteLength(cfg.apiV3Key, 'utf8') !== 32) throw new HttpError(503, 'WX_PAY_API_V3_KEY 必须是 32 字节');
}
