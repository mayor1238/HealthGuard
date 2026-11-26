import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { hmoScorecard } from '../../src/domain/analytics';
import { requireRole } from '../auth';
import type { Ctx } from '../context';
import { capitation, claims, complaints, loadDb, paRequests } from '../db/repo';
import { decidePAManually, generateCapitation, payCapitation, payClaims, resolveComplaint, reviewHeldClaim } from '../services/care';
import { parse, principal, text } from './util';

export const hmoRoutes = (ctx: Ctx): FastifyPluginAsync => async (app) => {
  app.addHook('preHandler', requireRole(ctx, 'hmo'));
  const mine = (req: Parameters<typeof principal>[0]) => principal(req).hmoId!;
  const id = z.object({ id: z.string().max(60) });

  app.get('/overview', async (req) => {
    const scores = hmoScorecard(await loadDb(ctx.sql), ctx.today());
    return scores.find((s) => s.hmoId === mine(req));
  });

  app.get('/claims', async (req) => {
    const { queue } = parse(z.object({ queue: z.enum(['review', 'payable', 'all']).default('all') }), req.query);
    if (queue === 'review') return claims.list(ctx.sql, `hmo_id = $1 AND status = 'pending_review'`, [mine(req)]);
    if (queue === 'payable') return claims.list(ctx.sql, `hmo_id = $1 AND status IN ('approved', 'partially_approved')`, [mine(req)]);
    return claims.list(ctx.sql, 'hmo_id = $1', [mine(req)], 500);
  });

  app.post('/claims/:id/review', async (req) => {
    const p = parse(id, req.params);
    const b = parse(z.object({ verdict: z.enum(['approve', 'reject']), note: text(500) }), req.body);
    return reviewHeldClaim(ctx, principal(req), mine(req), p.id, b.verdict, b.note);
  });

  app.post('/claim-payments', async (req) => {
    const b = parse(z.object({ claimIds: z.array(z.string().max(20)).min(1).max(500) }), req.body);
    return payClaims(ctx, principal(req), mine(req), b.claimIds);
  });

  app.get('/pa-requests', async (req) => {
    const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'denied', 'used']).optional() }), req.query);
    return status ? paRequests.list(ctx.sql, 'hmo_id = $1 AND status = $2', [mine(req), status]) : paRequests.list(ctx.sql, 'hmo_id = $1', [mine(req)]);
  });

  app.post('/pa-requests/:id/decision', async (req) => {
    const p = parse(id, req.params);
    const b = parse(z.object({ approve: z.boolean(), note: text(500) }), req.body);
    return decidePAManually(ctx, principal(req), mine(req), p.id, b.approve, b.note);
  });

  app.get('/complaints', async (req) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'escalated', 'resolved']).optional() }), req.query);
    return status ? complaints.list(ctx.sql, 'hmo_id = $1 AND status = $2', [mine(req), status]) : complaints.list(ctx.sql, 'hmo_id = $1', [mine(req)]);
  });

  app.post('/complaints/:id/resolve', async (req) => {
    const p = parse(id, req.params);
    const b = parse(z.object({ resolution: text(1000) }), req.body);
    return resolveComplaint(ctx, principal(req), mine(req), p.id, b.resolution);
  });

  app.get('/capitation', async (req) => capitation.list(ctx.sql, 'hmo_id = $1', [mine(req)]));

  app.post('/capitation/runs', async (req) => {
    const b = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
    return generateCapitation(ctx, principal(req), mine(req), b.month);
  });

  app.post('/capitation/:id/pay', async (req) => payCapitation(ctx, principal(req), mine(req), parse(id, req.params).id));
};
