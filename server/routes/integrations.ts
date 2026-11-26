import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, type Ctx } from '../context';
import { payments } from '../db/repo';
import { settlePayment } from '../services/members';
import { handleUssd } from '../services/ussd';
import { naira, parse } from './util';

export const signWebhook = (secret: string, body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Endpoints called by external systems: payment gateway and USSD aggregator. */
export const integrationRoutes = (ctx: Ctx): FastifyPluginAsync => async (app) => {
  // Keep the raw body so the webhook signature is checked over the exact bytes received.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new HttpError(400, 'bad_json', 'Body is not valid JSON'), undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.post('/webhooks/payments', async (req) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const sig = String(req.headers['x-healthguard-signature'] ?? '');
    if (!sig || !safeEqual(sig, signWebhook(ctx.config.paymentWebhookSecret, raw))) throw new HttpError(401, 'bad_signature', 'Invalid webhook signature');
    const b = parse(z.object({ reference: z.string().max(40), status: z.enum(['success', 'failed']), amount: naira }), req.body);
    return settlePayment(ctx, { role: 'gateway' }, b.reference, b.status, b.amount);
  });

  app.post('/ussd', { config: { rateLimit: ctx.config.rateLimits ? { max: 60, timeWindow: '1 minute' } : false } }, async (req, reply) => {
    if (ctx.config.ussdSecret) {
      const key = String((req.query as Record<string, unknown>).key ?? '');
      if (!safeEqual(key, ctx.config.ussdSecret)) throw new HttpError(401, 'bad_key', 'Invalid USSD key');
    }
    const b = parse(z.object({ phoneNumber: z.string().max(20), text: z.string().max(200).default(''), sessionId: z.string().max(100).optional() }), req.body);
    reply.type('text/plain; charset=utf-8');
    return handleUssd(ctx, b.phoneNumber, b.text);
  });

  // Development only: stands in for the gateway so the app can be used without one.
  if (ctx.config.env !== 'production') {
    app.post('/dev/payments/:reference/confirm', async (req) => {
      const { reference } = parse(z.object({ reference: z.string().max(40) }), req.params);
      const p = await payments.byReference(ctx.sql, reference);
      if (!p) throw new HttpError(404, 'not_found', 'Payment not found');
      return settlePayment(ctx, { role: 'gateway', id: 'dev-simulator' }, reference, 'success', p.amount);
    });
  }
};
