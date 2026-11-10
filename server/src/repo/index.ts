import type { Config } from '../config.js';
import { MemoryRepo } from './memory.js';
import { migrate, PgRepo } from './pg.js';
import type { Repo } from './types.js';
export type { Repo } from './types.js';

/** REPO=pg 且 DATABASE_URL 存在时用 PostgreSQL，否则内存 */
export async function createRepo(cfg: Config): Promise<Repo> {
  if (cfg.repo === 'pg' && cfg.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
    await migrate(pool);
    return new PgRepo(pool);
  }
  return new MemoryRepo();
}
