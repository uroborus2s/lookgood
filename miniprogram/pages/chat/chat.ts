import { sendMessage } from '../../utils/api';
const ROUTE: Record<string, string> = { CONSENT: '/pages/consent/consent', PHOTO: '/pages/photo/photo', PLANS: '/pages/plans/plans' };
Page({
  data: { msgs: [{ role: 'bot', text: '你好，我是你的形象顾问小好 👋 这次想为什么场合打扮？' }] as { role: string; text: string }[], quick: ['面试', '约会', '婚礼', '日常通勤'], input: '', typing: false },
  onLoad(q: any) { if (q.first) this.say(decodeURIComponent(q.first)); },
  onInput(e: any) { this.setData({ input: e.detail.value }); },
  tapQuick(e: any) { this.say(e.currentTarget.dataset.t); },
  send() { if (this.data.input.trim()) this.say(this.data.input.trim()); },
  async say(text: string) {
    if (this.data.typing) return;
    const app = getApp();
    this.setData({ msgs: [...this.data.msgs, { role: 'user', text }], input: '', quick: [], typing: true });
    try {
      const r = await sendMessage(text, app.globalData.sessionId);
      app.globalData.sessionId = r.sessionId;
      this.setData({ msgs: [...this.data.msgs, { role: 'bot', text: r.reply }], quick: r.quickReplies });
      if (ROUTE[r.state]) wx.navigateTo({ url: ROUTE[r.state] });
    } catch { this.setData({ msgs: [...this.data.msgs, { role: 'bot', text: '网络开小差了，再发一次试试～' }] }); }
    finally { this.setData({ typing: false }); }
  },
});
