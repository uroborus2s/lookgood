import type { Fetch } from '../src/http.js';
import { loadConfig } from '../src/config.js';
export type Call = { url: string; method: string; headers: Record<string, string>; body: any };
/** 假 fetch：按顺序返回预设响应并记录请求，保证单测不触网 */
export function fakeFetch(responses: { status?: number; json: unknown }[]) {
  const calls: Call[] = [];
  const f: Fetch = async (url, init = {}) => {
    const h: Record<string, string> = {}; for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) h[k.toLowerCase()] = v;
    calls.push({ url, method: init.method ?? 'GET', headers: h, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses.shift(); if (!r) throw new Error('unexpected fetch ' + url);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { f, calls };
}
export const mockCfg = () => ({ ...loadConfig(), mode: 'mock' as const, repo: 'memory' as const, llmLive: false, jwtSecret: 'test' });
