import { createHash, createHmac } from 'node:crypto';
import { HttpError, UpstreamError, type Fetch } from '../http.js';
import type { Verdict } from './verdict.js';
import type { ContentSafety } from './index.js';

/**
 * 阿里云内容安全增强版（green-cip，2019 年 API 的替代）
 * 签名：ACS3-HMAC-SHA256 https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
 * 接口：TextModerationPlus / ImageModeration，版本 2022-03-02
 * https://help.aliyun.com/document_detail/2671445.html
 * 未用真实密钥联调过，上线前用控制台样本对一次签名与 RiskLevel。
 */
export type AliyunGreenCfg = {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  endpoint: string;
  textService: string;
  imageService: string;
};

export type AcsSignInput = {
  method: string;
  host: string;
  path?: string;
  action: string;
  version: string;
  body: string;
  accessKeyId: string;
  accessKeySecret: string;
  timestamp: string;
  nonce: string;
};

export function signAcs3(a: AcsSignInput) {
  const payloadHash = sha256(a.body);
  const headers: Record<string, string> = {
    host: a.host,
    'content-type': 'application/json',
    'x-acs-action': a.action,
    'x-acs-version': a.version,
    'x-acs-date': a.timestamp,
    'x-acs-signature-nonce': a.nonce,
    'x-acs-content-sha256': payloadHash,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(n => `${n}:${headers[n]!.trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [a.method.toUpperCase(), a.path || '/', '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256(canonical)}`;
  const signature = createHmac('sha256', a.accessKeySecret).update(stringToSign).digest('hex');
  const authorization = `ACS3-HMAC-SHA256 Credential=${a.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { authorization, headers, canonical, stringToSign, signature };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class AliyunSafety implements ContentSafety {
  constructor(private cfg: AliyunGreenCfg, private fetchImpl: Fetch, private clock: () => { timestamp: string; nonce: string } = defaultClock) {}

  async checkText(text: string): Promise<Verdict> {
    return this.call('TextModerationPlus', this.cfg.textService, { content: text });
  }
  async checkImage(url: string): Promise<Verdict> {
    return this.call('ImageModeration', this.cfg.imageService, { imageUrl: url });
  }

  private async call(action: string, service: string, parameters: Record<string, string>): Promise<Verdict> {
    if (!this.cfg.accessKeyId || !this.cfg.accessKeySecret) throw new HttpError(503, '阿里云内容安全未配置：缺少 ALIYUN_GREEN_ACCESS_KEY_ID / ALIYUN_GREEN_ACCESS_KEY_SECRET');
    const endpoint = (this.cfg.endpoint || `https://green-cip.${this.cfg.region}.aliyuncs.com`).replace(/\/+$/, '');
    const host = new URL(endpoint).host;
    const body = JSON.stringify({ Service: service, ServiceParameters: JSON.stringify(parameters) });
    const { timestamp, nonce } = this.clock();
    const signed = signAcs3({ method: 'POST', host, action, version: '2022-03-02', body, accessKeyId: this.cfg.accessKeyId, accessKeySecret: this.cfg.accessKeySecret, timestamp, nonce });
    const res = await this.fetchImpl(`${endpoint}/`, { method: 'POST', headers: { ...signed.headers, authorization: signed.authorization }, body });
    const j: any = await res.json().catch(() => ({}));
    const code = Number(j.Code ?? j.code ?? res.status);
    if (!res.ok || (code && code !== 200)) throw new UpstreamError('aliyun-green', res.status, String(j.Code ?? j.code ?? res.status), j.Message ?? j.message ?? '内容安全调用失败');
    return verdictFromRisk(j.Data ?? j.data, 'aliyun');
  }
}

export function verdictFromRisk(data: any, provider: string): Verdict {
  const risk = String(data?.RiskLevel ?? data?.riskLevel ?? data?.Result?.[0]?.RiskLevel ?? data?.result?.[0]?.riskLevel ?? '').toLowerCase();
  const label = String(data?.Result?.[0]?.Label ?? data?.result?.[0]?.label ?? risk);
  if (risk === 'none' || risk === 'low' || risk === 'pass') return { pass: true, suggest: 'pass', provider, label };
  if (risk === 'medium' || risk === 'review') return { pass: false, suggest: 'review', provider, label };
  if (risk === 'high' || risk === 'block') return { pass: false, suggest: 'block', provider, label };
  throw new UpstreamError(provider, 200, 'UNKNOWN_RISK', `无法识别的 RiskLevel：${risk || '(空)'}`);
}

function defaultClock() {
  return { timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), nonce: crypto.randomUUID() };
}
