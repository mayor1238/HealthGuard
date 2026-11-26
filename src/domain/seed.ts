import { adjudicate, reviewClaim, type ClaimDraft } from './adjudication';
import { HMOS, PLANS, PROVIDERS, hmoById, planById, tariffByCode } from './catalog';
import { decidePA } from './preauth';
import { FREQUENCIES, quotePremium } from './pricing';
import type {
  CapitationPayment,
  Claim,
  ClaimLine,
  Complaint,
  ComplaintCategory,
  Db,
  Enrollee,
  Gender,
  PARequest,
  Payment,
  PaymentFrequency,
  PaymentMethod,
  Sector,
  ServiceCategory,
} from './types';
import { addDays, daysBetween, makeHealthGuardId, mulberry32, randomCode } from './util';

const NAMES: Record<string, { first: [string, Gender][]; last: string[] }> = {
  south_west: {
    first: [['Adebayo', 'male'], ['Funke', 'female'], ['Tunde', 'male'], ['Yetunde', 'female'], ['Segun', 'male'], ['Bisola', 'female'], ['Kunle', 'male'], ['Temitope', 'female']],
    last: ['Adeyemi', 'Ogunleye', 'Balogun', 'Okonjo', 'Adebanjo', 'Oladipo', 'Afolabi'],
  },
  south_east: {
    first: [['Chinedu', 'male'], ['Adaeze', 'female'], ['Emeka', 'male'], ['Ngozi', 'female'], ['Obinna', 'male'], ['Chiamaka', 'female'], ['Ikenna', 'male'], ['Blessing', 'female']],
    last: ['Okafor', 'Eze', 'Nwosu', 'Okeke', 'Obi', 'Nwachukwu', 'Chukwu'],
  },
  north: {
    first: [['Musa', 'male'], ['Aisha', 'female'], ['Ibrahim', 'male'], ['Zainab', 'female'], ['Usman', 'male'], ['Hauwa', 'female'], ['Sani', 'male'], ['Fatima', 'female']],
    last: ['Abdullahi', 'Bello', 'Yusuf', 'Garba', 'Suleiman', 'Lawal', 'Danjuma'],
  },
  south_south: {
    first: [['Ebi', 'male'], ['Ese', 'female'], ['Tamuno', 'male'], ['Ibiere', 'female'], ['Osagie', 'male'], ['Efosa', 'male'], ['Ivie', 'female'], ['Preye', 'female']],
    last: ['Briggs', 'Osagie', 'Igbinedion', 'George', 'Amadi', 'Omoregie', 'Douglas'],
  },
};
const REGION: Record<string, keyof typeof NAMES> = {
  Lagos: 'south_west', Oyo: 'south_west', FCT: 'north', Kano: 'north', Kaduna: 'north', Enugu: 'south_east', Rivers: 'south_south', Edo: 'south_south',
};
const STATE_WEIGHTS: [string, number][] = [['Lagos', 30], ['FCT', 14], ['Kano', 16], ['Oyo', 12], ['Rivers', 9], ['Enugu', 8], ['Kaduna', 8], ['Edo', 3]];

/** Average days each HMO takes to pay — deliberately different so the league table tells a story. */
const HMO_PAY_DAYS: Record<string, number> = { 'hmo-unity': 5, 'hmo-crest': 11, 'hmo-arewa': 24 };

/** The first four generated enrollees are named personas used throughout the demo. */
export const DEMO_PERSONAS = {
  trader: makeHealthGuardId(1),
  rider: makeHealthGuardId(2),
  employee: makeHealthGuardId(3),
  sponsored: makeHealthGuardId(4),
};

export function generateSeed(today: string, seed = 2026): Db {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('');
  const weighted = <T,>(xs: [T, number][]) => {
    let r = rand() * xs.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of xs) if ((r -= w) <= 0) return v;
    return xs[0][0];
  };

  const enrollees: Enrollee[] = [];
  const payments: Payment[] = [];
  let seq = 0;

  const addEnrollee = (e: Omit<Enrollee, 'id'>, method: PaymentMethod) => {
    const id = makeHealthGuardId(++seq);
    const full: Enrollee = { ...e, id };
    enrollees.push(full);
    // Rebuild payment history that ends exactly at paidThrough.
    const q = quotePremium({ planId: e.planId, dependants: e.dependants, frequency: e.frequency, groupCode: e.groupCode, sector: e.sector });
    const step = FREQUENCIES[e.frequency].days;
    const maxPayments = e.frequency === 'daily' ? 20 : 30;
    let cursor = e.paidThrough;
    for (let i = 0; i < maxPayments && daysBetween(e.enrolledOn, addDays(cursor, -step)) >= -1; i++) {
      const paidAt = addDays(cursor, -step);
      payments.push({
        id: `PAY-${id}-${i}`,
        enrolleeId: id,
        amount: q.installment,
        method: e.sector === 'vulnerable' ? 'sponsor' : method,
        paidAt,
        daysCovered: step,
        reference: randomCode('RCPT', rand, 8),
      });
      cursor = paidAt;
    }
    return full;
  };

  const primaryIn = (state: string, hmoId: string) =>
    PROVIDERS.filter((p) => p.state === state && p.level === 'primary' && p.accredited && p.hmoIds.includes(hmoId));

  // --- Named demo personas (first four IDs) --------------------------------------
  const persona = (
    firstName: string, lastName: string, gender: Gender, dob: string, phone: string, state: string, lga: string,
    sector: Sector, planId: string, hmoId: string, providerId: string, dependants: number, enrolledAgo: number,
    paidAhead: number, frequency: PaymentFrequency, method: PaymentMethod, extra: Partial<Enrollee> = {},
  ) =>
    addEnrollee({
      nin: digits(11), firstName, lastName, gender, dateOfBirth: dob, phone, state, lga, sector, planId, hmoId,
      primaryProviderId: providerId, dependants, enrolledOn: addDays(today, -enrolledAgo), paidThrough: addDays(today, paidAhead),
      frequency, ninVerified: true, ...extra,
    }, method);

  persona('Adaeze', 'Okafor', 'female', '1988-03-14', '08031234567', 'Lagos', 'Ikeja', 'informal', 'standard', 'hmo-unity', 'prv-001', 2, 400, 5, 'weekly', 'ussd', { groupCode: 'OSHODI-TRADERS' });
  persona('Musa', 'Abdullahi', 'male', '1992-07-02', '08061234567', 'Kano', 'Fagge', 'informal', 'basic', 'hmo-arewa', 'prv-006', 1, 220, -3, 'daily', 'mobile_money', { groupCode: 'OKADA-COOP' });
  persona('Funke', 'Adeyemi', 'female', '1985-11-20', '08091234567', 'Oyo', 'Ibadan North', 'formal', 'premium', 'hmo-crest', 'prv-008', 3, 700, 200, 'annual', 'bank_transfer', { groupCode: 'TECHHUB-STAFF' });
  persona('Blessing', 'Eze', 'female', '2001-01-09', '07031234567', 'Lagos', 'Surulere', 'vulnerable', 'basic', 'hmo-unity', 'prv-002', 0, 150, 60, 'quarterly', 'sponsor', { sponsor: 'Basic Health Care Provision Fund' });

  // --- Bulk population -----------------------------------------------------------
  for (let i = 0; i < 236; i++) {
    const state = weighted(STATE_WEIGHTS);
    const region = NAMES[REGION[state]];
    const [firstName, gender] = pick(region.first);
    const sector = weighted<Sector>([['informal', 55], ['formal', 33], ['vulnerable', 12]]);
    const hmoId = pick(HMOS).id;
    const prim = primaryIn(state, hmoId);
    const fallback = PROVIDERS.filter((p) => p.level === 'primary' && p.accredited && p.hmoIds.includes(hmoId));
    const provider = pick(prim.length ? prim : fallback);
    const planId = sector === 'vulnerable' ? 'basic' : sector === 'formal' ? weighted([['standard', 60], ['premium', 30], ['basic', 10]]) : weighted([['basic', 60], ['standard', 35], ['premium', 5]]);
    const frequency: PaymentFrequency = sector === 'formal' ? weighted([['monthly', 50], ['annual', 30], ['quarterly', 20]]) : sector === 'vulnerable' ? 'quarterly' : weighted([['daily', 30], ['weekly', 40], ['monthly', 30]]);
    const lapsed = rand() < 0.14;
    addEnrollee({
      nin: digits(11),
      firstName,
      lastName: pick(region.last),
      gender,
      dateOfBirth: `${between(1960, 2005)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
      phone: `080${digits(8)}`,
      state: provider.state,
      lga: provider.lga,
      sector,
      planId,
      hmoId,
      primaryProviderId: provider.id,
      dependants: sector === 'formal' ? between(0, 4) : between(0, 3),
      enrolledOn: addDays(today, -between(40, 720)),
      paidThrough: lapsed ? addDays(today, -between(10, 90)) : addDays(today, between(0, FREQUENCIES[frequency].days + 5)),
      frequency,
      groupCode: sector === 'informal' && rand() < 0.4 ? pick(['OSHODI-TRADERS', 'OKADA-COOP']) : undefined,
      sponsor: sector === 'vulnerable' ? pick(['Basic Health Care Provision Fund', 'State Equity Fund', 'Sponsor-a-Life donor']) : undefined,
      ninVerified: rand() > 0.06,
    }, pick<PaymentMethod>(['card', 'ussd', 'bank_transfer', 'mobile_money', 'agent']));
  }

  // --- PA requests and claims ----------------------------------------------------
  const paRequests: PARequest[] = [];
  const claims: Claim[] = [];
  let claimSeq = 0;

  const issuePA = (e: Enrollee, providerId: string, category: ServiceCategory, description: string, cost: number, on: string): PARequest => {
    const provider = PROVIDERS.find((p) => p.id === providerId)!;
    const d = decidePA({ category, estimatedCost: cost }, e, provider, on);
    // Manual ones in the past were decided by an HMO officer within a day.
    const status = d.status === 'pending' ? 'approved' : d.status;
    const pa: PARequest = {
      code: randomCode('PA', rand),
      enrolleeId: e.id,
      providerId,
      hmoId: e.hmoId,
      category,
      description,
      estimatedCost: cost,
      status,
      requestedAt: on + 'T09:00:00Z',
      decidedAt: on + (d.status === 'pending' ? 'T16:30:00Z' : 'T09:00:02Z'),
      expiresAt: status === 'approved' ? addDays(on, 14) : undefined,
      autoDecided: d.status !== 'pending',
      note: d.note,
    };
    paRequests.push(pa);
    return pa;
  };

  type Scenario = { dx: string; lines: [string, number][]; pa?: [ServiceCategory, string]; female?: boolean; secondary?: boolean };
  const SCENARIOS: [Scenario, number][] = [
    [{ dx: 'B54 Malaria, unspecified', lines: [['CON-01', 1], ['LAB-01', 1], ['DRG-01', 1], ['DRG-03', 1]] }, 30],
    [{ dx: 'A01.0 Typhoid fever', lines: [['CON-01', 1], ['LAB-04', 1], ['LAB-02', 1], ['DRG-02', 1]] }, 12],
    [{ dx: 'J06.9 Upper respiratory tract infection', lines: [['CON-01', 1], ['DRG-02', 1], ['DRG-03', 1]] }, 14],
    [{ dx: 'I10 Essential hypertension', lines: [['CON-01', 1], ['DRG-04', 1]] }, 10],
    [{ dx: 'E11.9 Type 2 diabetes', lines: [['CON-01', 1], ['DRG-05', 1], ['LAB-03', 1]] }, 8],
    [{ dx: 'N39.0 Urinary tract infection', lines: [['CON-01', 1], ['LAB-03', 1], ['DRG-02', 1]] }, 6],
    [{ dx: 'Z34.9 Supervision of normal pregnancy', lines: [['CON-01', 1], ['MAT-01', 1]], pa: ['maternity', 'Antenatal care package'], female: true }, 6],
    [{ dx: 'O80 Normal delivery', lines: [['MAT-02', 1], ['ADM-01', 2]], pa: ['maternity', 'Delivery'], female: true, secondary: true }, 4],
    [{ dx: 'K35.8 Acute appendicitis', lines: [['CON-02', 1], ['SUR-01', 1], ['ADM-01', 3], ['DRG-02', 1]], pa: ['surgery', 'Appendectomy'], secondary: true }, 3],
    [{ dx: 'K02.9 Dental caries', lines: [['DEN-01', 1]] }, 3],
  ];

  const commit = (draft: ClaimDraft, e: Enrollee, extra: Partial<Claim> = {}) => {
    const provider = PROVIDERS.find((p) => p.id === draft.providerId)!;
    const r = adjudicate(draft, { enrollee: e, provider, paRequests, history: claims });
    let claim: Claim = {
      id: `CLM-${String(++claimSeq).padStart(5, '0')}`,
      ...draft,
      hmoId: e.hmoId,
      status: r.status,
      decisions: r.decisions,
      fraudFlags: r.fraudFlags,
      riskScore: r.riskScore,
      billedTotal: r.billedTotal,
      approvedTotal: r.approvedTotal,
      copayTotal: r.copayTotal,
      decidedAt: draft.submittedAt,
      ...extra,
    };
    if (draft.paCode) {
      const pa = paRequests.find((p) => p.code === draft.paCode);
      if (pa && pa.status === 'approved' && claim.status !== 'rejected') pa.status = 'used';
    }
    // Settle according to each HMO's payment behaviour.
    const age = daysBetween(claim.submittedAt, today);
    if (claim.status === 'pending_review' && age > 10) {
      const high = claim.fraudFlags.find((f) => f.severity === 'high');
      claim = reviewClaim(claim, high ? 'reject' : 'approve', high ? high.detail : 'Cleared by medical reviewer.', addDays(claim.submittedAt, between(2, 6)));
    }
    if (claim.status === 'approved' || claim.status === 'partially_approved') {
      const delay = Math.max(1, Math.round(HMO_PAY_DAYS[claim.hmoId] * (0.5 + rand())));
      if (delay <= age) claim.paidAt = addDays(claim.submittedAt, delay);
      if (claim.paidAt) claim.status = 'paid';
    }
    claims.push(claim);
    return claim;
  };

  const eligiblePool = enrollees.filter((e) => daysBetween(addDays(e.enrolledOn, planById(e.planId).waitingPeriodDays), today) > 10);
  for (let i = 0; i < 420; i++) {
    const e = i < 6 ? enrollees[i % 4] : pick(eligiblePool);
    const plan = planById(e.planId);
    let sc = weighted(SCENARIOS);
    if (sc.female && e.gender !== 'female') sc = SCENARIOS[0][0];
    if (sc.pa && !plan.benefits[sc.pa[0]].covered) sc = SCENARIOS[2][0];
    if (!plan.benefits.dental.covered && sc.lines[0][0] === 'DEN-01') sc = SCENARIOS[0][0];

    const start = addDays(e.enrolledOn, plan.waitingPeriodDays + 1);
    const windowStart = daysBetween(start, addDays(today, -150)) > 0 ? addDays(today, -150) : start;
    const lastCovered = daysBetween(e.paidThrough, today) > 0 ? e.paidThrough : addDays(today, -1);
    const span = Math.max(0, daysBetween(windowStart, lastCovered));
    const encounterDate = addDays(windowStart, between(0, span));
    const submittedAt = addDays(encounterDate, between(0, 3));
    if (daysBetween(submittedAt, today) < 0) continue;

    let providerId = e.primaryProviderId;
    let paCode: string | undefined;
    if (sc.secondary) {
      const sec = PROVIDERS.find((p) => p.level !== 'primary' && p.state === e.state && p.hmoIds.includes(e.hmoId) && p.accredited);
      if (sec) providerId = sec.id;
    }
    if (sc.pa) {
      const cost = sc.lines.reduce((s, [c, q]) => s + tariffByCode(c)!.price * q, 0);
      paCode = issuePA(e, providerId, sc.pa[0], sc.pa[1], cost, addDays(encounterDate, -1)).code;
    }

    const upcode = rand() < 0.08;
    const lines: ClaimLine[] = sc.lines.map(([code, qty]) => ({
      tariffCode: code,
      quantity: qty,
      unitPrice: Math.round(tariffByCode(code)!.price * (upcode ? 1.3 + rand() * 0.6 : 1)),
    }));
    commit({ enrolleeId: e.id, providerId, encounterDate, submittedAt, diagnosis: sc.dx, paCode, lines }, e);
  }

  // --- Deliberate fraud patterns so reviewers have something to catch -----------------
  // Duplicate bills: a few recent ones still in the review queue, older ones already rejected.
  const recent = claims.filter((c) => daysBetween(c.submittedAt, today) <= 12 && c.status !== 'rejected').slice(0, 4);
  const older = claims.filter((c) => daysBetween(c.submittedAt, today) > 40 && c.status !== 'rejected').slice(0, 5);
  for (const c of [...recent, ...older]) {
    const e = enrollees.find((x) => x.id === c.enrolleeId)!;
    const { enrolleeId, providerId, encounterDate, diagnosis, paCode } = c;
    const submittedAt = recent.includes(c) ? today : addDays(c.submittedAt, between(3, 9));
    commit({ enrolleeId, providerId, encounterDate, diagnosis, paCode, submittedAt, lines: c.lines.map((l) => ({ ...l })) }, e);
  }
  const males = eligiblePool.filter((e) => e.gender === 'male' && daysBetween(e.paidThrough, today) < 0).slice(0, 2);
  for (const e of males) {
    commit(
      { enrolleeId: e.id, providerId: e.primaryProviderId, encounterDate: addDays(today, -2), submittedAt: addDays(today, -1), diagnosis: 'Z34.9 Supervision of normal pregnancy', lines: [{ tariffCode: 'CON-01', quantity: 1, unitPrice: 5000 }, { tariffCode: 'MAT-01', quantity: 1, unitPrice: 45000 }] },
      e,
    );
  }
  const padder = eligiblePool.find((e) => e.state === 'Lagos' && daysBetween(today, e.paidThrough) > 3);
  if (padder) {
    commit(
      { enrolleeId: padder.id, providerId: padder.primaryProviderId, encounterDate: addDays(today, -3), submittedAt: addDays(today, -2), diagnosis: 'B54 Malaria, unspecified', lines: [{ tariffCode: 'CON-01', quantity: 1, unitPrice: 9000 }, { tariffCode: 'DRG-01', quantity: 9, unitPrice: 6000 }, { tariffCode: 'LAB-02', quantity: 5, unitPrice: 6000 }] },
      padder,
    );
  }

  // --- Open PA requests waiting for the HMO ----------------------------------------
  const sec = enrollees.filter((e) => e.planId !== 'basic' && daysBetween(today, e.paidThrough) > 0).slice(5, 9);
  sec.forEach((e, i) => {
    const provider = PROVIDERS.find((p) => p.level !== 'primary' && p.hmoIds.includes(e.hmoId) && p.state === e.state) ?? PROVIDERS.find((p) => p.level !== 'primary' && p.hmoIds.includes(e.hmoId))!;
    paRequests.push({
      code: randomCode('PA', rand),
      enrolleeId: e.id,
      providerId: provider.id,
      hmoId: e.hmoId,
      category: 'surgery',
      description: i % 2 ? 'Inguinal hernia repair' : 'Appendectomy',
      estimatedCost: i % 2 ? 250_000 : 330_000,
      status: 'pending',
      requestedAt: addDays(today, -(i % 2)) + 'T08:15:00Z',
      autoDecided: false,
      note: 'Sent to HMO medical officer — decision due within 24 hours.',
    });
  });

  // --- Complaints -----------------------------------------------------------------
  const complaints: Complaint[] = [];
  const COMPLAINT_TEXT: [ComplaintCategory, string][] = [
    ['asked_to_pay', 'Clinic asked me to pay ₦8,000 for malaria drugs even though they are covered.'],
    ['denied_service', 'Told the "NHIA patients" desk was closed and to come back next week.'],
    ['drug_unavailable', 'Pharmacy said my hypertension drugs are out of stock for 3 weeks.'],
    ['long_wait', 'Waited 6 hours before being seen.'],
    ['poor_attitude', 'Nurse was rude because I am on insurance.'],
    ['claim_dispute', 'My visit history shows a visit I never made.'],
  ];
  for (let i = 0; i < 34; i++) {
    const e = i === 0 ? enrollees[0] : pick(enrollees);
    const [category, description] = pick(COMPLAINT_TEXT);
    const ago = between(0, 60);
    const resolved = ago > 3 && rand() < (e.hmoId === 'hmo-arewa' ? 0.45 : 0.85);
    const escalated = !resolved && ago > 2;
    complaints.push({
      id: `CMP-${String(i + 1).padStart(4, '0')}`,
      enrolleeId: e.id,
      providerId: e.primaryProviderId,
      hmoId: e.hmoId,
      category,
      description,
      status: resolved ? 'resolved' : escalated ? 'escalated' : 'open',
      createdAt: addDays(today, -ago) + 'T10:00:00Z',
      resolvedAt: resolved ? addDays(today, -ago + between(1, 3)) + 'T12:00:00Z' : undefined,
      resolution: resolved ? 'Provider contacted; enrollee refunded / served. Provider warned.' : undefined,
      channel: rand() < 0.35 ? 'ussd' : 'app',
    });
  }

  // --- Capitation for the last 3 months --------------------------------------------
  const capitation: CapitationPayment[] = [];
  const rates = Object.fromEntries(PLANS.map((p) => [p.id, p.capitationRate]));
  for (let m = 2; m >= 0; m--) {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - m);
    const month = d.toISOString().slice(0, 7);
    for (const p of PROVIDERS.filter((x) => x.level === 'primary' && x.accredited)) {
      for (const h of p.hmoIds) {
        const list = enrollees.filter((e) => e.primaryProviderId === p.id && e.hmoId === h);
        if (!list.length) continue;
        const lives = list.reduce((s, e) => s + 1 + e.dependants, 0);
        const amount = list.reduce((s, e) => s + rates[e.planId] * (1 + e.dependants), 0);
        const lateHmo = h === 'hmo-arewa';
        const paid = m > 0 && !(lateHmo && m === 1);
        capitation.push({
          id: `CAP-${p.id}-${h}-${month}`,
          providerId: p.id,
          hmoId: h,
          month,
          lives,
          amount,
          paidAt: paid ? `${month}-${lateHmo ? '20' : '05'}` : undefined,
        });
      }
    }
  }

  // Sanity: every HMO referenced exists.
  claims.forEach((c) => hmoById(c.hmoId));
  return { enrollees, payments, claims, paRequests, complaints, capitation };
}
