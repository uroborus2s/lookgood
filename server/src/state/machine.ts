/** 对话状态机：与原型流程一致 */
export const STATES = ['GREETING', 'OCCASION', 'STYLE', 'MAKEUP_HAIR_HABIT', 'CONSENT', 'PHOTO', 'ANALYZING', 'DIAGNOSIS', 'COLOR_FACE', 'PLANS', 'TRYON', 'LIP', 'MAKEUP', 'HAIR', 'FULLLOOK', 'DONE'] as const;
export type State = (typeof STATES)[number];
export type Slots = { occasion?: string; industry?: string; budget?: string; style?: string[]; makeup_level?: string; hair_length?: string; face_consent?: boolean; photo_ids?: string[] };

type Rule = { next: (s: Slots) => State; need?: (keyof Slots)[]; quick?: string[]; ask?: string };
export const RULES: Record<State, Rule> = {
  GREETING: { next: () => 'OCCASION', ask: '你好，我是你的形象顾问小好 👋', quick: ['开始'] },
  OCCASION: { need: ['occasion'], next: () => 'STYLE', ask: '这次想为什么场合打扮？', quick: ['面试', '约会', '婚礼', '日常通勤'] },
  STYLE: { need: ['style'], next: () => 'MAKEUP_HAIR_HABIT', ask: '平时喜欢什么风格？', quick: ['简约干净', '温柔知性', '韩系', '日系'] },
  MAKEUP_HAIR_HABIT: { need: ['makeup_level'], next: s => (s.face_consent ? 'PHOTO' : 'CONSENT'), ask: '平时化妆吗？头发多长？', quick: ['新手 · 中长发', '会画 · 长发', '几乎不化 · 短发'] },
  CONSENT: { need: ['face_consent'], next: () => 'PHOTO', ask: '接下来需要全身照和素颜自拍，请先阅读并确认人脸信息授权。', quick: ['去授权'] },
  PHOTO: { need: ['photo_ids'], next: () => 'ANALYZING', ask: '请上传一张全身照和一张自然光素颜自拍。' },
  ANALYZING: { next: () => 'DIAGNOSIS' },
  DIAGNOSIS: { next: () => 'COLOR_FACE' },
  COLOR_FACE: { next: () => 'PLANS' },
  PLANS: { next: () => 'TRYON' },
  TRYON: { next: () => 'LIP' },
  LIP: { next: () => 'MAKEUP' },
  MAKEUP: { next: () => 'HAIR' },
  HAIR: { next: () => 'FULLLOOK' },
  FULLLOOK: { next: () => 'DONE' },
  DONE: { next: () => 'DONE' },
};

/** 槽位齐了才前进；用户撤回人脸授权时任何状态都回到 CONSENT */
export function advance(state: State, slots: Slots): State {
  if (slots.face_consent === false && STATES.indexOf(state) > STATES.indexOf('MAKEUP_HAIR_HABIT')) return 'CONSENT';
  const rule = RULES[state];
  const missing = (rule.need ?? []).filter(k => { const v = slots[k]; return v === undefined || (Array.isArray(v) && v.length === 0); });
  return missing.length ? state : rule.next(slots);
}

/** 多槽位一次填满时连续前进，直到停在需要用户输入的状态（最多到 PHOTO） */
export function advanceAll(state: State, slots: Slots): State {
  let cur = state;
  for (let i = 0; i < 8; i++) {
    const nxt = advance(cur, slots);
    if (nxt === cur) break;
    cur = nxt;
    if (STATES.indexOf(cur) >= STATES.indexOf('PHOTO')) break;
  }
  return cur;
}
