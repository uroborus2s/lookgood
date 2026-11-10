import { ensureLogin } from './utils/api';
App<{ globalData: { userId?: string; sessionId?: string; lookSpec?: any; bodyUrl?: string; faceUrl?: string; tryonUrl?: string } }>({
  globalData: {},
  onLaunch() { ensureLogin().catch(() => wx.showToast({ title: '登录失败，请检查网络', icon: 'none' })); },
});
