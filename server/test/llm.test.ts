import { describe, it, expect } from 'vitest';
import { completeWithFallback, MockProvider, type LLMProvider } from '../src/llm/client.js';

const failing = (status: number, calls: { n: number }): LLMProvider => ({ name: `fail${status}`, async complete() { calls.n++; throw Object.assign(new Error('x'), { status }); } });

describe('路由与降级', () => {
  it('429 重试后切到备用', async () => {
    const c = { n: 0 }; const logs: any[] = [];
    const r = await completeWithFallback([failing(429, c), new MockProvider(() => 'ok')], [], {}, { retries: 2, baseDelayMs: 1, log: l => logs.push(l) });
    expect(r.text).toBe('ok'); expect(c.n).toBe(3); expect(logs.at(-1).fallback).toBe(true);
  });
  it('400 不重试直接切换', async () => {
    const c = { n: 0 };
    await completeWithFallback([failing(400, c), new MockProvider(() => 'ok')], [], {}, { baseDelayMs: 1 });
    expect(c.n).toBe(1);
  });
  it('全部失败抛错', async () => {
    await expect(completeWithFallback([failing(500, { n: 0 })], [], {}, { retries: 0 })).rejects.toThrow();
  });
});
