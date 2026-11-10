import { favoriteKindLabel, listFavorites, removeFavorite, type FavoriteItem } from '../../utils/api';

type Row = FavoriteItem & { kindLabel: string; time: string };

function formatTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

Page({
  data: { list: [] as Row[], loading: true, loadingMore: false, error: '', nextCursor: '' as string },
  onShow() { this.reload(); },
  async onPullDownRefresh() { await this.reload(); wx.stopPullDownRefresh(); },
  onReachBottom() { if (this.data.nextCursor && !this.data.loadingMore) this.loadMore(); },
  async reload() {
    this.setData({ loading: true, error: '', nextCursor: '' });
    try {
      const page = await listFavorites();
      this.setData({ list: page.items.map(toRow), nextCursor: page.nextCursor || '', loading: false, error: '' });
    } catch (e: any) {
      this.setData({ loading: false, error: e?.message || '收藏加载失败' });
    }
  },
  async loadMore() {
    if (!this.data.nextCursor) return;
    this.setData({ loadingMore: true });
    try {
      const page = await listFavorites(this.data.nextCursor);
      this.setData({ list: this.data.list.concat(page.items.map(toRow)), nextCursor: page.nextCursor || '', loadingMore: false });
    } catch (e: any) {
      this.setData({ loadingMore: false });
      wx.showToast({ title: e?.message || '加载失败', icon: 'none' });
    }
  },
  remove(e: any) {
    const id = e.currentTarget.dataset.id as string;
    wx.showModal({
      title: '删除收藏', content: '从收藏里拿掉这套造型？', confirmColor: '#D9735F',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await removeFavorite(id);
          this.setData({ list: this.data.list.filter(x => x.id !== id) });
        } catch (err: any) { wx.showToast({ title: err?.message || '删除失败', icon: 'none' }); }
      },
    });
  },
});

function toRow(item: FavoriteItem): Row {
  return { ...item, kindLabel: favoriteKindLabel(item.kind), time: formatTime(item.createdAt) };
}
