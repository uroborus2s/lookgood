Page({
  data: { occasions: ['面试', '约会', '婚礼', '日常通勤'] },
  start(e: any) { const o = e.currentTarget.dataset.o; wx.navigateTo({ url: '/pages/chat/chat' + (o ? `?first=${o}` : '') }); },
});
