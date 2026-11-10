import { addFavorite, renderAndWait, uploadImage, withLoading } from '../../utils/api';
Page({
  data: { img: '', status: '', error: '' },
  onLoad() { this.run(); },
  async run(garmentUrls?: string[]) {
    const g = getApp().globalData;
    const garments = garmentUrls ?? (g.lookSpec?.outfit?.items ?? []).map((i: any) => i.image_url).filter(Boolean);
    if (!g.bodyUrl || !garments.length) { this.setData({ status: '', error: '请先上传全身照，并选择或上传 1–2 件单品图' }); return; }
    this.setData({ img: '', error: '', status: '排队中…' });
    try {
      const t = await renderAndWait('/render/tryon', { personUrl: g.bodyUrl, garmentUrls: garments.slice(0, 2) }, (s, sec) => this.setData({ status: s === 'PENDING' ? '排队中…' : `试穿生成中 ${sec}s` }));
      g.tryonUrl = t.resultUrl; this.setData({ img: t.resultUrl, status: '' });
    } catch (e: any) { this.setData({ status: '', error: e.message }); }
  },
  async addGarment() {
    const r = await wx.chooseMedia({ count: 2, mediaType: ['image'] });
    const urls: string[] = [];
    for (const f of r.tempFiles) urls.push((await uploadImage('garment', f.tempFilePath)).publicUrl);
    this.run(urls);
  },
  async fav() {
    if (!this.data.img) return;
    const r = await withLoading('收藏中', () => addFavorite({ kind: 'tryon', title: '试穿造型', coverUrl: this.data.img }));
    if (r) wx.showToast({ title: '已放进收藏' });
  },
});
