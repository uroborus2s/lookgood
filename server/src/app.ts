import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config as defaultCfg, type Config } from './config.js';
import { buildRouter } from './llm/client.js';
import { routes, type Deps } from './routes/index.js';
import { createRepo } from './repo/index.js';
import { llmExtractor, ruleExtractor } from './state/slots.js';
import { buildProviders, RenderService } from './render/service.js';
import { createSafety, type AiLabeler } from './safety/index.js';
import { ArchivingAiLabeler, createOssStore, MemoryObjectStore, type ObjectStore } from './storage/archive.js';
import { HttpError, UpstreamError, defaultFetch } from './http.js';

/** 组装依赖；测试可覆盖任意一项 */
export async function buildDeps(over: Partial<Deps> & { cfg?: Config; labeler?: AiLabeler } = {}): Promise<Deps> {
  const cfg = over.cfg ?? defaultCfg;
  const repo = over.repo ?? (await createRepo(cfg));
  const llm = over.llm ?? buildRouter(cfg);
  const f = over.fetch ?? defaultFetch;
  const safety = over.safety ?? createSafety(cfg, f);
  const store = over.store ?? (cfg.oss.live ? await createOssStore(cfg.oss) : new MemoryObjectStore());
  const labeler = over.labeler ?? new ArchivingAiLabeler({ store, fetch: f, mode: cfg.mode, aigc: cfg.aigc });
  return {
    cfg, repo, llm, safety, fetch: f, store,
    extractor: over.extractor ?? (cfg.llmLive ? llmExtractor(llm.chat) : ruleExtractor),
    render: over.render ?? new RenderService(repo, buildProviders(cfg, f), safety, labeler, cfg.modelPrices),
  };
}

export function buildApp(deps: Deps) {
  const app = Fastify({ logger: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(/^application\/json($|;)/i, { parseAs: 'string' }, (req, body, done) => {
    const s = typeof body === 'string' ? body : (body as Buffer | undefined)?.toString?.() ?? '';
    (req as any).rawBody = s;
    if (!s) return done(null, undefined);
    try { done(null, JSON.parse(s)); }
    catch { done(new HttpError(400, 'JSON 无法解析'), undefined); }
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: '参数错误', issues: err.issues });
    if (err instanceof UpstreamError) return reply.code(502).send({ error: '上游服务失败', code: err.code });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    reply.code(500).send({ error: '服务器错误' });
  });
  app.register(routes(deps));
  return app;
}

export type { ObjectStore };
