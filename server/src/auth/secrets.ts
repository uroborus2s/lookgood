/**
 * 生产环境拒绝弱 JWT_SECRET。
 * 要求：UTF-8 至少 32 字节、同时含字母和数字、字符种类与香农熵足够，且不含常见占位词。
 * 生成：openssl rand -base64 48
 */
const PLACEHOLDERS = ['change-me', 'dev-only', 'replace-me', 'placeholder', 'your-secret', 'jwt-secret', 'not-for-production', 'example'];

export function shannonEntropy(s: string) {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function assertProductionConfig(cfg: { jwtSecret: string }, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const s = cfg.jwtSecret ?? '';
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes < 32) throw new Error(`JWT_SECRET 在生产环境必须是至少 32 字节的随机值，当前 ${bytes} 字节，拒绝启动`);
  const lower = s.toLowerCase();
  if (PLACEHOLDERS.some(p => lower.includes(p))) throw new Error('JWT_SECRET 包含常见占位词，不像随机值，拒绝启动');
  if (new Set(s).size < 16 || shannonEntropy(s) < 3.5 || !/[a-z]/i.test(s) || !/[0-9]/.test(s)) {
    throw new Error('JWT_SECRET 熵过低或缺少字母与数字，不像随机值，拒绝启动。请使用 openssl rand -base64 48 生成');
  }
}
