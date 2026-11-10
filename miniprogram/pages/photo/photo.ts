import { uploadImage } from '../../utils/api';
Page({
  data: { body: '', face: '', uploading: '' },
  async pick(e: any) {
    const k = e.currentTarget.dataset.k as 'body' | 'face';
    const r = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] });
    const path = r.tempFiles[0].tempFilePath;
    const app = getApp();
    this.setData({ uploading: k });
    try {
      const t = await uploadImage(k, path, app.globalData.sessionId);
      app.globalData[k === 'body' ? 'bodyUrl' : 'faceUrl'] = t.publicUrl;
      this.setData({ [k]: path });
    } catch (err: any) {
      wx.showToast({ title: err?.status === 403 ? '请先完成人脸授权' : '上传失败，请重试', icon: 'none' });
    } finally { this.setData({ uploading: '' }); }
  },
  next() { const g = getApp().globalData; wx.redirectTo({ url: `/pages/analysis/analysis?body=${encodeURIComponent(g.bodyUrl)}&face=${encodeURIComponent(g.faceUrl)}` }); },
});
