import { analyze, generateLook } from '../../utils/api';
Page({
  data: { loading: true, d: {} as any, error: '' },
  async onLoad(q: any) {
    try {
      const d = await analyze(decodeURIComponent(q.body), decodeURIComponent(q.face));
      this.setData({ d, loading: false });
      const app = getApp();
      if (app.globalData.sessionId) app.globalData.lookSpec = await generateLook(app.globalData.sessionId);
    } catch (e: any) { this.setData({ loading: false, error: e?.error || '分析失败，请重试' }); }
  },
  next() { wx.redirectTo({ url: '/pages/plans/plans' }); },
});
