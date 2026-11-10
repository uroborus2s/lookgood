import { recordModelUsage } from '../cost.js';
import type { Config } from '../config.js';
import { mockProvider, type EditInput, type ImageJobProvider, type LipInput, type TryOnInput } from '../adapters/types.js';
import { qwenTryOn, wanEdit } from '../adapters/dashscope.js';
import { tencentLip } from '../adapters/tencent.js';
import { defaultFetch, type Fetch } from '../http.js';
import type { RenderTask, Repo } from '../repo/types.js';
import type { AiLabeler, ContentSafety, Verdict } from '../safety/index.js';

export type Providers = { tryon: ImageJobProvider<TryOnInput>; fulllook: ImageJobProvider<EditInput>; hair: ImageJobProvider<EditInput>; lip: ImageJobProvider<LipInput> };

/** 有 key 才走真实厂商，缺 key 的那一项保持 mock */
export function buildProviders(cfg: Config, f: Fetch = defaultFetch): Providers {
  const d = cfg.dashscope, t = cfg.tencent;
  return {
    tryon: d.live ? qwenTryOn(d, f) : mockProvider('tryon', 'tryon.jpg'),
    fulllook: d.live ? wanEdit(d, f) : mockProvider('fulllook', 'fulllook.jpg'),
    hair: d.live ? wanEdit(d, f) : mockProvider('hair', 'hair.jpg'),
    lip: t.live ? tencentLip(t, f) : mockProvider('lip', 'lip.jpg'),
  };
}

/**
 * 统一异步任务：POST 立即返回 taskId；同步厂商在后台执行，异步厂商在 GET 时惰性轮询上游。
 * 无常驻 worker，多实例部署也安全（状态全在 repo）。
 * 一次任务只记一笔模型成本（refId = taskId）。图片先过审，微信异步审核通过后再归档到 gen/。
 */
export class RenderService {
  private inflight = new Map<string, Promise<void>>();
  constructor(private repo: Repo, private p: Providers, private safety: ContentSafety, private labeler: AiLabeler, private prices: Record<string, number> = {}) {}

  async start<K extends keyof Providers>(kind: K, userId: string, input: Parameters<Providers[K]['submit']>[0]): Promise<RenderTask> {
    const provider = this.p[kind] as ImageJobProvider<any>;
    const task: RenderTask = { id: crypto.randomUUID(), userId, kind, provider: provider.name, status: 'PENDING' };
    await this.repo.createTask(task);
    const job = (async () => {
      try {
        await this.repo.updateTask(task.id, { status: 'RUNNING' });
        const r = await provider.submit(input);
        await this.charge(userId, provider.name, task.id);
        if (r.resultUrl) await this.finish(task.id, userId, provider.name, r.resultUrl);
        else await this.repo.updateTask(task.id, { providerTaskId: r.providerTaskId });
      } catch (e: any) {
        await this.charge(userId, provider.name, task.id);
        await this.repo.updateTask(task.id, { status: 'FAILED', error: String(e?.message ?? e).slice(0, 300) });
      }
    })();
    this.inflight.set(task.id, job.finally(() => this.inflight.delete(task.id)));
    return task;
  }

  /** 测试/冒烟用：等待后台提交完成 */
  async settle(id: string) { await this.inflight.get(id); }

  async get(id: string, userId: string): Promise<RenderTask | null> {
    const t = await this.repo.getTask(id);
    if (!t || t.userId !== userId) return null;
    if (t.status !== 'RUNNING' || !t.providerTaskId || this.inflight.has(id)) return t;
    const provider = this.p[t.kind as keyof Providers] as ImageJobProvider<any>;
    if (!provider.poll) return t;
    try {
      const r = await provider.poll(t.providerTaskId);
      if (r.status === 'SUCCEEDED' && r.resultUrl) await this.finish(id, userId, provider.name, r.resultUrl);
      else if (r.status === 'FAILED') await this.repo.updateTask(id, { status: 'FAILED', error: r.error });
    } catch { /* 轮询瞬时失败不改状态，下次再查 */ }
    return this.repo.getTask(id);
  }

  /** 微信 mediaCheckAsync 回调：通过则归档，不通过则失败。记录还在时失败可重试归档 */
  async applyModeration(traceId: string, verdict: Verdict) {
    const pending = await this.repo.getModeration(traceId);
    if (!pending) return { found: false as const };
    if (!verdict.pass) {
      await this.repo.deleteModeration(traceId);
      await this.repo.updateTask(pending.taskId, { status: 'FAILED', error: `内容安全未通过:${verdict.label ?? verdict.suggest}` });
      await this.repo.audit(pending.userId, 'image_blocked', { id: pending.taskId, verdict });
      return { found: true as const, pass: false as const };
    }
    await this.finish(pending.taskId, pending.userId, pending.provider, pending.sourceUrl, true);
    await this.repo.deleteModeration(traceId);
    return { found: true as const, pass: true as const };
  }

  private async charge(userId: string, model: string, taskId: string) {
    const ok = await recordModelUsage(this.repo, this.prices, { userId, kind: 'render', model, refId: taskId });
    if (!ok) return;
    const priced = Object.prototype.hasOwnProperty.call(this.prices, model);
    if (priced) await this.repo.updateTask(taskId, { costCny: this.prices[model] });
  }

  private async finish(id: string, userId: string, provider: string, url: string, skipSafety = false) {
    if (!skipSafety) {
      const openid = (await this.repo.getOpenid(userId)) ?? undefined;
      const v = await this.safety.checkImage(url, openid);
      if (v.pending && v.traceId) {
        await this.repo.saveModeration({ traceId: v.traceId, userId, taskId: id, sourceUrl: url, provider, model: provider });
        await this.repo.updateTask(id, { status: 'RUNNING', aiLabel: { moderation: 'pending', traceId: v.traceId } });
        return;
      }
      if (!v.pass) {
        await this.repo.updateTask(id, { status: 'FAILED', error: `内容安全未通过:${v.label ?? ''}` });
        await this.repo.audit(userId, 'image_blocked', { id, v });
        return;
      }
    }
    const label = await this.labeler.label(url, { taskId: id, provider, userId });
    await this.repo.updateTask(id, { status: 'SUCCEEDED', resultUrl: label.displayUrl, aiLabel: { explicit: label.explicit, ...label.implicit } });
  }
}
