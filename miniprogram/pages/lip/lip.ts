import { addFavorite, renderAndWait, withLoading } from '../../utils/api';
Page({
  data: { img: '', colors: [] as any[], avoid: [] as any[], current: '', status: '' },
  onLoad() { const s = getApp().globalData.lookSpec; if (!s) return; this.setData({ colors: [s.lip.primary, ...s.lip.alternatives], avoid: s.lip.avoid }); this.render(s.lip.primary.hex); },
  pick(e: any) { if (!this.data.status) this.render(e.currentTarget.dataset.hex); },
  async render(hex: string) {
    const faceUrl = getApp().globalData.faceUrl;
    if (!faceUrl) { wx.showToast({ title: '请先上传素颜自拍', icon: 'none' }); return; }
    this.setData({ current: hex, status: '上色中…' });
    try { const t = await renderAndWait('/render/lip', { faceUrl, hex }); this.setData({ img: t.resultUrl }); }
    catch (e: any) { wx.showToast({ title: e.message, icon: 'none' }); }
    finally { this.setData({ status: '' }); }
  },
  async fav() {
    if (!this.data.img) return;
    const saved = await withLoading('收藏中', () => addFavorite({ kind: 'lip', title: '唇色试色', coverUrl: this.data.img, payload: { hex: this.data.current } }));
    if (saved) wx.showToast({ title: '已放进收藏' });
  },
});
