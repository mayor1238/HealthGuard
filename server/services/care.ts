import { randomUUID } from 'node:crypto';
import { adjudicate, canPay, reviewClaim, type ClaimDraft } from '../../src/domain/adjudication';
import { capitationDue } from '../../src/domain/analytics';
import { PLANS, PROVIDERS, providerById } from '../../src/domain/catalog';
import { ENROLLEE_DISPUTE_FLAG, REVIEW_THRESHOLD } from '../../src/domain/fraud';
import { decidePA } from '../../src/domain/preauth';
import type { Claim, ClaimLine, Complaint, ComplaintCategory, Db, PARequest, ServiceCategory } from '../../src/domain/types';
import { addDays, randomCode } from '../../src/domain/util';
import { SYSTEM, badRequest, conflict, notFound, type Ctx } from '../context';
import { audit, capitation, claims, complaints, enrollees, paRequests, type Actor } from '../db/repo';
import type { Sql } from '../db/sql';
import { secureRand } from './members';

// ---------------- Claims ----------------

export interface ClaimInput {
  enrolleeId: string;
  encounterDate: string;
  diagnosis: string;
  paCode?: string;
  lines: ClaimLine[];
}

/** Loads exactly the history the rules need: this member's claims and this provider's recent claims. */
async function adjudicationContext(sql: Sql, enrolleeId: string, providerId: string, today: string) {
  const enrollee = await enrollees.get(sql, enrolleeId);
  if (!enrollee) throw notFound('Member');
  const provider = providerById(providerId);
  if (!provider) throw notFound('Provider');
  const [mine, providerRecent, pas] = await Promise.all([
    claims.list(sql, 'enrollee_id = $1', [enrolleeId]),
    claims.list(sql, 'provider_id = $1 AND submitted_at >= $2', [providerId, addDays(today, -63)]),
    paRequests.list(sql, 'enrollee_id = $1', [enrolleeId]),
  ]);
  const history = [...new Map([...mine, ...providerRecent].map((c) => [c.id, c])).values()];
  return { enrollee, provider, history, paRequests: pas };
}

function toDraft(ctx: Ctx, providerId: string, input: ClaimInput): ClaimDraft {
  if (input.encounterDate > ctx.today()) throw badRequest('Encounter date cannot be in the future');
  if (!input.lines.length) throw badRequest('A claim needs at least one service line');
  return {
    enrolleeId: input.enrolleeId.trim().toUpperCase(),
    providerId,
    encounterDate: input.encounterDate,
    submittedAt: ctx.today(),
    diagnosis: input.diagnosis,
    paCode: input.paCode?.trim().toUpperCase() || undefined,
    lines: input.lines,
  };
}

/** What would be paid, without saving anything. */
export async function previewClaim(ctx: Ctx, providerId: string, input: ClaimInput) {
  const draft = toDraft(ctx, providerId, input);
  const c = await adjudicationContext(ctx.sql, draft.enrolleeId, providerId, ctx.today());
  return adjudicate(draft, c);
}

export async function submitClaim(ctx: Ctx, actor: Actor, providerId: string, input: ClaimInput): Promise<Claim> {
  const draft = toDraft(ctx, providerId, input);
  return ctx.sql.transaction(async (tx) => {
    // One claim per member at a time, so duplicate checks and the annual limit can't be raced.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [draft.enrolleeId]);
    const c = await adjudicationContext(tx, draft.enrolleeId, providerId, ctx.today());
    const r = adjudicate(draft, c);
    const claim: Claim = {
      id: await claims.nextId(tx),
      ...draft,
      hmoId: c.enrollee.hmoId,
      status: r.status,
      decisions: r.decisions,
      fraudFlags: r.fraudFlags,
      riskScore: r.riskScore,
      billedTotal: r.billedTotal,
      approvedTotal: r.approvedTotal,
      copayTotal: r.copayTotal,
      decidedAt: r.status === 'pending_review' ? undefined : ctx.today(),
    };
    await claims.insert(tx, claim);
    if (claim.paCode && claim.status !== 'rejected') {
      await tx.query(`UPDATE pa_requests SET status = 'used' WHERE code = $1 AND status = 'approved'`, [claim.paCode]);
    }
    await audit.log(tx, actor, 'claim.submitted', 'claim', claim.id, { status: claim.status, billed: claim.billedTotal, approved: claim.approvedTotal, risk: claim.riskScore });
    return claim;
  });
}

export async function reviewHeldClaim(ctx: Ctx, actor: Actor, hmoId: string, claimId: string, verdict: 'approve' | 'reject', note: string) {
  return ctx.sql.transaction(async (tx) => {
    const c = await claims.get(tx, claimId, true);
    if (!c || c.hmoId !== hmoId) throw notFound('Claim');
    if (c.status !== 'pending_review') throw conflict(`Claim is ${c.status}, not awaiting review`);
    const next = reviewClaim(c, verdict, note, ctx.today());
    await claims.update(tx, c.id, {
      status: next.status,
      approvedTotal: next.approvedTotal,
      copayTotal: next.copayTotal,
      decisions: next.decisions,
      reviewerNote: next.reviewerNote,
      decidedAt: next.decidedAt,
      reviewedBy: actor.id,
    });
    await audit.log(tx, actor, `claim.review.${verdict}`, 'claim', c.id, { note });
    return (await claims.get(tx, c.id))!;
  });
}

/**
 * Pays a batch of approved claims. The bank transfer itself is out of scope here —
 * in production this hands the batch to the payout provider and marks claims paid on its callback.
 */
export async function payClaims(ctx: Ctx, actor: Actor, hmoId: string, claimIds: string[]) {
  const ids = [...new Set(claimIds)];
  return ctx.sql.transaction(async (tx) => {
    const batch = 'BATCH-' + randomUUID().slice(0, 8).toUpperCase();
    let total = 0;
    const paid: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of ids) {
      const c = await claims.get(tx, id, true);
      if (!c || c.hmoId !== hmoId) skipped.push({ id, reason: 'not found' });
      else if (!canPay(c)) skipped.push({ id, reason: `status is ${c.status}` });
      else {
        await claims.update(tx, id, { status: 'paid', paidAt: ctx.today(), paymentBatch: batch });
        total += c.approvedTotal;
        paid.push(id);
      }
    }
    if (paid.length) await audit.log(tx, actor, 'claims.paid', 'payment_batch', batch, { claims: paid, total });
    return { batch: paid.length ? batch : null, paid, total, skipped };
  });
}

export async function respondToClaim(ctx: Ctx, actor: Actor, enrolleeId: string, claimId: string, answer: 'confirmed' | 'disputed') {
  return ctx.sql.transaction(async (tx) => {
    const c = await claims.get(tx, claimId, true);
    if (!c || c.enrolleeId !== enrolleeId) throw notFound('Claim');
    if (c.enrolleeConfirmation) throw conflict('You have already responded to this claim');
    if (answer === 'confirmed') {
      await claims.update(tx, c.id, { enrolleeConfirmation: 'confirmed' });
    } else {
      const riskScore = Math.min(100, c.riskScore + 40);
      const status = c.status === 'paid' || c.status === 'rejected' ? c.status : riskScore >= REVIEW_THRESHOLD ? 'pending_review' : c.status;
      await claims.update(tx, c.id, { enrolleeConfirmation: 'disputed', fraudFlags: [...c.fraudFlags, ENROLLEE_DISPUTE_FLAG], riskScore, status });
    }
    await audit.log(tx, actor, `claim.member_${answer}`, 'claim', c.id);
    return (await claims.get(tx, c.id))!;
  });
}

// ---------------- Pre-authorisation ----------------

export async function requestPA(
  ctx: Ctx,
  actor: Actor,
  providerId: string,
  input: { enrolleeId: string; category: ServiceCategory; description: string; estimatedCost: number },
): Promise<PARequest> {
  const enrollee = await enrollees.get(ctx.sql, input.enrolleeId.trim().toUpperCase());
  if (!enrollee) throw notFound('Member');
  const provider = providerById(providerId);
  if (!provider) throw notFound('Provider');
  const d = decidePA(input, enrollee, provider, ctx.today());
  const now = ctx.nowIso();
  const pa: PARequest = {
    code: randomCode('PA', secureRand, 8),
    enrolleeId: enrollee.id,
    providerId,
    hmoId: enrollee.hmoId,
    category: input.category,
    description: input.description,
    estimatedCost: input.estimatedCost,
    status: d.status,
    requestedAt: now,
    decidedAt: d.status === 'pending' ? undefined : now,
    expiresAt: d.expiresAt,
    autoDecided: d.status !== 'pending',
    note: d.note,
  };
  await ctx.sql.transaction(async (tx) => {
    await paRequests.insert(tx, pa);
    await audit.log(tx, actor, 'pa.requested', 'pa_request', pa.code, { status: pa.status, category: pa.category, estimatedCost: pa.estimatedCost });
  });
  return pa;
}

export async function decidePAManually(ctx: Ctx, actor: Actor, hmoId: string, code: string, approve: boolean, note: string) {
  return ctx.sql.transaction(async (tx) => {
    const pa = await paRequests.get(tx, code, true);
    if (!pa || pa.hmoId !== hmoId) throw notFound('PA request');
    if (pa.status !== 'pending') throw conflict(`PA request is already ${pa.status}`);
    await paRequests.update(tx, code, {
      status: approve ? 'approved' : 'denied',
      decidedAt: ctx.nowIso(),
      expiresAt: approve ? addDays(ctx.today(), 14) : undefined,
      note,
      decidedBy: actor.id,
    });
    await audit.log(tx, actor, approve ? 'pa.approved' : 'pa.denied', 'pa_request', code, { note });
    return (await paRequests.get(tx, code))!;
  });
}

// ---------------- Complaints ----------------

export const COMPLAINT_SLA_HOURS = 48;

export async function fileComplaint(
  ctx: Ctx,
  actor: Actor,
  enrolleeId: string,
  input: { category: ComplaintCategory; description: string; providerId?: string; channel: 'app' | 'ussd' },
): Promise<Complaint> {
  const e = await enrollees.get(ctx.sql, enrolleeId);
  if (!e) throw notFound('Member');
  if (input.providerId && !PROVIDERS.some((p) => p.id === input.providerId)) throw badRequest('Unknown provider');
  return ctx.sql.transaction(async (tx) => {
    const c: Complaint = {
      id: await complaints.nextId(tx),
      enrolleeId: e.id,
      providerId: input.providerId ?? e.primaryProviderId,
      hmoId: e.hmoId,
      category: input.category,
      description: input.description,
      status: 'open',
      channel: input.channel,
      createdAt: ctx.nowIso(),
    };
    await complaints.insert(tx, c);
    await audit.log(tx, actor, 'complaint.filed', 'complaint', c.id, { category: c.category, channel: c.channel });
    return c;
  });
}

export async function resolveComplaint(ctx: Ctx, actor: Actor, hmoId: string, id: string, resolution: string) {
  return ctx.sql.transaction(async (tx) => {
    const c = await complaints.get(tx, id);
    if (!c || c.hmoId !== hmoId) throw notFound('Complaint');
    if (c.status === 'resolved') throw conflict('Complaint is already resolved');
    await complaints.update(tx, id, { status: 'resolved', resolution, resolvedAt: ctx.nowIso() });
    await audit.log(tx, actor, 'complaint.resolved', 'complaint', id, { resolution });
    return (await complaints.get(tx, id))!;
  });
}

/** Escalates complaints an HMO has left open past the deadline. Safe to run repeatedly. */
export async function escalateOverdueComplaints(ctx: Ctx) {
  const cutoff = new Date(ctx.config.now().getTime() - COMPLAINT_SLA_HOURS * 3_600_000).toISOString();
  return ctx.sql.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(`UPDATE complaints SET status = 'escalated' WHERE status = 'open' AND created_at < $1 RETURNING id`, [cutoff]);
    for (const r of rows) await audit.log(tx, SYSTEM, 'complaint.escalated', 'complaint', r.id, { reason: `open longer than ${COMPLAINT_SLA_HOURS}h` });
    return rows.map((r) => r.id);
  });
}

// ---------------- Capitation ----------------

const RATES = Object.fromEntries(PLANS.map((p) => [p.id, p.capitationRate]));

/** Calculates (or recalculates, until paid) each primary provider's capitation for a month. */
export async function generateCapitation(ctx: Ctx, actor: Actor, hmoId: string, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Month must be YYYY-MM');
  const members = await enrollees.list(ctx.sql, 'hmo_id = $1', [hmoId]);
  const db: Db = { enrollees: members, payments: [], claims: [], paRequests: [], complaints: [], capitation: [] };
  const rows = [];
  await ctx.sql.transaction(async (tx) => {
    for (const p of PROVIDERS.filter((x) => x.level === 'primary' && x.accredited && x.hmoIds.includes(hmoId))) {
      const due = capitationDue(db, p.id, hmoId, RATES, ctx.today());
      if (!due.lives) continue;
      const row = { id: `CAP-${p.id}-${hmoId}-${month}`, providerId: p.id, hmoId, month, lives: due.lives, amount: due.amount };
      await capitation.upsert(tx, row);
      rows.push(row);
    }
    await audit.log(tx, actor, 'capitation.generated', 'capitation_run', `${hmoId}:${month}`, { providers: rows.length });
  });
  return capitation.list(ctx.sql, 'hmo_id = $1 AND month = $2', [hmoId, month]);
}

export async function payCapitation(ctx: Ctx, actor: Actor, hmoId: string, id: string) {
  return ctx.sql.transaction(async (tx) => {
    const row = await capitation.get(tx, id);
    if (!row || row.hmoId !== hmoId) throw notFound('Capitation');
    if (!(await capitation.markPaid(tx, id, ctx.today()))) throw conflict('Capitation already paid');
    await audit.log(tx, actor, 'capitation.paid', 'capitation', id, { amount: row.amount });
    return (await capitation.get(tx, id))!;
  });
}
