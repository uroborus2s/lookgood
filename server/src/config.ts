import 'dotenv/config';

export type ModelRoute = { baseURL: string; apiKey: string; model: string };
const env = (k: string, d = '') => process.env[k] ?? d;
const r = (p: string, defModel: string): ModelRoute => ({ baseURL: env(`${p}_BASE_URL`), apiKey: env(`${p}_API_KEY`), model: env(`${p}_MODEL`, defModel) });
const pem = (k: string) => env(k).replace(/\\n/g, '\n').trim();

export type MemberPlan = { sku: string; title: string; amountFen: number; days: number };

/** 默认档位只是占位价格，上线前用 MEMBER_PLANS 改成合同价 */
export const DEFAULT_MEMBER_PLANS: MemberPlan[] = [
  { sku: 'month', title: '月卡', amountFen: 1290, days: 30 },
  { sku: 'quarter', title: '季卡', amountFen: 2900, days: 90 },
  { sku: 'year', title: '年卡', amountFen: 19800, days: 365 },
];

export function parseMemberPlans(raw: string): MemberPlan[] {
  const s = raw.trim();
  if (!s) return DEFAULT_MEMBER_PLANS.map(p => ({ ...p }));
  let data: unknown;
  try { data = JSON.parse(s); } catch { throw new Error('MEMBER_PLANS 不是合法 JSON'); }
  if (!Array.isArray(data) || data.length === 0) throw new Error('MEMBER_PLANS 必须是非空数组');
  return data.map((x: any, i) => {
    const sku = String(x?.sku ?? '').trim();
    const title = String(x?.title ?? sku).trim();
    const amountFen = Number(x?.amountFen);
    const days = Number(x?.days);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(sku)) throw new Error(`MEMBER_PLANS[${i}].sku 非法`);
    if (!title || title.length > 40) throw new Error(`MEMBER_PLANS[${i}].title 非法`);
    if (!Number.isInteger(amountFen) || amountFen <= 0 || amountFen > 10_000_000) throw new Error(`MEMBER_PLANS[${i}].amountFen 必须是正整数（分）`);
    if (!Number.isInteger(days) || days <= 0 || days > 3650) throw new Error(`MEMBER_PLANS[${i}].days 非法`);
    return { sku, title, amountFen, days };
  });
}

/** `model=yuan,model=yuan`。未出现的模型记为未定价，不臆造单价 */
export function parseModelPrices(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  const s = raw.trim();
  if (!s) return out;
  for (const part of s.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`MODEL_UNIT_PRICE_CNY 项格式应为 model=price：${item}`);
    const k = item.slice(0, eq).trim();
    const n = Number(item.slice(eq + 1).trim());
    if (!k || !Number.isFinite(n) || n < 0) throw new Error(`模型 ${k || item} 的单价非法`);
    out[k] = n;
  }
  return out;
}

export type SafetyProvider = 'mock' | 'wechat' | 'aliyun';

export function parseSafetyProvider(raw: string): SafetyProvider {
  const v = (raw || 'mock').trim().toLowerCase();
  if (v === 'live') throw new Error('CONTENT_SAFETY=live 已废弃，请改为 wechat 或 aliyun');
  if (v === 'mock' || v === 'wechat' || v === 'aliyun') return v;
  throw new Error(`未知 CONTENT_SAFETY：${raw}`);
}

function intEnv(k: string, d: number) {
  const n = Number(env(k, String(d)));
  if (!Number.isInteger(n) || n < 0) throw new Error(`${k} 必须是非负整数`);
  return n;
}

/** 分 → 展示用人民币，去掉无意义的尾零：1290 → "12.9"，2900 → "29" */
export function formatYuan(fen: number) {
  const neg = fen < 0;
  const n = Math.abs(fen);
  const yuan = Math.floor(n / 100);
  const cent = n % 100;
  const body = cent === 0 ? String(yuan) : `${yuan}.${String(cent).padStart(2, '0')}`.replace(/0$/, '');
  return (neg ? '-' : '') + body;
}

/** live 只有在 PROVIDER_MODE=live 且对应 key 存在时才启用；缺 key 的那一项自动退回 mock */
export function loadConfig() {
  const mode = env('PROVIDER_MODE', 'mock') as 'mock' | 'live';
  if (mode !== 'mock' && mode !== 'live') throw new Error(`未知 PROVIDER_MODE：${mode}`);
  const live = mode === 'live';
  const safetyProvider = parseSafetyProvider(env('CONTENT_SAFETY', 'mock'));
  const wxAppid = env('WX_APPID');
  return {
    mode,
    nodeEnv: env('NODE_ENV', 'development'),
    port: Number(env('PORT', '3000')),
    repo: env('REPO', 'memory') as 'memory' | 'pg',
    databaseUrl: env('DATABASE_URL'),
    jwtSecret: env('JWT_SECRET', 'dev-only-secret-change-me'),
    jwtTtlSec: Number(env('JWT_TTL_SEC', String(7 * 86400))),
    imageTtlHours: Number(env('IMAGE_TTL_HOURS', '24')),
    llm: { chat: r('LLM_CHAT', 'deepseek-flash'), fallback: r('LLM_FALLBACK', 'qwen-plus'), spec: r('LLM_SPEC', 'qwen3.7-plus'), vision: r('LLM_VISION', 'qwen3-vl-plus'), slots: r('LLM_SLOTS', 'qwen-plus') },
    llmLive: live && !!env('LLM_CHAT_API_KEY'),
    dashscope: { live: live && !!env('DASHSCOPE_API_KEY'), apiKey: env('DASHSCOPE_API_KEY'), baseURL: env('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com'), tryonModel: env('TRYON_MODEL', 'qwen-image-3.0'), lookModel: env('FULLLOOK_MODEL', 'wan2.7-image') },
    tencent: { live: live && !!env('TENCENTCLOUD_SECRET_ID'), secretId: env('TENCENTCLOUD_SECRET_ID'), secretKey: env('TENCENTCLOUD_SECRET_KEY'), region: env('TENCENTCLOUD_REGION', 'ap-guangzhou') },
    oss: { live: live && !!env('OSS_ACCESS_KEY_ID'), region: env('OSS_REGION', 'cn-beijing'), bucket: env('OSS_BUCKET'), accessKeyId: env('OSS_ACCESS_KEY_ID'), accessKeySecret: env('OSS_ACCESS_KEY_SECRET'), maxBytes: Number(env('OSS_MAX_BYTES', String(10 * 1024 * 1024))) },
    wx: { live: live && !!wxAppid, appid: wxAppid, secret: env('WX_SECRET') },
    safety: {
      provider: safetyProvider,
      scene: intEnv('WX_SAFETY_SCENE', 2),
      token: env('WX_SAFETY_TOKEN'),
      encodingAesKey: env('WX_SAFETY_ENCODING_AES_KEY'),
      aliyun: {
        accessKeyId: env('ALIYUN_GREEN_ACCESS_KEY_ID'),
        accessKeySecret: env('ALIYUN_GREEN_ACCESS_KEY_SECRET'),
        region: env('ALIYUN_GREEN_REGION', 'cn-shanghai'),
        endpoint: env('ALIYUN_GREEN_ENDPOINT'),
        textService: env('ALIYUN_GREEN_TEXT_SERVICE', 'comment_detection_pro'),
        imageService: env('ALIYUN_GREEN_IMAGE_SERVICE', 'baselineCheck'),
      },
    },
    wxPay: {
      mchId: env('WX_PAY_MCH_ID'),
      apiV3Key: env('WX_PAY_API_V3_KEY'),
      privateKey: pem('WX_PAY_PRIVATE_KEY'),
      certSerial: env('WX_PAY_CERT_SERIAL'),
      platformCert: pem('WX_PAY_PLATFORM_CERT'),
      platformSerial: env('WX_PAY_PLATFORM_SERIAL'),
      notifyUrl: env('WX_PAY_NOTIFY_URL'),
    },
    plans: parseMemberPlans(env('MEMBER_PLANS')),
    freeDailyQuota: intEnv('FREE_DAILY_QUOTA', 5),
    memberDailyQuota: intEnv('MEMBER_DAILY_QUOTA', 100),
    modelPrices: parseModelPrices(env('MODEL_UNIT_PRICE_CNY')),
    aigc: {
      producer: env('AIGC_CONTENT_PRODUCER', '一身好看'),
      propagator: env('AIGC_CONTENT_PROPAGATOR', '一身好看'),
      reservedSecret: env('AIGC_RESERVED_SECRET'),
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig();
