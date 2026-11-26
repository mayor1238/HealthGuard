import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { loadConfig, type Config } from '../config';
import { migrate } from '../db/migrations';
import { connect, type Sql } from '../db/sql';
import { seedDemo } from '../services/seed';
import { signWebhook } from '../routes/integrations';

/**
 * Test harness. Uses in-memory PGlite by default; set TEST_DATABASE_URL to run the
 * same suite against a real PostgreSQL server (the schema is wiped first).
 */
export async function setup(opts: { seed?: boolean; start?: string } = {}) {
  let now = new Date(opts.start ?? '2026-11-26T12:00:00Z');
  const config: Config = {
    ...loadConfig({ NODE_ENV: 'test' }),
    jwtSecret: 'test-secret-test-secret-test-secret-123',
    paymentWebhookSecret: 'whsec_test',
    ninHashKey: 'nin-key-test',
    now: () => now,
  };
  const url = process.env.TEST_DATABASE_URL ?? '';
  const sql: Sql = await connect(url);
  if (url) await sql.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql);
  const { app, ctx } = await buildApp({ sql, config });
  if (opts.seed !== false) await seedDemo(ctx);

  const call = async (method: string, url: string, body?: unknown, token?: string) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    let json: any;
    try {
      json = res.json();
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, body: json, text: res.body };
  };

  const loginAs = async (username: string, password: string) => {
    const r = await call('POST', '/api/v1/auth/login', { username, password });
    if (r.status !== 200) throw new Error(`login failed for ${username}: ${r.text}`);
    return r.body.token as string;
  };

  const webhook = (payload: unknown, secret = config.paymentWebhookSecret) => {
    const raw = JSON.stringify(payload);
    return app.inject({ method: 'POST', url: '/api/v1/webhooks/payments', payload: raw, headers: { 'content-type': 'application/json', 'x-healthguard-signature': signWebhook(secret, raw) } });
  };

  return {
    app: app as FastifyInstance,
    ctx,
    sql,
    call,
    loginAs,
    webhook,
    advance: (hours: number) => (now = new Date(now.getTime() + hours * 3_600_000)),
    close: async () => {
      await app.close();
      await sql.close();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof setup>>;
