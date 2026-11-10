import { defaultFetch, UpstreamError, type Fetch } from '../http.js';
import type { EditInput, ImageJobProvider, PollResult, TryOnInput } from './types.js';

export type DashCfg = { apiKey: string; baseURL: string; tryonModel: string; lookModel: string };
const trim = (u: string) => u.replace(/\/+$/, '');

async function call(f: Fetch, url: string, init: RequestInit) {
  const res = await f(url, init);
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || (j.code && !j.output)) throw new UpstreamError('dashscope', res.status, j.code ?? `HTTP_${res.status}`, j.message ?? 'request failed');
  return j;
}

/** 防御式取图：兼容 output.choices[].message.content[].image 与 output.results[].url 两种形态 */
export function pickImage(output: any): string | undefined {
  const c = output?.choices?.[0]?.message?.content;
  if (Array.isArray(c)) { const hit = c.find((x: any) => x?.image); if (hit) return hit.image; }
  return output?.results?.find((r: any) => r?.url)?.url;
}

/**
 * 试衣 / 换装：qwen-image-3.0 图像编辑（同步接口）
 * 文档：https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference
 * POST {base}/api/v1/services/aigc/multimodal-generation/generation
 * body: { model, input:{ messages:[{ role:'user', content:[{image},{image},{text}] }] }, parameters:{ size, prompt_extend, watermark, negative_prompt } }
 * 编辑模式支持 1–3 张输入图：人像 + 最多 2 件单品
 */
export function qwenTryOn(cfg: DashCfg, f: Fetch = defaultFetch): ImageJobProvider<TryOnInput> {
  return {
    name: cfg.tryonModel,
    async submit({ personUrl, garmentUrls, prompt }) {
      const imgs = [personUrl, ...garmentUrls].slice(0, 3);
      const text = prompt ?? `让图1中的人物穿上${garmentUrls.length > 1 ? '图2和图3' : '图2'}中的服装，保持人物的脸、发型、体型、姿势和背景不变，服装版型与颜色忠实于参考图，真实摄影质感。`;
      const j = await call(f, `${trim(cfg.baseURL)}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.tryonModel,
          input: { messages: [{ role: 'user', content: [...imgs.map(image => ({ image })), { text }] }] },
          parameters: { prompt_extend: false, watermark: false, negative_prompt: '改变人脸, 畸形手指, 低清晰度' },
        }),
      });
      const url = pickImage(j.output);
      if (!url) throw new UpstreamError('dashscope', 200, 'NO_IMAGE', '响应中没有图片');
      return { resultUrl: url };
    },
  };
}

/**
 * 整体造型 / 发型：wan2.7-image（异步提交 + 轮询）
 * 文档：https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference
 * 提交：POST {base}/api/v1/services/aigc/image-generation/generation  header X-DashScope-Async: enable
 *       body: { model, input:{ messages:[{ role:'user', content:[{image}..., {text}] }] }, parameters:{ size:'2K', n:1, watermark:false } }
 *       返回 { output:{ task_status:'PENDING', task_id } }
 * 轮询：GET {base}/api/v1/tasks/{task_id} 直到 task_status 为 SUCCEEDED / FAILED；task_id 与结果 URL 24 小时有效
 */
export function wanEdit(cfg: DashCfg, f: Fetch = defaultFetch): ImageJobProvider<EditInput> {
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };
  return {
    name: cfg.lookModel,
    async submit({ baseUrl, instruction, refUrls = [] }) {
      const j = await call(f, `${trim(cfg.baseURL)}/api/v1/services/aigc/image-generation/generation`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
        body: JSON.stringify({
          model: cfg.lookModel,
          input: { messages: [{ role: 'user', content: [{ image: baseUrl }, ...refUrls.slice(0, 8).map(image => ({ image })), { text: instruction }] }] },
          parameters: { size: '2K', n: 1, watermark: false },
        }),
      });
      const id = j.output?.task_id ?? j.task_id;
      if (!id) throw new UpstreamError('dashscope', 200, 'NO_TASK_ID', '提交成功但没有 task_id');
      return { providerTaskId: id };
    },
    async poll(id): Promise<PollResult> {
      const j = await call(f, `${trim(cfg.baseURL)}/api/v1/tasks/${encodeURIComponent(id)}`, { method: 'GET', headers: auth });
      const st = j.output?.task_status ?? j.status;
      if (st === 'SUCCEEDED') { const url = pickImage(j.output); return url ? { status: 'SUCCEEDED', resultUrl: url } : { status: 'FAILED', error: 'NO_IMAGE' }; }
      if (st === 'FAILED' || st === 'CANCELED' || st === 'UNKNOWN') return { status: 'FAILED', error: `${j.output?.code ?? st}: ${j.output?.message ?? ''}`.trim() };
      return { status: 'RUNNING' };
    },
  };
}
