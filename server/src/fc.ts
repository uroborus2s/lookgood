import { assertProductionConfig } from './auth/secrets.js';
import { config } from './config.js';

/**
 * 阿里云函数计算 FC 3.0 HTTP 触发器适配。
 * 事件函数不常驻监听端口，把 FC HTTP 事件转成 Fastify inject。
 * 文档：https://help.aliyun.com/zh/functioncompute/fc-3-0/user-guide/http-triggers-1
 * 部署见仓库根目录 s.yaml 与 docs/deploy.zh.md。本文件不会主动连接外部服务。
 */
export type FcHttpEvent = {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | string[] | undefined>;
  queryParameters?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string; path?: string } };
};

type InjectApp = { inject: (opts: { method: string; url: string; headers?: Record<string, string>; payload?: string }) => Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> };

export function parseFcEvent(event: unknown) {
  const raw = typeof event === 'string' ? event : Buffer.isBuffer(event) ? event.toString('utf8') : JSON.stringify(event ?? {});
  const evt = JSON.parse(raw) as FcHttpEvent;
  const method = (evt.requestContext?.http?.method || 'GET').toUpperCase();
  const path = evt.rawPath || evt.requestContext?.http?.path || '/';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(evt.queryParameters ?? {})) if (v != null) q.append(k, v);
  const qs = q.toString();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(evt.headers ?? {})) {
    if (v == null) continue;
    headers[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  let payload: string | undefined;
  if (evt.body != null && evt.body !== '') payload = evt.isBase64Encoded ? Buffer.from(evt.body, 'base64').toString('utf8') : evt.body;
  return { method, url: qs ? `${path}?${qs}` : path, headers, payload };
}

export async function invokeFc(app: InjectApp, event: unknown) {
  const req = parseFcEvent(event);
  const res = await app.inject({ method: req.method, url: req.url, headers: req.headers, payload: req.payload });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (v == null || k === 'content-length' || k === 'transfer-encoding') continue;
    headers[k] = Array.isArray(v) ? v.map(String).join(',') : String(v);
  }
  return { statusCode: res.statusCode, headers, isBase64Encoded: false, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '') };
}

let cached: Promise<InjectApp> | null = null;

export async function handler(event: unknown) {
  assertProductionConfig(config);
  cached ??= (async () => {
    const { buildApp, buildDeps } = await import('./app.js');
    return buildApp(await buildDeps()) as unknown as InjectApp;
  })();
  return invokeFc(await cached, event);
}
