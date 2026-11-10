/** 所有外部 HTTP 调用都经由可注入的 fetch，单测里替换成假 fetch，绝不触网 */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export const defaultFetch: Fetch = (u, i) => fetch(u, i);

export class UpstreamError extends Error {
  constructor(public provider: string, public status: number, public code: string, message: string) { super(`[${provider}] ${code}: ${message}`); }
}

/** 业务错误。statusCode < 500 时由 app 错误处理原样返回给客户端 */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = 'HttpError'; }
}
