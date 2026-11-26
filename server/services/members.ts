import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { utilisedInYear } from '../../src/domain/adjudication';
import { GROUPS, HMOS, PLANS, PROVIDERS, planById, providerById } from '../../src/domain/catalog';
import { checkEligibility, extendCover, quotePremium, MAX_DEPENDANTS } from '../../src/domain/pricing';
import type { Enrollee, Gender, PaymentFrequency, PaymentMethod, Sector } from '../../src/domain/types';
import { addDays, isValidHealthGuardId, isValidNin, isValidPhone, makeHealthGuardId } from '../../src/domain/util';
import { hashPassword } from '../auth';
import { HttpError, badRequest, conflict, notFound, type Ctx } from '../context';
import { audit, claims, enrollees, payments, users, type Actor, type PaymentRecord } from '../db/repo';
import type { Sql } from '../db/sql';

export const hashNin = (key: string, nin: string) => createHmac('sha256', key).update(nin.trim()).digest('hex');

/** Accepts 0803…, +234803… or 234803… and returns the 11-digit local form. */
export const normalisePhone = (raw: string) => {
  const d = raw.replace(/[^\d]/g, '');
  if (d.startsWith('234') && d.length === 13) return '0' + d.slice(3);
  return d;
};

const reference = () => 'HGP-' + randomBytes(6).toString('hex').toUpperCase();
/** Crypto-strength replacement for Math.random in domain helpers. */
export const secureRand = () => randomInt(0, 2 ** 32) / 2 ** 32;

export interface EnrolInput {
  firstName: string;
  lastName: string;
  gender: Gender;
  dateOfBirth: string;
  phone: string;
  nin: string;
  state: string;
  sector: Sector;
  planId: string;
  hmoId: string;
  primaryProviderId: string;
  dependants: number;
  frequency: PaymentFrequency;
  method: PaymentMethod;
  groupCode?: string;
  pin: string;
}

export async function enrol(ctx: Ctx, input: EnrolInput) {
  const phone = normalisePhone(input.phone);
  if (!isValidPhone(phone)) throw badRequest('Phone number must be a valid Nigerian mobile number');
  if (!isValidNin(input.nin)) throw badRequest('NIN must be 11 digits');
  if (!/^\d{6}$/.test(input.pin)) throw badRequest('PIN must be 6 digits');
  if (input.dateOfBirth > ctx.today()) throw badRequest('Date of birth is in the future');
  if (input.dependants < 0 || input.dependants > MAX_DEPENDANTS) throw badRequest(`Dependants must be between 0 and ${MAX_DEPENDANTS}`);
  if (!HMOS.some((h) => h.id === input.hmoId)) throw badRequest('Unknown HMO');
  if (!PLANS.some((p) => p.id === input.planId)) throw badRequest('Unknown plan');
  if (input.sector === 'vulnerable' && input.planId !== 'basic') throw badRequest('Sponsored members are enrolled on the Basic plan');
  const provider = providerById(input.primaryProviderId);
  if (!provider || provider.level !== 'primary' || !provider.accredited || !provider.hmoIds.includes(input.hmoId))
    throw badRequest('Choose an accredited primary provider contracted with your HMO');
  const groupCode = input.groupCode?.trim().toUpperCase() || undefined;
  if (groupCode && !GROUPS[groupCode]) throw badRequest('Unknown group code');
  if (input.sector === 'vulnerable' && groupCode) throw badRequest('Sponsored members do not need a group code');

  const ninOk = await ctx.nin.verify(input.nin, input);
  if (!ninOk) throw new HttpError(422, 'nin_not_verified', 'NIN could not be verified with the identity service');

  const ninHash = hashNin(ctx.config.ninHashKey, input.nin);
  const today = ctx.today();
  const pinHash = await hashPassword(input.pin);

  return ctx.sql.transaction(async (tx) => {
    if (await enrollees.findByNinHash(tx, ninHash)) throw conflict('This NIN is already enrolled');
    if (await enrollees.findByPhone(tx, phone)) throw conflict('This phone number is already registered');

    const id = makeHealthGuardId(await enrollees.nextId(tx));
    const quote = quotePremium({ planId: input.planId, dependants: input.dependants, frequency: input.frequency, groupCode, sector: input.sector });
    await enrollees.insert(tx, {
      id,
      ninHash,
      ninLast4: input.nin.slice(-4),
      ninVerified: true,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      gender: input.gender,
      dateOfBirth: input.dateOfBirth,
      phone,
      state: provider.state,
      lga: provider.lga,
      sector: input.sector,
      planId: input.planId,
      hmoId: input.hmoId,
      primaryProviderId: provider.id,
      dependants: input.dependants,
      enrolledOn: today,
      // No cover until the first payment is confirmed.
      paidThrough: addDays(today, -1),
      frequency: input.frequency,
      groupCode,
      sponsor: input.sector === 'vulnerable' ? 'Basic Health Care Provision Fund' : undefined,
    });
    await users.insert(tx, { id: randomUUID(), username: phone, passwordHash: pinHash, role: 'member', enrolleeId: id });
    await audit.log(tx, { role: 'public' }, 'enrollee.created', 'enrollee', id, { planId: input.planId, hmoId: input.hmoId, sector: input.sector });

    let payment: PaymentRecord;
    if (quote.payer === 'sponsor') {
      // Sponsored cover is drawn from the sponsor's pool, so it starts immediately.
      // TODO: route through a sponsor-eligibility check (social worker / NSR) before production.
      payment = await createPayment(tx, id, quote.installment, 'sponsor', input.frequency, quote.daysCovered);
      await confirm(tx, payment, today, { role: 'system' });
    } else {
      payment = await createPayment(tx, id, quote.installment, input.method, input.frequency, quote.daysCovered);
    }
    const enrollee = (await enrollees.get(tx, id))!;
    return { enrollee, payment: publicPayment((await payments.byReference(tx, payment.reference))!) };
  });
}

async function createPayment(sql: Sql, enrolleeId: string, amount: number, method: PaymentMethod, frequency: PaymentFrequency, daysCovered: number) {
  const p: PaymentRecord = { id: randomUUID(), enrolleeId, amount, method, frequency, daysCovered, status: 'pending', reference: reference() };
  await payments.insert(sql, p);
  return p;
}

export const publicPayment = (p: PaymentRecord) => ({
  reference: p.reference,
  amount: p.amount,
  method: p.method,
  frequency: p.frequency,
  daysCovered: p.daysCovered,
  status: p.status,
  paidAt: p.paidAt,
});

/** Starts a premium payment. Cover is only extended when the gateway confirms it. */
export async function initiatePayment(ctx: Ctx, actor: Actor, enrolleeId: string, frequency: PaymentFrequency, method: PaymentMethod) {
  if (method === 'sponsor') throw badRequest('Sponsor payments are not initiated by members');
  const e = await enrollees.get(ctx.sql, enrolleeId);
  if (!e) throw notFound('Member');
  if (e.sector === 'vulnerable') throw badRequest('This cover is sponsored — nothing to pay');
  const q = quotePremium({ planId: e.planId, dependants: e.dependants, frequency, groupCode: e.groupCode, sector: e.sector });
  const p = await createPayment(ctx.sql, e.id, q.installment, method, frequency, q.daysCovered);
  await audit.log(ctx.sql, actor, 'payment.initiated', 'payment', p.reference, { amount: p.amount, method });
  return publicPayment(p);
}

async function confirm(tx: Sql, p: PaymentRecord, today: string, actor: Actor) {
  const e = await enrollees.getForUpdate(tx, p.enrolleeId);
  if (!e) throw notFound('Member');
  const paidThrough = extendCover(e.paidThrough, p.daysCovered, today);
  await enrollees.setCover(tx, e.id, paidThrough, p.frequency);
  await payments.setStatus(tx, p.id, 'confirmed', today);
  await audit.log(tx, actor, 'payment.confirmed', 'payment', p.reference, { amount: p.amount, paidThrough });
  return paidThrough;
}

/**
 * Gateway callback. Idempotent: gateways retry, so confirming twice must not extend cover twice.
 */
export async function settlePayment(ctx: Ctx, actor: Actor, ref: string, outcome: 'success' | 'failed', amountPaid: number) {
  return ctx.sql.transaction(async (tx) => {
    const p = await payments.byReference(tx, ref, true);
    if (!p) throw notFound('Payment');
    if (p.status !== 'pending') return { payment: publicPayment(p), changed: false };
    if (outcome === 'failed') {
      await payments.setStatus(tx, p.id, 'failed');
      await audit.log(tx, actor, 'payment.failed', 'payment', ref);
    } else {
      if (amountPaid !== p.amount) {
        await audit.log(tx, actor, 'payment.amount_mismatch', 'payment', ref, { expected: p.amount, received: amountPaid });
        throw badRequest(`Amount mismatch: expected ${p.amount}, received ${amountPaid}`);
      }
      await confirm(tx, p, ctx.today(), actor);
    }
    return { payment: publicPayment((await payments.byReference(tx, ref))!), changed: true };
  });
}

export async function memberProfile(ctx: Ctx, enrolleeId: string) {
  const e = await enrollees.get(ctx.sql, enrolleeId);
  if (!e) throw notFound('Member');
  const today = ctx.today();
  const plan = planById(e.planId);
  const mine = await claims.list(ctx.sql, 'enrollee_id = $1', [e.id]);
  const used = utilisedInYear(e.id, today.slice(0, 4), mine);
  return {
    enrollee: e,
    eligibility: checkEligibility(e, today),
    plan,
    primaryProvider: providerById(e.primaryProviderId),
    benefitUsedThisYear: used,
    benefitRemaining: Math.max(0, plan.annualLimit - used),
    nextPayment: e.sector === 'vulnerable' ? null : quotePremium({ planId: e.planId, dependants: e.dependants, frequency: e.frequency, groupCode: e.groupCode, sector: e.sector }),
  };
}

export async function changePrimaryProvider(ctx: Ctx, actor: Actor, enrolleeId: string, providerId: string) {
  const e = await enrollees.get(ctx.sql, enrolleeId);
  if (!e) throw notFound('Member');
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p || p.level !== 'primary' || !p.accredited || !p.hmoIds.includes(e.hmoId)) throw badRequest('Choose an accredited primary provider contracted with your HMO');
  await ctx.sql.transaction(async (tx) => {
    await enrollees.setPrimaryProvider(tx, e.id, p.id);
    await audit.log(tx, actor, 'enrollee.provider_changed', 'enrollee', e.id, { from: e.primaryProviderId, to: p.id });
  });
  return (await enrollees.get(ctx.sql, e.id))!;
}

/** Provider-facing lookup by HealthGuard ID, phone or NIN. Returns only what the front desk needs. */
export async function findMember(ctx: Ctx, q: string): Promise<Enrollee> {
  const v = q.trim().toUpperCase();
  let e: Enrollee | undefined;
  if (v.startsWith('HG-')) {
    if (!isValidHealthGuardId(v)) throw badRequest('That ID fails its check digit — probably a typo');
    e = await enrollees.get(ctx.sql, v);
  } else {
    // Phone numbers and NINs are both 11 digits; try the phone first, then the NIN.
    const digits = v.replace(/\D/g, '');
    e = (await enrollees.findByPhone(ctx.sql, normalisePhone(digits))) ?? (digits.length === 11 ? await enrollees.findByNinHash(ctx.sql, hashNin(ctx.config.ninHashKey, digits)) : undefined);
  }
  if (!e) throw notFound('Member');
  return e;
}
