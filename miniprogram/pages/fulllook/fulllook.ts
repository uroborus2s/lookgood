import { addFavorite, renderAndWait, withLoading } from '../../utils/api';
Page({
  data: { img: '', status: '', error: '' },
  async onLoad() {
    const g = getApp().globalData; const s = g.lookSpec;
    const base = g.tryonUrl || g.bodyUrl;
    if (!base) { this.setData({ error: '请先完成试穿或上传全身照' }); return; }
    this.setData({ status: '排队中…' });
    try {
      const t = await renderAndWait('/render/fulllook', { baseUrl: base, instruction: `保持人物与服装不变；唇色改为 ${s?.lip.primary.hex}（${s?.lip.primary.name}）；发型改为 ${s?.hair.style}；妆容：${(s?.makeup.steps ?? []).map((x: any) => x.area + x.how).join('，')}` }, (st, sec) => this.setData({ status: st === 'PENDING' ? '排队中…' : `正在合成整体造型 ${sec}s` }));
      this.setData({ img: t.resultUrl, status: '' });
    } catch (e: any) { this.setData({ status: '', error: e.message }); }
  },
  async fav() {
    if (!this.data.img) return;
    const saved = await withLoading('收藏中', () => addFavorite({ kind: 'fulllook', title: '整体造型', coverUrl: this.data.img }));
    if (saved) wx.showToast({ title: '已放进收藏' });
  },
  onShareAppMessage() { return { title: '我的 AI 造型方案（AI 生成）', imageUrl: this.data.img }; },
});
