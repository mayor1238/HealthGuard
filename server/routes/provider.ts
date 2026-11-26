import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { utilisedInYear } from '../../src/domain/adjudication';
import { hmoById, planById, providerById, TARIFFS } from '../../src/domain/catalog';
import { checkEligibility } from '../../src/domain/pricing';
import { ageOn } from '../../src/domain/util';
import { requireRole } from '../auth';
import type { Ctx } from '../context';
import { notFound } from '../context';
import { audit, capitation, claims, paRequests } from '../db/repo';
import { previewClaim, requestPA, submitClaim } from '../services/care';
import { findMember } from '../services/members';
import { category, isoDate, naira, parse, principal, text } from './util';

const TARIFF_CODES = TARIFFS.map((t) => t.code) as [string, ...string[]];
const claimBody = z.object({
  enrolleeId: text(20),
  encounterDate: isoDate,
  diagnosis: text(120),
  paCode: z.string().trim().max(20).optional(),
  lines: z.array(z.object({ tariffCode: z.enum(TARIFF_CODES), quantity: z.number().int().min(1).max(100), unitPrice: naira })).min(1).max(50),
});

export const providerRoutes = (ctx: Ctx): FastifyPluginAsync => async (app) => {
  app.addHook('preHandler', requireRole(ctx, 'provider'));
  const mine = (req: Parameters<typeof principal>[0]) => principal(req).providerId!;

  /** Front-desk eligibility check. Returns only what's needed to treat — no phone, NIN or full DOB. */
  app.get('/eligibility', async (req) => {
    const { q } = parse(z.object({ q: text(40) }), req.query);
    const e = await findMember(ctx, q);
    const provider = providerById(mine(req))!;
    const today = ctx.today();
    const plan = planById(e.planId);
    const used = utilisedInYear(e.id, today.slice(0, 4), await claims.list(ctx.sql, 'enrollee_id = $1', [e.id]));
    await audit.log(ctx.sql, principal(req), 'member.looked_up', 'enrollee', e.id);
    return {
      id: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      gender: e.gender,
      age: ageOn(e.dateOfBirth, today),
      dependants: e.dependants,
      ninVerified: e.ninVerified,
      plan: { id: plan.id, name: plan.name, benefits: plan.benefits, annualLimit: plan.annualLimit },
      hmo: hmoById(e.hmoId),
      eligibility: checkEligibility(e, today),
      contractedWithHmo: provider.hmoIds.includes(e.hmoId),
      isPrimaryProvider: e.primaryProviderId === provider.id,
      referralNeeded: provider.level !== 'primary' || e.primaryProviderId !== provider.id,
      benefitRemaining: Math.max(0, plan.annualLimit - used),
    };
  });

  app.get('/pa-requests', async (req) => paRequests.list(ctx.sql, 'provider_id = $1', [mine(req)]));

  app.post('/pa-requests', async (req, reply) => {
    const b = parse(z.object({ enrolleeId: text(20), category, description: text(500), estimatedCost: naira }), req.body);
    reply.code(201);
    return requestPA(ctx, principal(req), mine(req), b);
  });

  app.post('/claims/preview', async (req) => previewClaim(ctx, mine(req), parse(claimBody, req.body)));

  app.post('/claims', async (req, reply) => {
    reply.code(201);
    return submitClaim(ctx, principal(req), mine(req), parse(claimBody, req.body));
  });

  app.get('/claims', async (req) => {
    const q = parse(z.object({ status: z.enum(['pending_review', 'approved', 'partially_approved', 'rejected', 'paid']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return q.status
      ? claims.list(ctx.sql, 'provider_id = $1 AND status = $2', [mine(req), q.status], q.limit)
      : claims.list(ctx.sql, 'provider_id = $1', [mine(req)], q.limit);
  });

  app.get('/claims/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().max(20) }), req.params);
    const c = await claims.get(ctx.sql, id);
    if (!c || c.providerId !== mine(req)) throw notFound('Claim');
    return c;
  });

  app.get('/capitation', async (req) => capitation.list(ctx.sql, 'provider_id = $1', [mine(req)]));
};
