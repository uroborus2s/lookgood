import { createHmac, timingSafeEqual } from 'node:crypto';
/** 最小 HS256 JWT 实现（RFC 7519），避免额外依赖 */
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export type Claims = { sub: string; openid: string; iat: number; exp: number };

export function signJwt(payload: { sub: string; openid: string }, secret: string, ttlSec: number, now = Math.floor(Date.now() / 1000)) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const s = b64u(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}
export function verifyJwt(token: string, secret: string, now = Math.floor(Date.now() / 1000)): Claims | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const expect = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as Claims;
  return c.exp > now ? c : null;
}
