/**
 * 内容安全与 AI 生成标识钩子。
 * - ContentSafety：用户文本、上传图、生成图都要过审；
 * - provider 由 CONTENT_SAFETY 选择：mock | wechat | aliyun。
 * - PROVIDER_MODE=mock 时固定走 MockSafety，不发起任何外部请求。
 * - AiLabeler：显式「AI 生成」+ 隐式元数据。归档实现见 storage/archive.ts。
 */
import type { Config } from '../config.js';
import { defaultFetch, type Fetch } from '../http.js';
import { AliyunSafety } from './aliyun.js';
import type { Verdict } from './verdict.js';
import { WechatSafety } from './wechat.js';

export type { Verdict } from './verdict.js';
export { mapSuggest } from './verdict.js';

export interface ContentSafety {
  checkText(text: string, openid?: string): Promise<Verdict>;
  checkImage(url: string, openid?: string): Promise<Verdict>;
  handleCallback?(query: Record<string, string | undefined>, rawBody: string): Promise<{ echo?: string; traceId?: string; verdict?: Verdict }>;
}

export type AiLabel = { displayUrl: string; explicit: string; implicit: Record<string, string> };
export interface AiLabeler { label(resultUrl: string, meta: { taskId: string; provider: string; userId: string }): Promise<AiLabel> }

const BLOCK_WORDS = ['裸体', '色情', '赌博', '毒品'];

export class MockSafety implements ContentSafety {
  async checkText(text: string): Promise<Verdict> {
    const hit = BLOCK_WORDS.find(w => text.includes(w));
    return hit ? { pass: false, suggest: 'block', label: hit, provider: 'mock' } : { pass: true, suggest: 'pass', provider: 'mock' };
  }
  async checkImage(url: string): Promise<Verdict> {
    return url.includes('unsafe') ? { pass: false, suggest: 'block', label: 'mock-unsafe', provider: 'mock' } : { pass: true, suggest: 'pass', provider: 'mock' };
  }
}

/** 只有 live 才按 provider 接外部审核；mock 模式一律本地词表 */
export function createSafety(cfg: Config, f: Fetch = defaultFetch): ContentSafety {
  if (cfg.mode !== 'live' || cfg.safety.provider === 'mock') return new MockSafety();
  if (cfg.safety.provider === 'wechat') {
    return new WechatSafety({ appid: cfg.wx.appid, secret: cfg.wx.secret }, { scene: cfg.safety.scene, token: cfg.safety.token, encodingAesKey: cfg.safety.encodingAesKey }, f);
  }
  if (cfg.safety.provider === 'aliyun') return new AliyunSafety(cfg.safety.aliyun, f);
  throw new Error(`未知内容安全提供方：${(cfg.safety as { provider?: string }).provider}`);
}

/** 不落文件的标识，单测与未接归档时使用。线上默认走 ArchivingAiLabeler */
export class BasicAiLabeler implements AiLabeler {
  async label(resultUrl: string, meta: { taskId: string; provider: string; userId: string }): Promise<AiLabel> {
    return {
      displayUrl: resultUrl,
      explicit: 'AI 生成',
      implicit: { AIGC: 'true', ContentProducer: '一身好看', ProduceID: meta.taskId, Model: meta.provider, GeneratedAt: new Date().toISOString() },
    };
  }
}
