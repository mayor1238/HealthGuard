import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * Minimal database interface. The same SQL runs on real PostgreSQL (production)
 * and on PGlite — Postgres compiled to WebAssembly — for tests and quick local runs.
 */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs one or more statements without parameters (used for migrations). */
  exec(text: string): Promise<void>;
  /** Runs fn in a transaction; rolls back if it throws. Nested calls reuse the outer transaction. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Return BIGINT/NUMERIC as JS numbers (all our amounts fit comfortably) and DATE as 'YYYY-MM-DD'.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export function createPgSql(connectionString: string): Sql {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const wrap = (client: pg.PoolClient): Sql => ({
    query: async (text, params) => (await client.query(text, params)).rows,
    exec: async (text) => void (await client.query(text)),
    transaction: (fn) => fn(wrap(client)),
    close: async () => {},
  });
  return {
    query: async (text, params) => (await pool.query(text, params)).rows,
    exec: async (text) => void (await pool.query(text)),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createPgliteSql(dataDir = ''): Promise<Sql> {
  const { PGlite: Ctor } = await import('@electric-sql/pglite');
  const db: PGlite = dataDir ? new Ctor(dataDir) : new Ctor();
  await db.waitReady;
  // Match the pg driver's parsing: DATE as plain string, BIGINT/NUMERIC as numbers.
  const parsers = { 1082: (v: string) => v, 20: (v: string) => Number(v), 1700: (v: string) => Number(v) };
  type Q = Pick<PGlite, 'query' | 'exec'>;
  const wrap = (q: Q, inTx: boolean): Sql => ({
    query: async <T,>(text: string, params?: unknown[]) => (await q.query<T>(text, params as unknown[], { parsers })).rows,
    exec: async (text: string) => void (await q.exec(text)),
    transaction: (fn) => (inTx ? fn(wrap(q, true)) : db.transaction((tx) => fn(wrap(tx, true)))),
    close: async () => {},
  });
  const base = wrap(db, false);
  return { ...base, close: () => db.close() };
}

export const connect = (databaseUrl: string, pgliteDir = '') => (databaseUrl ? Promise.resolve(createPgSql(databaseUrl)) : createPgliteSql(pgliteDir));
