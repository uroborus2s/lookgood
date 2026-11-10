import type { TaskStatus } from '../repo/types.js';
/** 统一的图像任务接口：同步厂商 submit 直接给 resultUrl；异步厂商给 providerTaskId，再 poll */
export type SubmitResult = { providerTaskId?: string; resultUrl?: string };
export type PollResult = { status: TaskStatus; resultUrl?: string; error?: string };
export interface ImageJobProvider<I> {
  name: string;
  submit(input: I): Promise<SubmitResult>;
  poll?(providerTaskId: string): Promise<PollResult>;
}
export type TryOnInput = { personUrl: string; garmentUrls: string[]; prompt?: string };
export type EditInput = { baseUrl: string; instruction: string; refUrls?: string[] };
export type LipInput = { faceUrl: string; hex: string; alpha?: number };

/** mock：第 1 次 poll 返回 RUNNING，第 2 次 SUCCEEDED，用来演示前端轮询 */
export function mockProvider<I>(name: string, img: string): ImageJobProvider<I> {
  const polls = new Map<string, number>();
  return {
    name,
    async submit() { const id = `mock-${name}-${crypto.randomUUID()}`; polls.set(id, 0); return { providerTaskId: id }; },
    async poll(id) { const n = (polls.get(id) ?? 0) + 1; polls.set(id, n); return n < 2 ? { status: 'RUNNING' } : { status: 'SUCCEEDED', resultUrl: `https://example.invalid/mock/${img}?t=${id}` }; },
  };
}
