import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config';
import { HttpError, makeCtx, type NinVerifier } from './context';
import type { Sql } from './db/sql';
import { hmoRoutes } from './routes/hmo';
import { integrationRoutes } from './routes/integrations';
import { memberRoutes } from './routes/member';
import { providerRoutes } from './routes/provider';
import { publicRoutes } from './routes/public';
import { regulatorRoutes } from './routes/regulator';

export async function buildApp(opts: { sql: Sql; config: Config; nin?: NinVerifier }) {
  const ctx = makeCtx(opts.sql, opts.config, opts.nin);
  const app = Fastify({
    logger: opts.config.env === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers["x-healthguard-signature"]'] },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cors, { origin: opts.config.corsOrigins, credentials: false });
  await app.register(rateLimit, { global: false });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_error', message: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as FastifyError).code ?? 'error', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.get('/healthz', async () => {
    await opts.sql.query('SELECT 1');
    return { ok: true };
  });

  await app.register(publicRoutes(ctx), { prefix: '/api/v1' });
  await app.register(memberRoutes(ctx), { prefix: '/api/v1/member' });
  await app.register(providerRoutes(ctx), { prefix: '/api/v1/provider' });
  await app.register(hmoRoutes(ctx), { prefix: '/api/v1/hmo' });
  await app.register(regulatorRoutes(ctx), { prefix: '/api/v1/regulator' });
  await app.register(integrationRoutes(ctx), { prefix: '/api/v1' });

  return { app, ctx };
}
