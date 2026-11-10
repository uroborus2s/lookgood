import { z } from 'zod';

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, '颜色必须是 #RRGGBB');
const colored = z.object({ name: z.string().min(1), hex, why: z.string().min(1) });

export const LookSpec = z.object({
  occasion: z.string().min(1),
  diagnosis: z.object({
    body_type: z.string(),
    undertone: z.enum(['warm', 'cool', 'neutral']),
    season: z.enum(['spring', 'summer', 'autumn', 'winter']),
    contrast: z.enum(['low', 'medium', 'high']),
    face_shape: z.string(),
    reasons: z.array(z.string()).min(1),
  }),
  outfit: z.object({
    items: z.array(z.object({ category: z.enum(['top', 'bottom', 'dress', 'outer', 'shoes', 'bag', 'jewelry']), name: z.string(), color_hex: hex, why: z.string() })).min(1),
    why: z.string(),
  }),
  lip: z.object({
    primary: colored.extend({ finish: z.enum(['matte', 'velvet', 'glossy', 'sheer']) }),
    alternatives: z.array(colored.extend({ finish: z.enum(['matte', 'velvet', 'glossy', 'sheer']) })).max(3),
    avoid: z.array(colored).max(3),
  }),
  makeup: z.object({
    level: z.enum(['none', 'beginner', 'intermediate']),
    minutes: z.number().int().positive().max(90),
    steps: z.array(z.object({ area: z.string(), how: z.string(), color_hex: hex.optional() })).min(1).max(10),
  }),
  hair: z.object({ style: z.string(), why: z.string(), accessories: z.array(z.object({ name: z.string(), color_hex: hex })).max(4) }),
  ai_generated: z.literal(true),
});
export type LookSpec = z.infer<typeof LookSpec>;

/** 解析模型输出：去掉 ```json 包裹后校验，失败返回可回传给模型的错误描述 */
export function parseLookSpec(raw: string): { ok: true; data: LookSpec } | { ok: false; error: string } {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  let obj: unknown;
  try { obj = JSON.parse(s); } catch { return { ok: false, error: '不是合法 JSON' }; }
  const r = LookSpec.safeParse(obj);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
