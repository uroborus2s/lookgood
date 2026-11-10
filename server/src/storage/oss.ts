import { createHmac } from 'node:crypto';
import type { Config } from '../config.js';
import type { ImageRow, Repo } from '../repo/types.js';

export type ImageKind = 'body' | 'face' | 'garment' | 'tryon' | 'lip' | 'fulllook';
export const RAW_KINDS: ImageKind[] = ['body', 'face'];

export type UploadTicket = { imageId: string; key: string; host: string; formData: Record<string, string>; expireAt: string | null; publicUrl: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * OSS PostObject 签名 V4（客户端直传，服务端只签策略，不经手图片）
 * 文档：https://help.aliyun.com/zh/oss/developer-reference/signature-version-4-recommend
 * policy 条件：bucket、x-oss-signature-version/credential/date、content-length-range、key 前缀、content-type 白名单
 * StringToSign = base64(policy)；SigningKey = HMAC 链 "aliyun_v4"+secret → 日期 → region → "oss" → "aliyun_v4_request"
 */
export function signPostPolicy(o: { accessKeyId: string; accessKeySecret: string; region: string; bucket: string; key: string; maxBytes: number; now: Date; expiresSec?: number; contentTypes?: string[] }) {
  const date = ymd(o.now);
  const credential = `${o.accessKeyId}/${date}/${o.region}/oss/aliyun_v4_request`;
  const xOssDate = amzDate(o.now);
  const policy = {
    expiration: new Date(o.now.getTime() + (o.expiresSec ?? 600) * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    conditions: [
      { bucket: o.bucket },
      { 'x-oss-signature-version': 'OSS4-HMAC-SHA256' },
      { 'x-oss-credential': credential },
      { 'x-oss-date': xOssDate },
      ['content-length-range', 1, o.maxBytes],
      ['eq', '$key', o.key],
      ['in', '$content-type', o.contentTypes ?? ['image/jpeg', 'image/png', 'image/webp']],
    ],
  };
  const policyB64 = Buffer.from(JSON.stringify(policy)).toString('base64');
  const h = (k: string | Buffer, m: string) => createHmac('sha256', k).update(m).digest();
  const signingKey = h(h(h(h('aliyun_v4' + o.accessKeySecret, date), o.region), 'oss'), 'aliyun_v4_request');
  const signature = createHmac('sha256', signingKey).update(policyB64).digest('hex');
  return { policy, formData: { key: o.key, policy: policyB64, 'x-oss-signature-version': 'OSS4-HMAC-SHA256', 'x-oss-credential': credential, 'x-oss-date': xOssDate, 'x-oss-signature': signature, success_action_status: '200' } };
}

/** 原图（body/face）放 raw/ 前缀，24h 后删除；生成图与单品图放 gen/ */
export function createUploadTicket(cfg: Config, userId: string, kind: ImageKind, now = new Date()): UploadTicket & { row: ImageRow } {
  const id = crypto.randomUUID();
  const raw = RAW_KINDS.includes(kind);
  const key = `${raw ? 'raw' : 'gen'}/${userId}/${id}.jpg`;
  const expireAt = raw ? new Date(now.getTime() + cfg.imageTtlHours * 3600_000) : null;
  const row: ImageRow = { id, userId, kind, ossKey: key, expireAt, aiLabel: false };
  if (!cfg.oss.live) {
    return { imageId: id, key, host: 'https://example.invalid/mock-oss', formData: { key, 'Content-Type': 'image/jpeg' }, expireAt: expireAt?.toISOString() ?? null, publicUrl: `https://example.invalid/mock-oss/${key}`, row };
  }
  const host = `https://${cfg.oss.bucket}.oss-${cfg.oss.region}.aliyuncs.com`;
  const { formData } = signPostPolicy({ ...cfg.oss, key, now });
  return { imageId: id, key, host, formData: { ...formData, 'Content-Type': 'image/jpeg' }, expireAt: expireAt?.toISOString() ?? null, publicUrl: `${host}/${key}`, row };
}

/** 桶生命周期规则（兜底，控制台或 PutBucketLifecycle 配置一次即可）：raw/ 前缀 1 天后删除 */
export const LIFECYCLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration><Rule><ID>raw-24h</ID><Prefix>raw/</Prefix><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>`;

export type ObjectDeleter = (keys: string[]) => Promise<void>;

/** live：官方 SDK ali-oss 的 deleteMulti（https://help.aliyun.com/zh/oss/developer-reference/delete-objects-5） */
export async function ossDeleter(cfg: Config['oss']): Promise<ObjectDeleter> {
  const { default: OSS } = await import('ali-oss');
  const client = new OSS({ region: `oss-${cfg.region}`, bucket: cfg.bucket, accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, authorizationV4: true } as any);
  return async keys => { for (let i = 0; i < keys.length; i += 1000) await client.deleteMulti(keys.slice(i, i + 1000), { quiet: true }); };
}

/** 定时清理：DB 标记删除 + 删除 OSS 对象；返回删除数 */
export async function purgeExpired(repo: Repo, del: ObjectDeleter, now = new Date()) {
  const rows = await repo.takeExpiredImages(now);
  if (rows.length) await del(rows.map(r => r.ossKey));
  return rows.length;
}
