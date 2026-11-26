import { describe, expect, it } from 'vitest';
import { adjudicate, reviewClaim, type ClaimDraft } from './adjudication';
import { PROVIDERS } from './catalog';
import { hmoScorecard, systemSummary } from './analytics';
import { detectFraud } from './fraud';
import { decidePA } from './preauth';
import { checkEligibility, extendCover, quotePremium } from './pricing';
import { generateSeed } from './seed';
import type { Enrollee, PARequest } from './types';
import { isValidHealthGuardId, makeHealthGuardId } from './util';
import { ussd } from './ussd';

const TODAY = '2026-11-26';
const ikeja = PROVIDERS.find((p) => p.id === 'prv-001')!;
const lagoon = PROVIDERS.find((p) => p.id === 'prv-003')!;
const ringRoad = PROVIDERS.find((p) => p.id === 'prv-012')!;

const enrollee = (over: Partial<Enrollee> = {}): Enrollee => ({
  id: makeHealthGuardId(99),
  nin: '12345678901',
  firstName: 'Ada',
  lastName: 'Obi',
  gender: 'female',
  dateOfBirth: '1990-01-01',
  phone: '08030000000',
  state: 'Lagos',
  lga: 'Ikeja',
  sector: 'informal',
  planId: 'standard',
  hmoId: 'hmo-unity',
  primaryProviderId: 'prv-001',
  dependants: 0,
  enrolledOn: '2026-01-01',
  paidThrough: '2026-12-31',
  frequency: 'monthly',
  ninVerified: true,
  ...over,
});

const draft = (over: Partial<ClaimDraft> = {}): ClaimDraft => ({
  enrolleeId: makeHealthGuardId(99),
  providerId: 'prv-001',
  encounterDate: '2026-11-20',
  submittedAt: '2026-11-21',
  diagnosis: 'B54 Malaria, unspecified',
  lines: [
    { tariffCode: 'CON-01', quantity: 1, unitPrice: 5000 },
    { tariffCode: 'LAB-01', quantity: 1, unitPrice: 2500 },
    { tariffCode: 'DRG-01', quantity: 1, unitPrice: 3500 },
  ],
  ...over,
});

describe('HealthGuard IDs', () => {
  it('generates IDs with a valid check digit and catches typos', () => {
    const id = makeHealthGuardId(1234);
    expect(isValidHealthGuardId(id)).toBe(true);
    const typo = id.slice(0, -2) + String((Number(id.at(-2)) + 1) % 10) + id.at(-1);
    expect(isValidHealthGuardId(typo)).toBe(false);
  });
});

describe('premium pricing', () => {
  it('lets informal workers pay daily, weekly or monthly with the same yearly cost', () => {
    const daily = quotePremium({ planId: 'basic', dependants: 0, frequency: 'daily', sector: 'informal' });
    const monthly = quotePremium({ planId: 'basic', dependants: 0, frequency: 'monthly', sector: 'informal' });
    expect(daily.installment).toBeLessThan(150);
    expect(Math.abs(daily.annualCost - monthly.annualCost) / monthly.annualCost).toBeLessThan(0.03);
  });

  it('applies dependant loading, group and annual discounts', () => {
    const solo = quotePremium({ planId: 'standard', dependants: 0, frequency: 'annual', sector: 'formal' });
    const family = quotePremium({ planId: 'standard', dependants: 2, frequency: 'annual', sector: 'formal' });
    const group = quotePremium({ planId: 'standard', dependants: 0, frequency: 'annual', sector: 'formal', groupCode: 'techhub-staff' });
    expect(family.installment).toBeCloseTo(solo.installment * 2.2, -2);
    expect(group.groupDiscount).toBe(0.15);
    expect(group.installment).toBeLessThan(solo.installment);
  });

  it('marks vulnerable enrollees as sponsored', () => {
    expect(quotePremium({ planId: 'basic', dependants: 0, frequency: 'quarterly', sector: 'vulnerable' }).payer).toBe('sponsor');
  });

  it('restarts cover from today after a lapse instead of back-filling', () => {
    expect(extendCover('2026-12-01', 7, TODAY)).toBe('2026-12-08');
    expect(extendCover('2026-10-01', 7, TODAY)).toBe('2026-12-02');
  });
});

describe('eligibility', () => {
  it('distinguishes active, grace, waiting and lapsed cover', () => {
    expect(checkEligibility(enrollee(), TODAY).status).toBe('active');
    expect(checkEligibility(enrollee({ paidThrough: '2026-11-23' }), TODAY).status).toBe('grace');
    expect(checkEligibility(enrollee({ paidThrough: '2026-11-01' }), TODAY).status).toBe('lapsed');
    const unpaid = checkEligibility(enrollee({ enrolledOn: '2026-11-26', paidThrough: '2026-11-25' }), TODAY);
    expect(unpaid).toMatchObject({ status: 'unpaid', eligible: false });
    const waiting = checkEligibility(enrollee({ enrolledOn: '2026-11-20' }), TODAY);
    expect(waiting.status).toBe('waiting');
    expect(waiting.emergencyOnly).toBe(true);
  });
});

describe('claims adjudication', () => {
  const ctx = (over: Partial<Parameters<typeof adjudicate>[1]> = {}) => ({
    enrollee: enrollee(),
    provider: ikeja,
    paRequests: [] as PARequest[],
    history: [],
    ...over,
  });

  it('auto-approves a clean primary-care claim instantly', () => {
    const r = adjudicate(draft(), ctx());
    expect(r.status).toBe('approved');
    expect(r.approvedTotal + r.copayTotal).toBe(11000);
    expect(r.copayTotal).toBe(175); // 5% co-pay on drugs on Standard
  });

  it('caps prices at the agreed tariff', () => {
    const r = adjudicate(draft({ lines: [{ tariffCode: 'CON-01', quantity: 1, unitPrice: 9000 }] }), ctx());
    expect(r.status).toBe('partially_approved');
    expect(r.approvedTotal).toBe(5000);
    expect(r.decisions[0].reasons.join()).toMatch(/tariff/);
  });

  it('rejects uncovered services and claims from unaccredited providers', () => {
    const basic = enrollee({ planId: 'basic' });
    const r = adjudicate(draft({ lines: [{ tariffCode: 'DEN-01', quantity: 1, unitPrice: 10000 }] }), ctx({ enrollee: basic }));
    expect(r.status).toBe('rejected');
    const r2 = adjudicate(draft({ providerId: ringRoad.id }), ctx({ provider: ringRoad }));
    expect(r2.status).toBe('rejected');
  });

  it('requires a referral PA code at a secondary hospital, and accepts a valid one', () => {
    const d = draft({ providerId: lagoon.id, lines: [{ tariffCode: 'CON-02', quantity: 1, unitPrice: 12000 }] });
    expect(adjudicate(d, ctx({ provider: lagoon })).status).toBe('rejected');
    const pa: PARequest = {
      code: 'PA-ABC123', enrolleeId: d.enrolleeId, providerId: lagoon.id, hmoId: 'hmo-unity', category: 'consultation',
      description: 'Referral', estimatedCost: 12000, status: 'approved', requestedAt: '2026-11-19T09:00:00Z', expiresAt: '2026-12-03', autoDecided: true,
    };
    expect(adjudicate({ ...d, paCode: 'pa-abc123' }, ctx({ provider: lagoon, paRequests: [pa] })).status).toBe('approved');
  });

  it('a surgery PA also covers the admission that goes with it', () => {
    const d = draft({
      providerId: lagoon.id,
      paCode: 'PA-SURG01',
      lines: [{ tariffCode: 'SUR-01', quantity: 1, unitPrice: 300000 }, { tariffCode: 'ADM-01', quantity: 3, unitPrice: 15000 }],
    });
    const pa: PARequest = {
      code: 'PA-SURG01', enrolleeId: d.enrolleeId, providerId: lagoon.id, hmoId: 'hmo-unity', category: 'surgery',
      description: 'Appendectomy', estimatedCost: 345000, status: 'approved', requestedAt: '2026-11-19T09:00:00Z', expiresAt: '2026-12-03', autoDecided: false,
    };
    const r = adjudicate(d, ctx({ provider: lagoon, paRequests: [pa] }));
    expect(r.decisions.every((x) => x.approved > 0)).toBe(true);
  });

  it('enforces the annual benefit limit', () => {
    const basic = enrollee({ planId: 'basic' });
    const history = [{ ...adjudicate(draft(), ctx({ enrollee: basic })), id: 'C1', ...draft(), hmoId: 'hmo-unity', approvedTotal: 499_000 }];
    const r = adjudicate(draft({ encounterDate: '2026-11-22' }), ctx({ enrollee: basic, history: history as never }));
    expect(r.approvedTotal).toBe(1000);
  });

  it('only pays emergency care during the waiting period', () => {
    const e = enrollee({ enrolledOn: '2026-11-10' });
    const r = adjudicate(
      draft({ lines: [{ tariffCode: 'CON-01', quantity: 1, unitPrice: 5000 }, { tariffCode: 'EMR-01', quantity: 1, unitPrice: 40000 }] }),
      ctx({ enrollee: e }),
    );
    expect(r.decisions[0].approved).toBe(0);
    expect(r.decisions[1].approved).toBe(40000);
  });

  it('holds duplicate bills for human review and lets reviewers reject them', () => {
    const first = { ...adjudicate(draft(), ctx()), id: 'C1', ...draft(), hmoId: 'hmo-unity' };
    const r = adjudicate(draft({ submittedAt: '2026-11-25' }), ctx({ history: [first as never] }));
    expect(r.status).toBe('pending_review');
    expect(r.fraudFlags.map((f) => f.rule)).toContain('DUPLICATE_CLAIM');
    const rejected = reviewClaim({ ...first, ...r, id: 'C2' } as never, 'reject', 'Duplicate', TODAY);
    expect(rejected.status).toBe('rejected');
    expect(rejected.approvedTotal).toBe(0);
  });
});

describe('fraud detection', () => {
  it('flags clinically impossible and padded bills', () => {
    const { flags, riskScore } = detectFraud({
      enrollee: enrollee({ gender: 'male', ninVerified: false }),
      provider: ikeja,
      encounterDate: '2026-11-20',
      submittedAt: '2026-11-21',
      lines: [{ tariffCode: 'MAT-01', quantity: 1, unitPrice: 45000 }, { tariffCode: 'DRG-01', quantity: 9, unitPrice: 9000 }],
      history: [],
    });
    const rules = flags.map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['GENDER_MISMATCH', 'ABOVE_TARIFF', 'QUANTITY_OUTLIER', 'NIN_NOT_VERIFIED']));
    expect(riskScore).toBe(100);
  });
});

describe('pre-authorisation', () => {
  it('issues routine PA codes instantly and routes surgery to a medical officer', () => {
    expect(decidePA({ category: 'imaging', estimatedCost: 15000 }, enrollee(), lagoon, TODAY).status).toBe('approved');
    expect(decidePA({ category: 'surgery', estimatedCost: 300000 }, enrollee(), lagoon, TODAY).status).toBe('pending');
    expect(decidePA({ category: 'surgery', estimatedCost: 300000 }, enrollee({ planId: 'basic' }), lagoon, TODAY).status).toBe('denied');
    expect(decidePA({ category: 'imaging', estimatedCost: 15000 }, enrollee({ paidThrough: '2026-10-01' }), lagoon, TODAY).status).toBe('denied');
  });
});

describe('USSD', () => {
  const people = [enrollee({ phone: '08031234567' })];
  it('works end to end for paying a premium on a feature phone', () => {
    expect(ussd('08031234567', '', people, TODAY).text).toMatch(/Check my cover/);
    expect(ussd('08031234567', '2', people, TODAY).kind).toBe('CON');
    const done = ussd('08031234567', '2*2*1', people, TODAY);
    expect(done.kind).toBe('END');
    expect(done.action).toMatchObject({ type: 'pay', frequency: 'weekly' });
  });
  it('lets unregistered numbers request an enrolment agent', () => {
    expect(ussd('08099999999', '1', people, TODAY).action).toMatchObject({ type: 'callback' });
  });
  it('logs complaints', () => {
    expect(ussd('08031234567', '4*1', people, TODAY).action).toMatchObject({ type: 'complaint', category: 'asked_to_pay' });
  });
});

describe('seed data', () => {
  it('is deterministic and internally consistent', () => {
    const a = generateSeed(TODAY);
    const b = generateSeed(TODAY);
    expect(a).toEqual(b);
    const summary = systemSummary(a, TODAY);
    expect(summary.enrollees).toBe(a.enrollees.length);
    expect(hmoScorecard(a, TODAY)).toHaveLength(3);
    for (const c of a.claims) {
      expect(c.approvedTotal + c.copayTotal).toBeLessThanOrEqual(c.billedTotal);
      expect(a.enrollees.some((e) => e.id === c.enrolleeId)).toBe(true);
    }
    expect(a.enrollees.every((e) => isValidHealthGuardId(e.id))).toBe(true);
  });
});
