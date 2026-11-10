import type { Config } from './config.js';
import { HttpError } from './http.js';
import type { Repo } from './repo/types.js';

const SH = 8 * 3600_000;

/** 北京时间自然日的起点（UTC+8，无夏令时） */
export function shanghaiDayStart(now = new Date()) {
  const shifted = new Date(now.getTime() + SH);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SH);
}

export function nextShanghaiDayStart(now = new Date()) {
  return new Date(shanghaiDayStart(now).getTime() + 86400_000);
}

export function isActiveMember(expireAt: Date | null | undefined, now = new Date()) {
  return !!(expireAt && expireAt.getTime() > now.getTime());
}

export async function quotaSnapshot(repo: Repo, cfg: Pick<Config, 'freeDailyQuota' | 'memberDailyQuota'>, userId: string, now = new Date()) {
  const member = await repo.getMember(userId);
  const active = isActiveMember(member.expireAt, now);
  const limit = active ? cfg.memberDailyQuota : cfg.freeDailyQuota;
  const used = await repo.countRenderTasksSince(userId, shanghaiDayStart(now));
  return {
    active,
    level: active ? member.level : 'free',
    expireAt: member.expireAt,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: nextShanghaiDayStart(now).toISOString(),
  };
}

export async function assertDailyQuota(repo: Repo, cfg: Pick<Config, 'freeDailyQuota' | 'memberDailyQuota'>, userId: string, now = new Date()) {
  const q = await quotaSnapshot(repo, cfg, userId, now);
  if (q.used >= q.limit) {
    const hint = q.active ? '明天再来' : '开通会员可提高额度';
    throw new HttpError(429, `今日生成次数已用完（${q.used}/${q.limit}），${hint}`);
  }
  return q;
}
