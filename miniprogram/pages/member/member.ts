import { consentFace, createPayOrder, getMember, mockConfirmPay, withLoading, type MemberView } from '../../utils/api';

Page({
  data: {
    loading: true,
    error: '',
    buying: '',
    active: false,
    levelTitle: '免费',
    expireText: '',
    used: 0,
    limit: 0,
    remaining: 0,
    memberQuota: 0,
    plans: [] as MemberView['plans'],
  },
  onShow() { this.load(); },
  async load() {
    this.setData({ loading: !this.data.plans.length, error: '' });
    try {
      const m = await getMember();
      this.setData({
        loading: false,
        active: m.active,
        levelTitle: m.levelTitle,
        expireText: m.expireAt ? formatDate(m.expireAt) : '',
        used: m.quota.used,
        limit: m.quota.limit,
        remaining: m.quota.remaining,
        memberQuota: m.memberDailyQuota,
        plans: m.plans,
      });
    } catch (e: any) {
      this.setData({ loading: false, error: e?.message || '会员信息加载失败' });
    }
  },
  async buy(e: any) {
    const sku = e.currentTarget.dataset.sku as string;
    if (!sku || this.data.buying) return;
    this.setData({ buying: sku });
    try {
      const order = await withLoading('下单中', () => createPayOrder(sku));
      if (!order) return;
      if (order.mock || !order.pay) {
        const done = await withLoading('开通中', () => mockConfirmPay(order.outTradeNo));
        if (done) { wx.showToast({ title: '已开通' }); await this.load(); }
        return;
      }
      await wx.requestPayment({
        timeStamp: order.pay.timeStamp,
        nonceStr: order.pay.nonceStr,
        package: order.pay.package,
        signType: 'RSA',
        paySign: order.pay.paySign,
      });
      wx.showToast({ title: '支付成功' });
      await this.load();
    } catch (err: any) {
      const msg = String(err?.errMsg || err?.message || '');
      if (!msg.includes('cancel')) wx.showToast({ title: msg || '支付未完成', icon: 'none' });
    } finally { this.setData({ buying: '' }); }
  },
  async revoke() {
    const g = getApp().globalData;
    if (!g.sessionId) { wx.showToast({ title: '暂无授权记录', icon: 'none' }); return; }
    const r = await withLoading('撤回中', () => consentFace(g.sessionId, false));
    if (r) { g.bodyUrl = g.faceUrl = g.tryonUrl = undefined; wx.showToast({ title: '已撤回授权', icon: 'none' }); }
  },
});

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
