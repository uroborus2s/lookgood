// 开发时指向本地 mock 服务；上线改为已备案的 HTTPS 域名，并在小程序后台配置 request / uploadFile 合法域名（含 OSS 桶域名）
export const BASE_URL = 'http://127.0.0.1:3000';

let token = wx.getStorageSync('token') as string || '';
let loginPromise: Promise<string> | null = null;

/** 单例登录：wx.login → /auth/login → JWT 存 storage */
export function ensureLogin(force = false): Promise<string> {
  if (token && !force) return Promise.resolve(token);
  if (!loginPromise) {
    loginPromise = (async () => {
      const { code } = await wx.login();
      const r = await rawRequest<{ userId: string; token: string }>('/auth/login', { code }, 'POST', false);
      token = r.token; wx.setStorageSync('token', token); getApp().globalData.userId = r.userId;
      return token;
    })().finally(() => { loginPromise = null; });
  }
  return loginPromise;
}

function rawRequest<T>(path: string, data: any, method: 'GET' | 'POST' | 'DELETE', auth: boolean): Promise<T> {
  return new Promise((resolve, reject) => wx.request({
    url: BASE_URL + path, method, timeout: 60000,
    ...(data !== undefined ? { data } : {}),
    header: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    success: r => {
      if (r.statusCode < 300) resolve(r.data as T);
      else {
        const body = (r.data ?? {}) as any;
        reject(Object.assign(new Error(body.error || `请求失败 ${r.statusCode}`), { status: r.statusCode, ...body }));
      }
    },
    fail: e => reject(new Error(e.errMsg || '网络异常')),
  }));
}

/** 带登录态的请求；401 时自动重新登录并重试一次 */
export async function request<T = any>(path: string, data?: any, method: 'GET' | 'POST' | 'DELETE' = 'POST'): Promise<T> {
  await ensureLogin();
  try { return await rawRequest<T>(path, data, method, true); }
  catch (e: any) { if (e?.status !== 401) throw e; await ensureLogin(true); return rawRequest<T>(path, data, method, true); }
}

export type ChatResp = { sessionId: string; state: string; reply: string; quickReplies: string[]; blocked?: boolean };
export type Ticket = { imageId: string; key: string; host: string; formData: Record<string, string>; expireAt: string | null; publicUrl: string };
export type Task = { taskId: string; status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; resultUrl?: string; error?: string; aiLabel?: Record<string, string> };

export const sendMessage = (text: string, sessionId?: string) => request<ChatResp>('/chat/message', { text, sessionId });
export const consentFace = (sessionId: string, agree: boolean) => request<{ state: string }>('/consent/face', { sessionId, agree });
export const analyze = (bodyUrl: string, faceUrl: string) => request('/analysis', { bodyUrl, faceUrl });
export const generateLook = (sessionId: string) => request('/look/generate', { sessionId });

/** 压缩 → 申请 OSS POST 凭证 → wx.uploadFile 直传（服务端不经手原图） */
export async function uploadImage(kind: 'body' | 'face' | 'garment', filePath: string, sessionId?: string): Promise<Ticket> {
  const small = await new Promise<string>(res => wx.compressImage({ src: filePath, quality: 80, compressedWidth: 1600, success: r => res(r.tempFilePath), fail: () => res(filePath) } as any));
  const t = await request<Ticket>('/photo/upload-ticket', { kind, sessionId });
  if (t.host.includes('example.invalid')) return t; // mock：不真正上传
  await new Promise<void>((resolve, reject) => wx.uploadFile({
    url: t.host, filePath: small, name: 'file', formData: t.formData, // file 字段必须在表单最后，wx.uploadFile 会自动放到末尾
    success: r => (r.statusCode === 200 || r.statusCode === 204 ? resolve() : reject(new Error(`OSS ${r.statusCode}: ${r.data}`))),
    fail: reject,
  }));
  return t;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** 提交渲染任务并轮询结果：间隔 1.5s 递增到 4s，最多 3 分钟 */
export async function renderAndWait(path: '/render/tryon' | '/render/lip' | '/render/hair' | '/render/fulllook', body: any, onProgress?: (s: Task['status'], sec: number) => void): Promise<Task> {
  let t = await request<Task>(path, body);
  const start = Date.now();
  for (let i = 0; t.status === 'PENDING' || t.status === 'RUNNING'; i++) {
    const sec = Math.round((Date.now() - start) / 1000);
    if (sec > 180) throw new Error('生成超时，请稍后重试');
    onProgress?.(t.status, sec);
    await sleep(Math.min(1500 + i * 500, 4000));
    t = await request<Task>(`/render/tasks/${t.taskId}`, undefined, 'GET');
  }
  if (t.status === 'FAILED') throw new Error(t.error || '生成失败');
  return t;
}

export type FavoriteItem = { id: string; kind: string; title: string; coverUrl?: string | null; payload: any; createdAt: string };
export type FavoritePage = { items: FavoriteItem[]; nextCursor: string | null };
export const listFavorites = (cursor?: string) => request<FavoritePage>(`/favorites?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, 'GET');
export const addFavorite = (body: { kind: 'look' | 'tryon' | 'lip' | 'hair' | 'fulllook' | 'makeup'; title: string; coverUrl?: string; payload?: any }) => request<FavoriteItem>('/favorites', body);
export const removeFavorite = (id: string) => request<{ ok: boolean }>(`/favorites/${id}`, undefined, 'DELETE');

export type MemberPlan = { sku: string; title: string; amountFen: number; amountYuan: string; days: number };
export type MemberView = {
  active: boolean; level: string; levelTitle: string; expireAt: string | null;
  quota: { limit: number; used: number; remaining: number; resetsAt: string };
  freeDailyQuota: number; memberDailyQuota: number; plans: MemberPlan[];
};
export type PayParams = { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string };
export type PayOrder = { outTradeNo: string; sku: string; amountFen: number; amountYuan: string; status: string; mock: boolean; pay: PayParams | null };
export const getMember = () => request<MemberView>('/member', undefined, 'GET');
export const createPayOrder = (sku: string) => request<PayOrder>('/pay/orders', { sku });
export const mockConfirmPay = (outTradeNo: string) => request<{ status: string; member: MemberView }>(`/pay/orders/${outTradeNo}/mock-confirm`);

const KIND_LABEL: Record<string, string> = { look: '方案', tryon: '试穿', lip: '唇色', hair: '发型', fulllook: '整体造型', makeup: '妆容' };
export const favoriteKindLabel = (kind: string) => KIND_LABEL[kind] || '收藏';

/** 统一的 loading / 错误提示 */
export async function withLoading<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  wx.showLoading({ title, mask: true });
  try { return await fn(); }
  catch (e: any) { wx.showToast({ title: e?.error || e?.message || '出错了，请重试', icon: 'none' }); return undefined; }
  finally { wx.hideLoading(); }
}
