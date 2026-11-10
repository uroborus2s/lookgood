import type { Config } from '../config.js';
import type { Fetch } from '../http.js';
import type { AiLabel, AiLabeler } from '../safety/index.js';
import { buildAigcFields, embedAigcMetadata, MINIMAL_JPEG, sniffImage, type AigcFields } from './aigcMeta.js';

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<{ key: string; url: string }>;
}

/** 测试与 mock 模式使用。不连接阿里云。 */
export class MemoryObjectStore implements ObjectStore {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(key: string, body: Buffer, contentType: string) {
    if (!key.startsWith('gen/')) throw new Error(`生成图必须写入 gen/，收到 ${key}`);
    this.objects.set(key, { body, contentType });
    return { key, url: `https://example.invalid/mock-oss/${key}` };
  }
  get(key: string) { return this.objects.get(key); }
}

/**
 * live 且配置了 OSS 密钥时才构造 ali-oss 客户端。put 之前不会发请求。
 * 文档：https://help.aliyun.com/zh/oss/developer-reference/putobject
 */
export async function createOssStore(cfg: Config['oss']): Promise<ObjectStore> {
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.accessKeySecret) throw new Error('OSS 未配置：缺少 OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET');
  const { default: OSS } = await import('ali-oss');
  const client = new OSS({ region: `oss-${cfg.region}`, bucket: cfg.bucket, accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, authorizationV4: true } as any);
  const host = `https://${cfg.bucket}.oss-${cfg.region}.aliyuncs.com`;
  return {
    async put(key, body, contentType) {
      if (!key.startsWith('gen/')) throw new Error(`生成图必须写入 gen/，收到 ${key}`);
      await client.put(key, body, { headers: { 'Content-Type': contentType, 'x-oss-meta-aigc-label': '1' } });
      return { key, url: `${host}/${key}` };
    },
  };
}

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' } as const;

/**
 * 下载厂商结果图（mock 模式不下载，用内置 JPEG），写入隐式标识后上传到 gen/{userId}/{taskId}.ext。
 * mock 绝不触网，避免 example.invalid 或厂商 URL 被真实请求。
 */
export class ArchivingAiLabeler implements AiLabeler {
  constructor(private o: { store: ObjectStore; fetch: Fetch; mode: 'mock' | 'live'; aigc: Config['aigc'] }) {}
  async label(resultUrl: string, meta: { taskId: string; provider: string; userId: string }): Promise<AiLabel> {
    const bytes = await this.load(resultUrl);
    const fields = buildAigcFields({ producer: this.o.aigc.producer, propagator: this.o.aigc.propagator, produceId: meta.taskId, secret: this.o.aigc.reservedSecret });
    const kind = sniffImage(bytes);
    const labeled = embedAigcMetadata(bytes, fields);
    const key = `gen/${meta.userId}/${meta.taskId}.${EXT[kind]}`;
    const put = await this.o.store.put(key, labeled, MIME[kind]);
    return { displayUrl: put.url, explicit: 'AI 生成', implicit: fieldsToRecord(fields, key) };
  }
  private async load(url: string): Promise<Buffer> {
    if (this.o.mode !== 'live') return MINIMAL_JPEG;
    const res = await this.o.fetch(url);
    if (!res.ok) throw new Error(`下载生成图失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('生成图为空');
    return buf;
  }
}

function fieldsToRecord(f: AigcFields, ossKey: string): Record<string, string> {
  return { AIGC: 'true', Label: f.Label, ContentProducer: f.ContentProducer, ProduceID: f.ProduceID, ReservedCode1: f.ReservedCode1, ContentPropagator: f.ContentPropagator, PropagateID: f.PropagateID, ReservedCode2: f.ReservedCode2, ossKey };
}
