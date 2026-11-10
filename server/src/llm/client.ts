import OpenAI from 'openai';
import { config, type Config, type ModelRoute } from '../config.js';

export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string | any[] };
export type CompleteOpts = { json?: boolean; temperature?: number; timeoutMs?: number };
export type CallLog = { provider: string; model: string; ms: number; ok: boolean; fallback: boolean; tokens?: number };

export interface LLMProvider {
  name: string;
  /** 计费用的模型 id，对应 MODEL_UNIT_PRICE_CNY 的键 */
  model?: string;
  complete(messages: ChatMsg[], opts?: CompleteOpts): Promise<string>;
}

/** 任意 OpenAI 兼容服务：DeepSeek / 百炼 / 火山方舟 / 智谱 都只需换 baseURL + model */
export class OpenAICompatProvider implements LLMProvider {
  private client: OpenAI;
  constructor(private route: ModelRoute) {
    this.client = new OpenAI({ baseURL: route.baseURL, apiKey: route.apiKey, maxRetries: 0 });
  }
  get name() { return `${new URL(this.route.baseURL).host}/${this.route.model}`; }
  get model() { return this.route.model; }
  async complete(messages: ChatMsg[], opts: CompleteOpts = {}) {
    const res = await this.client.chat.completions.create(
      {
        model: this.route.model,
        messages: messages as any,
        temperature: opts.temperature ?? 0.7,
        ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
      },
      { timeout: opts.timeoutMs ?? 30_000 },
    );
    return res.choices[0]?.message?.content ?? '';
  }
}

/** 本地 mock：不联网、不需要 key */
export class MockProvider implements LLMProvider {
  name = 'mock';
  model = 'mock';
  constructor(private reply: (m: ChatMsg[], o: CompleteOpts) => string = defaultMock) {}
  async complete(m: ChatMsg[], o: CompleteOpts = {}) { return this.reply(m, o); }
}

function defaultMock(_m: ChatMsg[], o: CompleteOpts) {
  if (o.json) return JSON.stringify(MOCK_LOOK);
  return '收到～我来帮你一步步配出一身好看的造型。';
}

export const MOCK_LOOK = {
  occasion: '面试',
  diagnosis: { body_type: 'H型', undertone: 'warm', season: 'spring', contrast: 'medium', face_shape: '鹅蛋脸', reasons: ['脸颊偏黄调', '肩宽与胯宽接近'] },
  outfit: { items: [{ category: 'top', name: '米白针织开衫', color_hex: '#F3E3C3', why: '暖白提亮肤色' }, { category: 'bottom', name: '深灰直筒裤', color_hex: '#555555', why: '拉长腿部线条' }], why: '干练又不失温和' },
  lip: { primary: { name: '珊瑚豆沙', hex: '#D9735F', finish: 'velvet', why: '暖调中对比，显精神' }, alternatives: [{ name: '奶茶橘', hex: '#C9805E', finish: 'matte', why: '更低调' }], avoid: [{ name: '冷调莓紫', hex: '#8E3B5C', why: '冷紫让暖皮显黄' }] },
  makeup: { level: 'beginner', minutes: 15, steps: [{ area: '底妆', how: '薄涂暖调粉底液', color_hex: '#F2D2B6' }, { area: '唇', how: '珊瑚豆沙，指腹拍开', color_hex: '#D9735F' }] },
  hair: { style: '低马尾 + 细碎刘海', why: '鹅蛋脸比例均衡，干练不抢镜', accessories: [{ name: '黑色哑光一字夹', color_hex: '#222222' }] },
  ai_generated: true,
};

export type Router = { chat: LLMProvider[]; spec: LLMProvider[]; vision: LLMProvider[] };

export function buildRouter(cfg: Config = config): Router {
  if (!cfg.llmLive) { const m = new MockProvider(); return { chat: [m], spec: [m], vision: [m] }; }
  const p = (r: ModelRoute) => new OpenAICompatProvider(r);
  return {
    chat: [p(cfg.llm.chat), p(cfg.llm.fallback)],
    spec: [p(cfg.llm.spec), p(cfg.llm.chat)],
    vision: [p(cfg.llm.vision)], // TODO: 加 doubao-seed-2.0-lite 作视觉备用
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const retryable = (e: any) => !e?.status || e.status === 429 || e.status >= 500;

/** 按顺序尝试各 provider；每家对 429/5xx/超时 指数退避重试 retries 次 */
export async function completeWithFallback(
  providers: LLMProvider[], messages: ChatMsg[], opts: CompleteOpts = {},
  { retries = 2, baseDelayMs = 300, log = (_: CallLog) => {} } = {},
): Promise<{ text: string; provider: string; model: string }> {
  let lastErr: unknown;
  for (const [i, p] of providers.entries()) {
    for (let a = 0; a <= retries; a++) {
      const t = Date.now();
      try {
        const text = await p.complete(messages, opts);
        log({ provider: p.name, model: p.model ?? p.name, ms: Date.now() - t, ok: true, fallback: i > 0 });
        return { text, provider: p.name, model: p.model ?? p.name };
      } catch (e) {
        lastErr = e;
        log({ provider: p.name, model: p.name, ms: Date.now() - t, ok: false, fallback: i > 0 });
        if (!retryable(e)) break;
        if (a < retries) await sleep(baseDelayMs * 2 ** a);
      }
    }
  }
  throw lastErr ?? new Error('no provider');
}
