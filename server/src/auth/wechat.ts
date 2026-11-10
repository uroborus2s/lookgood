import type { Config } from '../config.js';
import { defaultFetch, UpstreamError, type Fetch } from '../http.js';

/**
 * 小程序登录 code2Session
 * 文档：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html
 * GET https://api.weixin.qq.com/sns/jscode2session?appid=&secret=&js_code=&grant_type=authorization_code
 * 返回 { openid, session_key, unionid?, errcode?, errmsg? }；session_key 只留在服务端，绝不下发
 */
export async function code2Session(cfg: Config['wx'], code: string, f: Fetch = defaultFetch): Promise<{ openid: string; unionid?: string }> {
  if (!cfg.live) return { openid: `mock_${code}` };
  const q = new URLSearchParams({ appid: cfg.appid, secret: cfg.secret, js_code: code, grant_type: 'authorization_code' });
  const res = await f(`https://api.weixin.qq.com/sns/jscode2session?${q}`);
  const j: any = await res.json();
  if (j.errcode || !j.openid) throw new UpstreamError('wechat', res.status, String(j.errcode ?? 'NO_OPENID'), j.errmsg ?? 'code2Session 失败');
  return { openid: j.openid, unionid: j.unionid };
}
