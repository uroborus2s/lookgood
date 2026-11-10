import { addFavorite, generateLook, withLoading } from '../../utils/api';
Page({
  data: { spec: null as any },
  async onLoad() { const app = getApp(); const spec = await generateLook(app.globalData.sessionId); app.globalData.lookSpec = spec; this.setData({ spec }); },
  go(e: any) { const p = e.currentTarget.dataset.p; wx.navigateTo({ url: `/pages/${p}/${p}` }); },
  async fav() {
    const spec = this.data.spec;
    if (!spec) return;
    const saved = await withLoading('收藏中', () => addFavorite({ kind: 'look', title: `${spec.occasion || '今天'}的造型方案`, payload: spec }));
    if (saved) wx.showToast({ title: '方案已收藏' });
  },
});
