import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { HttpError, type Fetch } from '../http.js';
import { isActiveMember } from '../quota.js';
import type { Order, Repo } from '../repo/types.js';
import { decryptNotifyResource, jsapiPrepay, queryByOutTradeNo, verifyNotifySignature, type WxPayCfg } from './wechat.js';

export function payCfgOf(cfg: Config): WxPayCfg {
  return { appid: cfg.wx.appid, ...cfg.wxPay };
}

export function payLive(cfg: Config) {
  const p = cfg.wxPay;
  return cfg.mode === 'live' && !!(cfg.wx.appid && p.mchId && p.apiV3Key && p.privateKey && p.certSerial && p.notifyUrl);
}

export function newOutTradeNo(now = Date.now()) {
  return (`YS${now.toString(36)}${randomBytes(6).toString('hex')}`).toUpperCase().slice(0, 32);
}

export async function extendMembership(repo: Repo, userId: string, level: string, days: number, now = new Date()) {
  const cur = await repo.getMember(userId);
  const base = isActiveMember(cur.expireAt, now) && cur.expireAt ? cur.expireAt : now;
  const expireAt = new Date(base.getTime() + days * 86400_000);
  await repo.setMember(userId, level, expireAt);
  await repo.audit(userId, 'member_extend', { level, days, expireAt: expireAt.toISOString() });
  return { level, expireAt };
}

/** 仅第一次把 CREATED 改成 PAID 时延长会员，微信重复回调不会叠加时长 */
export async function applyPaidOrder(repo: Repo, outTradeNo: string, wxTransactionId: string, paidAt: Date) {
  const marked = await repo.markOrderPaid(outTradeNo, wxTransactionId, paidAt);
  if (!marked) return null;
  if (marked.newlyPaid) await extendMembership(repo, marked.order.userId, marked.order.sku, marked.order.planDays, paidAt);
  return marked;
}

export async function createMembershipOrder(cfg: Config, repo: Repo, userId: string, sku: string, fetchImpl: Fetch) {
  const plan = cfg.plans.find(p => p.sku === sku);
  if (!plan) throw new HttpError(400, '没有这个会员档位');
  const openid = await repo.getOpenid(userId);
  if (!openid) throw new HttpError(401, '用户不存在');
  const outTradeNo = newOutTradeNo();
  const order = await repo.createOrder({ userId, sku: plan.sku, amountFen: plan.amountFen, planDays: plan.days, status: 'CREATED', outTradeNo });
  if (!payLive(cfg)) {
    return { order, mock: true as const, pay: null };
  }
  const pre = await jsapiPrepay(payCfgOf(cfg), { description: `一身好看${plan.title}`, outTradeNo, amountFen: plan.amountFen, openid }, fetchImpl);
  await repo.setPrepayId(order.outTradeNo, pre.prepayId);
  return { order: { ...order, prepayId: pre.prepayId }, mock: false as const, pay: pre.pay };
}

export async function confirmMockPaid(cfg: Config, repo: Repo, userId: string, outTradeNo: string, now = new Date()) {
  if (cfg.mode !== 'mock') throw new HttpError(404, '没有这个接口');
  const order = await repo.getOrderByOutTradeNo(outTradeNo);
  if (!order || order.userId !== userId) throw new HttpError(404, '订单不存在');
  const marked = await applyPaidOrder(repo, outTradeNo, `mock_${outTradeNo}`, now);
  return marked?.order ?? order;
}

export async function handlePayNotify(cfg: Config, repo: Repo, headers: Record<string, string | undefined>, rawBody: string) {
  const pay = payCfgOf(cfg);
  verifyNotifySignature(pay, headers, rawBody);
  const body = JSON.parse(rawBody);
  if (body.event_type && body.event_type !== 'TRANSACTION.SUCCESS') return { ignored: true as const };
  const resource = decryptNotifyResource(pay.apiV3Key, body.resource);
  if (resource.trade_state !== 'SUCCESS') return { ignored: true as const };
  const order = await repo.getOrderByOutTradeNo(String(resource.out_trade_no ?? ''));
  if (!order) throw new HttpError(404, '订单不存在');
  if (Number(resource.amount?.total) !== order.amountFen) throw new HttpError(400, '支付金额与订单不一致');
  if (pay.mchId && resource.mchid && resource.mchid !== pay.mchId) throw new HttpError(400, '商户号不匹配');
  if (pay.appid && resource.appid && resource.appid !== pay.appid) throw new HttpError(400, 'AppID 不匹配');
  const openid = await repo.getOpenid(order.userId);
  if (openid && resource.payer?.openid && resource.payer.openid !== openid) throw new HttpError(400, '付款人与订单用户不一致');
  const paidAt = resource.success_time ? new Date(resource.success_time) : new Date();
  const marked = await applyPaidOrder(repo, order.outTradeNo, String(resource.transaction_id ?? ''), paidAt);
  await repo.audit(order.userId, 'pay_notify', { outTradeNo: order.outTradeNo, transactionId: resource.transaction_id });
  return { ignored: false as const, order: marked?.order, newlyPaid: marked?.newlyPaid ?? false };
}

export async function refreshOrder(cfg: Config, repo: Repo, order: Order, fetchImpl: Fetch) {
  if (order.status === 'PAID' || !payLive(cfg)) return order;
  try {
    const remote = await queryByOutTradeNo(payCfgOf(cfg), order.outTradeNo, fetchImpl);
    if (remote.trade_state === 'SUCCESS' && Number(remote.amount?.total) === order.amountFen) {
      const paidAt = remote.success_time ? new Date(remote.success_time) : new Date();
      const marked = await applyPaidOrder(repo, order.outTradeNo, String(remote.transaction_id ?? ''), paidAt);
      return marked?.order ?? order;
    }
  } catch {
    return order;
  }
  return order;
}
