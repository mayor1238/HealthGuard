import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { hmoScorecard, systemSummary } from '../../src/domain/analytics';
import { requireRole } from '../auth';
import type { Ctx } from '../context';
import { audit, complaints, loadDb } from '../db/repo';
import { parse } from './util';

export const regulatorRoutes = (ctx: Ctx): FastifyPluginAsync => async (app) => {
  app.addHook('preHandler', requireRole(ctx, 'regulator'));

  // NOTE: computed in memory from the full dataset. Fine for a pilot; move to SQL
  // aggregates / materialised views before national scale.
  app.get('/summary', async () => {
    const db = await loadDb(ctx.sql);
    return { summary: systemSummary(db, ctx.today()), hmos: hmoScorecard(db, ctx.today()) };
  });

  app.get('/complaints', async (req) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'escalated', 'resolved']).default('escalated') }), req.query);
    return complaints.list(ctx.sql, 'status = $1', [status]);
  });

  app.get('/audit', async (req) => {
    const q = parse(z.object({ entityType: z.string().max(40).optional(), entityId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return audit.list(ctx.sql, q.limit, q.entityType, q.entityId);
  });
};
