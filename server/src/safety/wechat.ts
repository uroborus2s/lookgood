import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, UpstreamError, type Fetch } from '../http.js';
import { mapSuggest, type Verdict } from './verdict.js';
import type { ContentSafety } from './index.js';

/**
 * 微信小程序内容安全
 * - 文本 msgSecCheck v2：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/sec-center/sec-check/msgSecCheck.html
 * - 图片 mediaCheckAsync（异步，结果走消息推送）：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/sec-center/sec-check/mediaCheckAsync.html
 * - 消息加解密（安全模式，PKCS#7 块大小 32）：https://developers.weixin.qq.com/doc/oplatform/developers/dev/push/encryption.html
 * access_token：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getAccessToken.html
 */
export type WechatSafetyOpts = { scene: number; token: string; encodingAesKey: string };

export class WechatSafety implements ContentSafety {
  private cache?: { token: string; expMs: number };
  constructor(
    private wx: { appid: string; secret: string },
    private opt: WechatSafetyOpts,
    private fetchImpl: Fetch,
    private now: () => number = Date.now,
  ) {}

  private async accessToken() {
    if (!this.wx.appid || !this.wx.secret) throw new HttpError(503, '微信内容安全未配置：缺少 WX_APPID / WX_SECRET');
    if (this.cache && this.cache.expMs > this.now()) return this.cache.token;
    const q = new URLSearchParams({ grant_type: 'client_credential', appid: this.wx.appid, secret: this.wx.secret });
    const res = await this.fetchImpl(`https://api.weixin.qq.com/cgi-bin/token?${q}`);
    const j: any = await res.json().catch(() => ({}));
    if (!j.access_token) throw new UpstreamError('wechat', res.status, String(j.errcode ?? 'NO_TOKEN'), j.errmsg ?? '获取 access_token 失败');
    const ttl = Math.max(60, Number(j.expires_in ?? 7200) - 120);
    this.cache = { token: j.access_token, expMs: this.now() + ttl * 1000 };
    return j.access_token as string;
  }

  async checkText(text: string, openid?: string): Promise<Verdict> {
    if (!openid) throw new HttpError(400, '微信 msgSecCheck 需要用户 openid');
    const token = await this.accessToken();
    const res = await this.fetchImpl(`https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, version: 2, scene: this.opt.scene, openid }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (j.errcode) throw new UpstreamError('wechat', res.status, String(j.errcode), j.errmsg ?? 'msgSecCheck 失败');
    return mapSuggest(j.result?.suggest, j.result?.label, 'wechat');
  }

  /** 提交异步图片审核。Verdict.pending=true，最终结果由回调 applyModeration 决定 */
  async checkImage(url: string, openid?: string): Promise<Verdict> {
    if (!openid) throw new HttpError(400, '微信 mediaCheckAsync 需要用户 openid');
    const token = await this.accessToken();
    const res = await this.fetchImpl(`https://api.weixin.qq.com/wxa/media_check_async?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ media_url: url, media_type: 2, version: 2, scene: this.opt.scene, openid }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (j.errcode || !j.trace_id) throw new UpstreamError('wechat', res.status, String(j.errcode ?? 'NO_TRACE'), j.errmsg ?? 'mediaCheckAsync 失败');
    return { pass: false, suggest: 'review', provider: 'wechat', pending: true, traceId: String(j.trace_id), label: 'pending' };
  }

  /**
   * GET：服务器 URL 验证，验签通过后原样返回 echostr。
   * POST：明文模式验 query.signature；安全模式先验 msg_signature 再解密 Encrypt。
   */
  async handleCallback(query: Record<string, string | undefined>, rawBody: string): Promise<{ echo?: string; traceId?: string; verdict?: Verdict }> {
    if (!this.opt.token) throw new HttpError(503, '微信内容安全回调未配置：缺少 WX_SAFETY_TOKEN');
    const timestamp = query.timestamp ?? '';
    const nonce = query.nonce ?? '';
    if (query.echostr != null && !rawBody) {
      if (!safeEqual(wechatMsgSignature(this.opt.token, timestamp, nonce), query.signature ?? '')) throw new HttpError(401, '微信回调签名错误');
      return { echo: query.echostr };
    }
    const body = parseCallbackBody(rawBody);
    const encrypt = typeof body.Encrypt === 'string' ? body.Encrypt : undefined;
    const expect = encrypt ? (query.msg_signature ?? query.signature ?? '') : (query.signature ?? '');
    const got = wechatMsgSignature(this.opt.token, timestamp, nonce, encrypt);
    if (!safeEqual(got, expect)) throw new HttpError(401, '微信回调签名错误');
    const json = encrypt ? JSON.parse(decryptWechatMessage(this.opt.encodingAesKey, this.wx.appid, encrypt)) : body;
    const parsed = parseMediaCheckPayload(json);
    return parsed;
  }
}

export function wechatMsgSignature(token: string, timestamp: string, nonce: string, encrypt?: string) {
  const parts = [token, timestamp, nonce];
  if (encrypt) parts.push(encrypt);
  return createHash('sha1').update(parts.sort().join('')).digest('hex');
}

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function parseCallbackBody(raw: string): any {
  const s = raw.trim();
  if (!s) return {};
  if (s.startsWith('<')) {
    const encrypt = s.match(/<Encrypt><!\[CDATA\[([\s\S]*?)\]\]><\/Encrypt>/)?.[1] ?? s.match(/<Encrypt>([\s\S]*?)<\/Encrypt>/)?.[1];
    return encrypt ? { Encrypt: encrypt } : {};
  }
  return JSON.parse(s);
}

export function parseMediaCheckPayload(json: any): { traceId: string; verdict: Verdict } {
  const traceId = String(json?.trace_id ?? '');
  if (!traceId) throw new HttpError(400, '回调缺少 trace_id');
  if (json.errcode && Number(json.errcode) !== 0) {
    return { traceId, verdict: { pass: false, suggest: 'block', provider: 'wechat', label: String(json.errmsg ?? json.errcode) } };
  }
  return { traceId, verdict: mapSuggest(json.result?.suggest, json.result?.label, 'wechat') };
}

function aesKeyOf(encodingAesKey: string) {
  if (!encodingAesKey) throw new HttpError(503, '安全模式缺少 WX_SAFETY_ENCODING_AES_KEY');
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) throw new HttpError(503, 'WX_SAFETY_ENCODING_AES_KEY 解码后不是 32 字节');
  return key;
}

/** 微信消息体：random(16) + msgLen(4, BE) + msg + appid，再按 32 字节 PKCS#7 填充 */
export function decryptWechatMessage(encodingAesKey: string, appid: string, encryptB64: string) {
  const key = aesKeyOf(encodingAesKey);
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(Buffer.concat([decipher.update(Buffer.from(encryptB64, 'base64')), decipher.final()]));
  const len = plain.readUInt32BE(16);
  const msg = plain.subarray(20, 20 + len).toString('utf8');
  const id = plain.subarray(20 + len).toString('utf8');
  if (appid && id !== appid) throw new HttpError(401, '微信回调 AppID 不匹配');
  return msg;
}

export function encryptWechatMessage(encodingAesKey: string, appid: string, msg: string, random16 = randomBytes(16)) {
  const key = aesKeyOf(encodingAesKey);
  const msgBuf = Buffer.from(msg);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msgBuf.length, 0);
  const packed = pkcs7Pad(Buffer.concat([random16, len, msgBuf, Buffer.from(appid)]));
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(packed), cipher.final()]).toString('base64');
}

function pkcs7Pad(buf: Buffer, block = 32) {
  const pad = block - (buf.length % block);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}
function pkcs7Unpad(buf: Buffer) {
  const pad = buf[buf.length - 1] ?? 0;
  if (pad < 1 || pad > 32) throw new HttpError(400, '微信消息填充非法');
  return buf.subarray(0, buf.length - pad);
}
