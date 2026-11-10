import { assertProductionConfig } from './auth/secrets.js';
import { buildApp, buildDeps } from './app.js';
import { config } from './config.js';
import { purgeExpired, ossDeleter, type ObjectDeleter } from './storage/oss.js';

assertProductionConfig(config);
if (config.nodeEnv === 'production' && config.safety.provider === 'mock') {
  console.warn('[safety] 生产环境 CONTENT_SAFETY=mock，仅使用本地词表。上线前请改为 wechat 或 aliyun');
}

const deps = await buildDeps();
const app = buildApp(deps);
const del: ObjectDeleter = deps.cfg.oss.live ? await ossDeleter(deps.cfg.oss) : async keys => { if (keys.length) console.log('[mock] 删除过期原图', keys.length); };
setInterval(() => purgeExpired(deps.repo, del).catch(e => console.error('purge', e)), 10 * 60_000).unref();
await app.listen({ port: deps.cfg.port, host: '0.0.0.0' });
console.log(`一身好看 server :${deps.cfg.port} mode=${deps.cfg.mode} repo=${deps.cfg.repo} safety=${deps.cfg.safety.provider}`);
