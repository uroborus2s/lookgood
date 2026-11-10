import { describe, it, expect } from 'vitest';
import { advance, advanceAll } from '../src/state/machine.js';
import { mergeSlots, ruleExtract, llmExtractor } from '../src/state/slots.js';
import { MockProvider } from '../src/llm/client.js';

describe('状态机', () => {
  it('缺槽位不前进', () => expect(advance('OCCASION', {})).toBe('OCCASION'));
  it('已授权跳过授权页', () => expect(advance('MAKEUP_HAIR_HABIT', { makeup_level: '新手', face_consent: true })).toBe('PHOTO'));
  it('撤回授权回到 CONSENT', () => expect(advance('TRYON', { face_consent: false })).toBe('CONSENT'));
  it('一次填满多个槽位连续前进', () => expect(advanceAll('GREETING', { occasion: '面试', style: ['简约'], makeup_level: '新手' })).toBe('CONSENT'));
});

describe('抽槽', () => {
  it('打招呼不填任何槽位', () => {
    const ex = ruleExtract('你好！'); expect(ex.intent).toBe('greeting');
    const s = mergeSlots({}, ex); expect(s).toEqual({});
    expect(advanceAll('GREETING', s)).toBe('OCCASION');
  });
  it('跑题不填槽位', () => { const ex = ruleExtract('今天天气不错'); expect(ex.intent).toBe('off_topic'); expect(mergeSlots({ occasion: '面试' }, ex)).toEqual({ occasion: '面试' }); });
  it('一句话多槽位', () => {
    const ex = ruleExtract('下周去面试，想要简约干净一点的韩系，我化妆是新手，中长发，预算500元');
    expect(ex).toMatchObject({ intent: 'answer', occasion: '面试', style: ['简约干净', '韩系'], makeup_level: '新手', hair_length: '中长发', budget: '500元' });
    expect(advanceAll('GREETING', mergeSlots({}, ex))).toBe('CONSENT');
  });
  it('LLM 抽槽 JSON 经 zod 校验', async () => {
    const p = new MockProvider(() => JSON.stringify({ intent: 'answer', occasion: '婚礼', hair_length: '长发' }));
    const { ex, source } = await llmExtractor([p])('参加闺蜜婚礼，长发', 'OCCASION', {});
    expect(source).toBe('mock'); expect(ex).toEqual({ intent: 'answer', occasion: '婚礼', hair_length: '长发' });
  });
  it('LLM 输出非法时退回规则抽取', async () => {
    const p = new MockProvider(() => JSON.stringify({ intent: 'answer', makeup_level: '超级大师', extra: 1 }));
    const { ex, source } = await llmExtractor([p])('约会穿什么', 'OCCASION', {});
    expect(source).toBe('rule-fallback'); expect(ex.occasion).toBe('约会');
  });
});
