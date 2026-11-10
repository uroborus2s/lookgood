import type { Repo, UsageInput } from './repo/types.js';

export function unitPrice(prices: Record<string, number>, model: string): { unitPriceCny: number | null; priced: boolean } {
  if (Object.prototype.hasOwnProperty.call(prices, model)) return { unitPriceCny: prices[model]!, priced: true };
  return { unitPriceCny: null, priced: false };
}

/** 记一次模型调用。单价来自配置；没配的模型 priced=false，成本留空，不填 0 冒充免费 */
export async function recordModelUsage(repo: Repo, prices: Record<string, number>, e: { userId: string | null; kind: string; model: string; refId?: string }) {
  const p = unitPrice(prices, e.model);
  const row: UsageInput = { userId: e.userId, kind: e.kind, model: e.model, unitPriceCny: p.unitPriceCny, costCny: p.unitPriceCny, priced: p.priced, refId: e.refId };
  return repo.addUsage(row);
}
