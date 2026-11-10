import { addFavorite, renderAndWait, withLoading } from '../../utils/api';
Page({
  data: { spec: null as any, img: '', status: '' },
  onLoad() { this.setData({ spec: getApp().globalData.lookSpec }); },
  async preview() {
    const g = getApp().globalData; const h = this.data.spec?.hair;
    if (!g.faceUrl || !h) { wx.showToast({ title: '请先上传自拍', icon: 'none' }); return; }
    this.setData({ status: '排队中…' });
    try {
      const t = await renderAndWait('/render/hair', { baseUrl: g.faceUrl, instruction: `${h.style}，发饰：${(h.accessories ?? []).map((a: any) => a.name).join('、') || '无'}` }, (s, sec) => this.setData({ status: s === 'PENDING' ? '排队中…' : `发型生成中 ${sec}s` }));
      this.setData({ img: t.resultUrl });
    } catch (e: any) { wx.showToast({ title: e.message, icon: 'none' }); }
    finally { this.setData({ status: '' }); }
  },
  async fav() {
    if (!this.data.img) return;
    const saved = await withLoading('收藏中', () => addFavorite({ kind: 'hair', title: this.data.spec?.hair?.style || '发型', coverUrl: this.data.img }));
    if (saved) wx.showToast({ title: '已放进收藏' });
  },
});
