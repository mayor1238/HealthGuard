import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { hmoScorecard } from '../../src/domain/analytics';
import { CATEGORY_LABELS, COMPLAINT_LABELS, DIAGNOSES, HMOS, PLANS, PROVIDERS, STATES, TARIFFS } from '../../src/domain/catalog';
import { quotePremium } from '../../src/domain/pricing';
import { authenticate, login } from '../auth';
import type { Ctx } from '../context';
import { loadDb } from '../db/repo';
import { enrol } from '../services/members';
import { frequency, isoDate, method, parse, text } from './util';

export const publicRoutes = (ctx: Ctx): FastifyPluginAsync => async (app) => {
  app.post('/auth/login', { config: { rateLimit: ctx.config.rateLimits ? { max: 10, timeWindow: '1 minute' } : false } }, async (req) => {
    const body = parse(z.object({ username: text(64), password: z.string().min(1).max(128) }), req.body);
    return login(ctx, body.username, body.password);
  });

  app.get('/auth/me', async (req) => ({ principal: await authenticate(ctx, req) }));

  app.get('/catalog', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return {
      plans: PLANS,
      hmos: HMOS,
      providers: PROVIDERS,
      tariffs: TARIFFS,
      diagnoses: DIAGNOSES,
      states: STATES,
      serviceCategories: CATEGORY_LABELS,
      complaintCategories: COMPLAINT_LABELS,
    };
  });

  app.post('/quotes', async (req) => {
    const b = parse(
      z.object({
        planId: z.enum(['basic', 'standard', 'premium']),
        dependants: z.number().int().min(0).max(5),
        frequency,
        sector: z.enum(['formal', 'informal', 'vulnerable']),
        groupCode: z.string().max(40).optional(),
      }),
      req.body,
    );
    return quotePremium(b);
  });

  // Published so people can choose an HMO on performance. Recomputed at most once a minute.
  let cache: { at: number; data: unknown } | undefined;
  app.get('/hmos/performance', async () => {
    const now = ctx.config.now().getTime();
    if (!cache || now - cache.at > 60_000) {
      const scores = hmoScorecard(await loadDb(ctx.sql), ctx.today());
      cache = {
        at: now,
        data: scores.map((s) => ({
          hmoId: s.hmoId,
          name: s.name,
          avgDaysToPay: s.avgDaysToPay,
          paidWithinSla: s.paidWithinSla,
          complaintResolution: s.complaintResolution,
          complaintsPer1000: s.complaintsPer1000,
        })),
      };
    }
    return cache.data;
  });

  app.post('/enrolments', { config: { rateLimit: ctx.config.rateLimits ? { max: 5, timeWindow: '1 minute' } : false } }, async (req, reply) => {
    const b = parse(
      z.object({
        firstName: text(60),
        lastName: text(60),
        gender: z.enum(['female', 'male']),
        dateOfBirth: isoDate,
        phone: text(20),
        nin: z.string().regex(/^\d{11}$/, 'NIN must be 11 digits'),
        state: text(30),
        sector: z.enum(['formal', 'informal', 'vulnerable']),
        planId: z.enum(['basic', 'standard', 'premium']),
        hmoId: text(40),
        primaryProviderId: text(40),
        dependants: z.number().int().min(0).max(5),
        frequency,
        method,
        groupCode: z.string().max(40).optional(),
        pin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
      }),
      req.body,
    );
    reply.code(201);
    return enrol(ctx, b);
  });
};
