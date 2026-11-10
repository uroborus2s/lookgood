import { createHash, createHmac } from 'node:crypto';
import { defaultFetch, UpstreamError, type Fetch } from '../http.js';
import type { ImageJobProvider, LipInput } from './types.js';

/**
 * 腾讯云 API 3.0 签名 TC3-HMAC-SHA256
 * 文档：https://cloud.tencent.com/document/api/213/30654
 */
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (k: string | Buffer, m: string) => createHmac('sha256', k).update(m, 'utf8').digest();

export type Tc3Args = { secretId: string; secretKey: string; service: string; host: string; action: string; payload: string; timestamp: number };
export function tc3Sign(a: Tc3Args) {
  const date = new Date(a.timestamp * 1000).toISOString().slice(0, 10);
  const ct = 'application/json; charset=utf-8';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', `content-type:${ct}\nhost:${a.host}\nx-tc-action:${a.action.toLowerCase()}\n`, signedHeaders, sha256(a.payload)].join('\n');
  const scope = `${date}/${a.service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(a.timestamp), scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac('TC3' + a.secretKey, date), a.service), 'tc3_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return { canonicalRequest, stringToSign, signature, authorization: `TC3-HMAC-SHA256 Credential=${a.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

export type TencentCfg = { secretId: string; secretKey: string; region: string };

export async function tencentCall(cfg: TencentCfg, o: { service: string; host: string; action: string; version: string; body: unknown }, f: Fetch = defaultFetch, now = () => Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify(o.body);
  const timestamp = now();
  const { authorization } = tc3Sign({ ...cfg, service: o.service, host: o.host, action: o.action, payload, timestamp });
  const res = await f(`https://${o.host}/`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json; charset=utf-8', Host: o.host, 'X-TC-Action': o.action, 'X-TC-Timestamp': String(timestamp), 'X-TC-Version': o.version, 'X-TC-Region': cfg.region },
    body: payload,
  });
  const j: any = await res.json();
  if (j.Response?.Error) throw new UpstreamError('tencent', res.status, j.Response.Error.Code, j.Response.Error.Message);
  return j.Response;
}

export function hexToRgb(hex: string) { const n = parseInt(hex.slice(1), 16); return { R: (n >> 16) & 255, G: (n >> 8) & 255, B: n & 255 }; }

/**
 * 试唇色 TryLipstickPic（人脸试妆 fmu，Version 2019-12-13）
 * 文档：https://cloud.tencent.com/document/api/1172/40706
 * body: { Url, LipColorInfos:[{ RGBA:{R,G,B,A} }], RspImgType:'url' } → Response.ResultUrl（1 天有效）
 * 限制：20 次/秒；最多 3 张人脸；图片 ≤2000×2000
 */
export function tencentLip(cfg: TencentCfg, f: Fetch = defaultFetch, now?: () => number): ImageJobProvider<LipInput> {
  return {
    name: 'tencent-fmu',
    async submit({ faceUrl, hex, alpha = 70 }) {
      const r = await tencentCall(cfg, { service: 'fmu', host: 'fmu.tencentcloudapi.com', action: 'TryLipstickPic', version: '2019-12-13', body: { Url: faceUrl, LipColorInfos: [{ RGBA: { ...hexToRgb(hex), A: alpha } }], RspImgType: 'url' } }, f, now);
      if (!r.ResultUrl) throw new UpstreamError('tencent', 200, 'NO_IMAGE', '响应中没有 ResultUrl');
      return { resultUrl: r.ResultUrl };
    },
  };
}
