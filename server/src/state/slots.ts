import { z } from 'zod';
import { completeWithFallback, type LLMProvider } from '../llm/client.js';
import type { Slots, State } from './machine.js';

/** LLM 抽槽输出契约：只抽用户明确说出的信息，没提到就不填 */
export const SlotExtraction = z.object({
  intent: z.enum(['answer', 'greeting', 'off_topic', 'question']),
  occasion: z.string().min(1).max(20).optional(),
  industry: z.string().max(20).optional(),
  budget: z.string().max(20).optional(),
  style: z.array(z.string().min(1).max(12)).max(5).optional(),
  makeup_level: z.enum(['几乎不化', '新手', '会画', '熟练']).optional(),
  hair_length: z.enum(['短发', '中长发', '长发']).optional(),
}).strict();
export type SlotExtraction = z.infer<typeof SlotExtraction>;

export const SLOT_PROMPT = `你是信息抽取器。从用户这句话里抽取穿搭咨询需要的信息，只输出 JSON，字段：
intent: answer|greeting|off_topic|question（打招呼=greeting；与穿搭妆发无关=off_topic；在提问=question；提供了信息=answer）
occasion: 场合，如 面试/约会/婚礼/日常通勤/旅行/年会
industry, budget: 用户提到才填
style: 风格数组，如 ["简约干净","韩系"]
makeup_level: 几乎不化|新手|会画|熟练
hair_length: 短发|中长发|长发
规则：用户没明确说出的字段一律省略，不要猜；一句话可以同时填多个字段。`;

const OCC = ['面试', '约会', '婚礼', '日常通勤', '通勤', '上班', '旅行', '年会', '聚会', '毕业', '答辩', '见家长', '相亲', '演出', '拍照', '派对'];
const STYLE = ['简约干净', '简约', '温柔知性', '温柔', '知性', '韩系', '日系', '法式', '甜美', '酷', '中性', '复古', '运动', '通勤风', '优雅', '清冷', '学院'];
const MAKEUP: [RegExp, SlotExtraction['makeup_level']][] = [[/几乎不化|不化妆|素颜/, '几乎不化'], [/新手|不太会|刚学/, '新手'], [/熟练|很会|精通/, '熟练'], [/会画|会化/, '会画']];
const HAIR: [RegExp, SlotExtraction['hair_length']][] = [[/中长发|齐肩|锁骨/, '中长发'], [/短发|短头发/, '短发'], [/长发|长头发/, '长发']];
const GREET = /^(你好|您好|嗨|hi|hello|哈喽|在吗|早上好|晚上好|开始|hey)[!！。.~～,，\s]*$/i;

/** 确定性抽槽（mock 模式 & LLM 全挂时兜底）。词典匹配，不靠"第几句话" */
export function ruleExtract(text: string): SlotExtraction {
  const t = text.trim();
  if (GREET.test(t)) return { intent: 'greeting' };
  const out: SlotExtraction = { intent: 'answer' };
  const occ = OCC.find(k => t.includes(k)); if (occ) out.occasion = occ === '通勤' || occ === '上班' ? '日常通勤' : occ;
  const styles: string[] = [];
  for (const k of STYLE) if (t.includes(k) && !styles.some(s => s.includes(k))) styles.push(k);
  if (styles.length) out.style = styles;
  for (const [re, v] of MAKEUP) if (re.test(t)) { out.makeup_level = v; break; }
  for (const [re, v] of HAIR) if (re.test(t)) { out.hair_length = v; break; }
  const m = t.match(/预算\s*(\d+\s*[元块kK]?)|(\d+)\s*[元块]以内/); if (m) out.budget = (m[1] ?? m[2] + '元').replace(/\s/g, '');
  if (Object.keys(out).length === 1) out.intent = /[?？吗怎么什么]/.test(t) ? 'question' : 'off_topic';
  return out;
}

/** 合并：只覆盖本句抽到的字段；greeting/off_topic 不改任何槽位 */
export function mergeSlots(slots: Slots, ex: SlotExtraction): Slots {
  if (ex.intent === 'greeting' || ex.intent === 'off_topic') return slots;
  const { intent: _i, ...fields } = ex;
  const s: Slots = { ...slots };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (s as any)[k] = v;
  return s;
}

export type Extractor = (text: string, state: State, slots: Slots) => Promise<{ ex: SlotExtraction; source: string }>;

/** LLM 抽槽：JSON + zod 校验，失败重试 1 次，再失败退回规则抽取 */
export function llmExtractor(providers: LLMProvider[]): Extractor {
  return async (text, state, slots) => {
    const msgs = [
      { role: 'system' as const, content: SLOT_PROMPT },
      { role: 'system' as const, content: `当前在问的步骤：${state}；已知：${JSON.stringify(slots)}` },
      { role: 'user' as const, content: text },
    ];
    for (let a = 0; a < 2; a++) {
      try {
        const { text: out, provider } = await completeWithFallback(providers, msgs, { json: true, temperature: 0 }, { retries: 1 });
        const r = SlotExtraction.safeParse(JSON.parse(out));
        if (r.success) return { ex: r.data, source: provider };
      } catch { /* 继续重试 / 兜底 */ }
    }
    return { ex: ruleExtract(text), source: 'rule-fallback' };
  };
}
export const ruleExtractor: Extractor = async text => ({ ex: ruleExtract(text), source: 'rule' });
