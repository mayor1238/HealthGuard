import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth';
import type { Ctx } from '../context';
import { claims, complaints, payments } from '../db/repo';
import { fileComplaint, respondToClaim } from '../services/care';
import { changePrimaryProvider, initiatePayment, memberProfile, publicPayment } from '../services/members';
import { complaintCategory, frequency, method, parse, principal } from './util';

export const memberRoutes = (ctx: Ctx): FastifyPluginAsync => async (app) => {
  app.addHook('preHandler', requireRole(ctx, 'member'));
  const me = (req: Parameters<typeof principal>[0]) => principal(req).enrolleeId!;

  app.get('/profile', async (req) => memberProfile(ctx, me(req)));

  app.get('/payments', async (req) => (await payments.list(ctx.sql, 'enrollee_id = $1', [me(req)])).map(publicPayment));

  app.post('/payments', async (req, reply) => {
    const b = parse(z.object({ frequency, method }), req.body);
    reply.code(201);
    return initiatePayment(ctx, principal(req), me(req), b.frequency, b.method);
  });

  // Every bill sent in the member's name — the core of member-verified claims.
  app.get('/claims', async (req) => claims.list(ctx.sql, 'enrollee_id = $1', [me(req)]));

  app.post('/claims/:id/response', async (req) => {
    const { id } = parse(z.object({ id: z.string().max(20) }), req.params);
    const b = parse(z.object({ answer: z.enum(['confirmed', 'disputed']) }), req.body);
    return respondToClaim(ctx, principal(req), me(req), id, b.answer);
  });

  app.put('/primary-provider', async (req) => {
    const b = parse(z.object({ providerId: z.string().max(40) }), req.body);
    return changePrimaryProvider(ctx, principal(req), me(req), b.providerId);
  });

  app.get('/complaints', async (req) => complaints.list(ctx.sql, 'enrollee_id = $1', [me(req)]));

  app.post('/complaints', async (req, reply) => {
    const b = parse(z.object({ category: complaintCategory, description: z.string().trim().max(1000).default(''), providerId: z.string().max(40).optional() }), req.body);
    reply.code(201);
    return fileComplaint(ctx, principal(req), me(req), { ...b, description: b.description || b.category.replace(/_/g, ' '), channel: 'app' });
  });
};
