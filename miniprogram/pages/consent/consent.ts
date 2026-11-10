import { consentFace, withLoading } from '../../utils/api';
Page({
  data: { ok: false },
  onCheck(e: any) { this.setData({ ok: e.detail.value.length === 2 }); },
  async agree() {
    const sid = getApp().globalData.sessionId;
    const r = await withLoading('提交中', () => consentFace(sid, true));
    if (r) wx.redirectTo({ url: '/pages/photo/photo' });
  },
  skip() { wx.navigateBack(); },
});
