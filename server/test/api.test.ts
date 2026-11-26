import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PERSONAS } from '../../src/domain/seed';
import { escalateOverdueComplaints } from '../services/care';
import { setup, type Harness } from './helpers';

const TRADER = DEMO_PERSONAS.trader; // Adaeze, Lagos, Standard, Unity HMO, Ikeja Family Clinic
const TRADER_PHONE = '08031234567';
const V1 = '/api/v1';

let h: Harness;
let provider: string;
let unity: string;
let arewa: string;
let regulator: string;
let trader: string;

beforeAll(async () => {
  h = await setup();
  [provider, unity, arewa, regulator, trader] = await Promise.all([
    h.loginAs('prv-001', 'demo-provider'),
    h.loginAs('hmo-unity', 'demo-hmo'),
    h.loginAs('hmo-arewa', 'demo-hmo'),
    h.loginAs('regulator', 'demo-regulator'),
    h.loginAs(TRADER_PHONE, '123456'),
  ]);
}, 60_000);
afterAll(() => h?.close());

const malaria = (over: Record<string, unknown> = {}) => ({
  enrolleeId: TRADER,
  encounterDate: '2026-11-26',
  diagnosis: 'B54 Malaria, unspecified',
  lines: [
    { tariffCode: 'CON-01', quantity: 1, unitPrice: 5000 },
    { tariffCode: 'LAB-01', quantity: 1, unitPrice: 2500 },
  ],
  ...over,
});

describe('platform', () => {
  it('reports health and sets security headers', async () => {
    const r = await h.app.inject({ url: '/healthz' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('migrations are idempotent', async () => {
    const { migrate } = await import('../db/migrations');
    expect(await migrate(h.sql)).toEqual([]);
  });

  it('serves the catalogue publicly', async () => {
    const r = await h.call('GET', `${V1}/catalog`);
    expect(r.status).toBe(200);
    expect(r.body.plans).toHaveLength(3);
    expect(JSON.stringify(r.body)).not.toContain('OSHODI-TRADERS'); // group codes are not published
  });

  it('quotes premiums', async () => {
    const r = await h.call('POST', `${V1}/quotes`, { planId: 'basic', dependants: 0, frequency: 'daily', sector: 'informal' });
    expect(r.body.installment).toBeLessThan(150);
  });
});

describe('authentication & authorisation', () => {
  it('rejects bad credentials without revealing which part was wrong', async () => {
    const a = await h.call('POST', `${V1}/auth/login`, { username: 'prv-001', password: 'nope' });
    const b = await h.call('POST', `${V1}/auth/login`, { username: 'nobody', password: 'nope' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it('requires a valid token and the right role', async () => {
    expect((await h.call('GET', `${V1}/member/profile`)).status).toBe(401);
    expect((await h.call('GET', `${V1}/member/profile`, undefined, provider + 'x')).status).toBe(401);
    expect((await h.call('GET', `${V1}/hmo/overview`, undefined, provider)).status).toBe(403);
    expect((await h.call('GET', `${V1}/regulator/summary`, undefined, unity)).status).toBe(403);
    expect((await h.call('GET', `${V1}/auth/me`, undefined, trader)).body.principal).toMatchObject({ role: 'member', enrolleeId: TRADER });
  });

  it('lets a disabled account stop working immediately', async () => {
    const tok = await h.loginAs('prv-002', 'demo-provider');
    await h.sql.query(`UPDATE users SET disabled = TRUE WHERE username = 'prv-002'`);
    expect((await h.call('GET', `${V1}/provider/claims`, undefined, tok)).status).toBe(401);
  });
});

describe('enrolment and premium payments', () => {
  const person = {
    firstName: 'Kemi',
    lastName: 'Ade',
    gender: 'female',
    dateOfBirth: '1995-05-05',
    phone: '+2348151112222',
    nin: '22233344455',
    state: 'Lagos',
    sector: 'informal',
    planId: 'basic',
    hmoId: 'hmo-unity',
    primaryProviderId: 'prv-001',
    dependants: 1,
    frequency: 'weekly',
    method: 'mobile_money',
    groupCode: 'oshodi-traders',
    pin: '246810',
  };
  let reference: string;
  let amount: number;
  let kemi: string;

  it('enrols a member with no cover until the first payment is confirmed', async () => {
    const r = await h.call('POST', `${V1}/enrolments`, person);
    expect(r.status).toBe(201);
    expect(r.body.enrollee.phone).toBe('08151112222');
    expect(r.body.enrollee.nin).toBe('*******4455');
    expect(r.body.enrollee.groupCode).toBe('OSHODI-TRADERS');
    expect(r.body.payment.status).toBe('pending');
    ({ reference, amount } = r.body.payment);
    kemi = await h.loginAs('08151112222', '246810');
    const p = await h.call('GET', `${V1}/member/profile`, undefined, kemi);
    expect(p.body.eligibility.eligible).toBe(false);
  });

  it('never stores the NIN in clear', async () => {
    const rows = await h.sql.query<Record<string, unknown>>(`SELECT * FROM enrollees WHERE phone = '08151112222'`);
    expect(JSON.stringify(rows)).not.toContain('22233344455');
  });

  it('blocks duplicate NINs and phone numbers', async () => {
    expect((await h.call('POST', `${V1}/enrolments`, { ...person, phone: '08151110000' })).status).toBe(409);
    expect((await h.call('POST', `${V1}/enrolments`, { ...person, nin: '99988877766' })).status).toBe(409);
  });

  it('validates input', async () => {
    const r = await h.call('POST', `${V1}/enrolments`, { ...person, nin: '123', pin: '12' });
    expect(r.status).toBe(400);
    expect(r.body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['nin', 'pin']));
    expect((await h.call('POST', `${V1}/enrolments`, { ...person, phone: '08151113333', nin: '11122233344', primaryProviderId: 'prv-003' })).status).toBe(400);
  });

  it('rejects unsigned or tampered payment webhooks', async () => {
    expect((await h.webhook({ reference, status: 'success', amount }, 'wrong-secret')).statusCode).toBe(401);
    const r = await h.app.inject({ method: 'POST', url: `${V1}/webhooks/payments`, payload: { reference, status: 'success', amount } });
    expect(r.statusCode).toBe(401);
  });

  it('rejects a payment for the wrong amount', async () => {
    expect((await h.webhook({ reference, status: 'success', amount: amount - 1 })).statusCode).toBe(400);
  });

  it('starts cover on a signed confirmation, and ignores gateway retries', async () => {
    const first = await h.webhook({ reference, status: 'success', amount });
    expect(first.statusCode).toBe(200);
    expect(first.json().changed).toBe(true);
    const p1 = await h.call('GET', `${V1}/member/profile`, undefined, kemi);
    expect(p1.body.eligibility.status).toBe('waiting'); // new members: emergencies only for 30 days
    const retry = await h.webhook({ reference, status: 'success', amount });
    expect(retry.json().changed).toBe(false);
    const p2 = await h.call('GET', `${V1}/member/profile`, undefined, kemi);
    expect(p2.body.enrollee.paidThrough).toBe(p1.body.enrollee.paidThrough);
  });

  it('starts sponsored cover immediately', async () => {
    const r = await h.call('POST', `${V1}/enrolments`, { ...person, phone: '07012345678', nin: '55566677788', sector: 'vulnerable', groupCode: undefined });
    expect(r.status).toBe(201);
    expect(r.body.payment).toMatchObject({ method: 'sponsor', status: 'confirmed' });
  });

  it('lets a member pay a premium (via the gateway)', async () => {
    const before = (await h.call('GET', `${V1}/member/profile`, undefined, trader)).body.enrollee.paidThrough;
    const init = await h.call('POST', `${V1}/member/payments`, { frequency: 'monthly', method: 'card' }, trader);
    expect(init.status).toBe(201);
    await h.webhook({ reference: init.body.reference, status: 'success', amount: init.body.amount });
    const after = (await h.call('GET', `${V1}/member/profile`, undefined, trader)).body.enrollee.paidThrough;
    expect(after > before).toBe(true);
    const history = (await h.call('GET', `${V1}/member/payments`, undefined, trader)).body as { paidAt?: string }[];
    const dates = history.map((p) => p.paidAt ?? '9999');
    expect(dates).toEqual([...dates].sort().reverse()); // newest first
  });
});

describe('front desk, PA codes and claims', () => {
  it('finds a member by ID, phone or NIN and catches mistyped IDs', async () => {
    const byId = await h.call('GET', `${V1}/provider/eligibility?q=${TRADER}`, undefined, provider);
    expect(byId.body).toMatchObject({ id: TRADER, contractedWithHmo: true, isPrimaryProvider: true });
    expect(byId.body.phone).toBeUndefined();
    expect((await h.call('GET', `${V1}/provider/eligibility?q=${TRADER_PHONE}`, undefined, provider)).body.id).toBe(TRADER);
    expect((await h.call('GET', `${V1}/provider/eligibility?q=22233344455`, undefined, provider)).body.firstName).toBe('Kemi');
    expect((await h.call('GET', `${V1}/provider/eligibility?q=HG-00000019`, undefined, provider)).status).toBe(400);
  });

  it('logs who looked up a patient', async () => {
    const log = await h.call('GET', `${V1}/regulator/audit?entityType=enrollee&entityId=${TRADER}`, undefined, regulator);
    expect(log.body.some((e: { action: string }) => e.action === 'member.looked_up')).toBe(true);
  });

  it('previews without saving, then auto-approves a clean claim', async () => {
    const before = (await h.call('GET', `${V1}/provider/claims?limit=500`, undefined, provider)).body.length;
    const pv = await h.call('POST', `${V1}/provider/claims/preview`, malaria(), provider);
    expect(pv.body.status).toBe('approved');
    expect((await h.call('GET', `${V1}/provider/claims?limit=500`, undefined, provider)).body.length).toBe(before);
    const c = await h.call('POST', `${V1}/provider/claims`, malaria(), provider);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: 'approved', approvedTotal: 7500, hmoId: 'hmo-unity' });
  });

  it('holds a duplicate bill for review', async () => {
    const c = await h.call('POST', `${V1}/provider/claims`, malaria(), provider);
    expect(c.body.status).toBe('pending_review');
    expect(c.body.fraudFlags.map((f: { rule: string }) => f.rule)).toContain('DUPLICATE_CLAIM');
  });

  it('rejects future dates and unknown tariff codes', async () => {
    expect((await h.call('POST', `${V1}/provider/claims`, malaria({ encounterDate: '2026-12-25' }), provider)).status).toBe(400);
    expect((await h.call('POST', `${V1}/provider/claims`, malaria({ lines: [{ tariffCode: 'XXX', quantity: 1, unitPrice: 1 }] }), provider)).status).toBe(400);
  });

  it('serialises concurrent claims for the same member, so duplicates cannot slip through', async () => {
    const body = malaria({ encounterDate: '2026-11-25', lines: [{ tariffCode: 'LAB-02', quantity: 1, unitPrice: 6000 }] });
    const [a, b] = await Promise.all([h.call('POST', `${V1}/provider/claims`, body, provider), h.call('POST', `${V1}/provider/claims`, body, provider)]);
    expect([a.body.status, b.body.status].sort()).toEqual(['approved', 'pending_review']);
  });

  it('issues routine PA codes instantly and routes surgery to the HMO', async () => {
    const lagoon = await h.loginAs('prv-003', 'demo-provider');
    const xray = await h.call('POST', `${V1}/provider/pa-requests`, { enrolleeId: TRADER, category: 'imaging', description: 'Chest X-ray', estimatedCost: 15000 }, lagoon);
    expect(xray.body).toMatchObject({ status: 'approved', autoDecided: true });

    const surgery = await h.call('POST', `${V1}/provider/pa-requests`, { enrolleeId: TRADER, category: 'surgery', description: 'Appendectomy', estimatedCost: 345000 }, lagoon);
    expect(surgery.body.status).toBe('pending');
    expect((await h.call('POST', `${V1}/hmo/pa-requests/${surgery.body.code}/decision`, { approve: true, note: 'ok' }, arewa)).status).toBe(404);
    const ok = await h.call('POST', `${V1}/hmo/pa-requests/${surgery.body.code}/decision`, { approve: true, note: 'Clinically indicated' }, unity);
    expect(ok.body.status).toBe('approved');
    expect((await h.call('POST', `${V1}/hmo/pa-requests/${surgery.body.code}/decision`, { approve: false, note: 'x' }, unity)).status).toBe(409);

    const claim = await h.call(
      'POST',
      `${V1}/provider/claims`,
      {
        enrolleeId: TRADER,
        encounterDate: '2026-11-26',
        diagnosis: 'K35.8 Acute appendicitis',
        paCode: surgery.body.code.toLowerCase(),
        lines: [
          { tariffCode: 'SUR-01', quantity: 1, unitPrice: 300000 },
          { tariffCode: 'ADM-01', quantity: 3, unitPrice: 15000 },
        ],
      },
      lagoon,
    );
    expect(claim.body.status).toBe('approved');
    const pas = await h.call('GET', `${V1}/provider/pa-requests`, undefined, lagoon);
    expect(pas.body.find((p: { code: string }) => p.code === surgery.body.code).status).toBe('used');
  });
});

describe('member verification, HMO review and payment', () => {
  let disputed: string;

  it('shows members every bill in their name and lets them dispute one', async () => {
    const mine = await h.call('GET', `${V1}/member/claims`, undefined, trader);
    const target = mine.body.find((c: { status: string; enrolleeConfirmation?: string }) => c.status === 'approved' && !c.enrolleeConfirmation);
    disputed = target.id;
    const r = await h.call('POST', `${V1}/member/claims/${disputed}/response`, { answer: 'disputed' }, trader);
    expect(r.body).toMatchObject({ status: 'pending_review', enrolleeConfirmation: 'disputed' });
    expect((await h.call('POST', `${V1}/member/claims/${disputed}/response`, { answer: 'confirmed' }, trader)).status).toBe(409);
  });

  it("does not let a member touch someone else's claim", async () => {
    const rider = await h.loginAs('08061234567', '123456');
    expect((await h.call('POST', `${V1}/member/claims/${disputed}/response`, { answer: 'confirmed' }, rider)).status).toBe(404);
  });

  it('lets only the owning HMO review a held claim', async () => {
    expect((await h.call('POST', `${V1}/hmo/claims/${disputed}/review`, { verdict: 'approve', note: 'x' }, arewa)).status).toBe(404);
    const r = await h.call('POST', `${V1}/hmo/claims/${disputed}/review`, { verdict: 'reject', note: 'Member did not attend' }, unity);
    expect(r.body).toMatchObject({ status: 'rejected', approvedTotal: 0 });
    expect((await h.call('POST', `${V1}/hmo/claims/${disputed}/review`, { verdict: 'approve', note: 'x' }, unity)).status).toBe(409);
  });

  it('pays approved claims in a batch exactly once', async () => {
    const payable = (await h.call('GET', `${V1}/hmo/claims?queue=payable`, undefined, unity)).body;
    expect(payable.length).toBeGreaterThan(0);
    const ids = payable.slice(0, 3).map((c: { id: string }) => c.id);
    const r = await h.call('POST', `${V1}/hmo/claim-payments`, { claimIds: [...ids, disputed] }, unity);
    expect(r.body.paid).toEqual(ids);
    expect(r.body.skipped).toEqual([{ id: disputed, reason: 'status is rejected' }]);
    const again = await h.call('POST', `${V1}/hmo/claim-payments`, { claimIds: ids }, unity);
    expect(again.body.paid).toEqual([]);
    expect(again.body.total).toBe(0);
  });
});

describe('complaints and escalation', () => {
  let id: string;
  it('lets members complain and escalates if the HMO ignores it for 48 hours', async () => {
    const r = await h.call('POST', `${V1}/member/complaints`, { category: 'asked_to_pay', description: 'Asked for ₦8,000' }, trader);
    expect(r.status).toBe(201);
    id = r.body.id;
    expect(await escalateOverdueComplaints(h.ctx)).not.toContain(id);
    h.advance(49);
    expect(await escalateOverdueComplaints(h.ctx)).toContain(id);
    // Old tokens have expired (8h lifetime) — prove it, then sign in again.
    expect((await h.call('GET', `${V1}/regulator/summary`, undefined, regulator)).status).toBe(401);
    [regulator, unity, arewa, provider, trader] = await Promise.all([
      h.loginAs('regulator', 'demo-regulator'),
      h.loginAs('hmo-unity', 'demo-hmo'),
      h.loginAs('hmo-arewa', 'demo-hmo'),
      h.loginAs('prv-001', 'demo-provider'),
      h.loginAs(TRADER_PHONE, '123456'),
    ]);
    const reg = await h.call('GET', `${V1}/regulator/complaints?status=escalated`, undefined, regulator);
    expect(reg.body.map((c: { id: string }) => c.id)).toContain(id);
  });

  it('lets the HMO resolve it', async () => {
    const r = await h.call('POST', `${V1}/hmo/complaints/${id}/resolve`, { resolution: 'Refunded; clinic warned' }, unity);
    expect(r.body.status).toBe('resolved');
  });
});

describe('capitation', () => {
  it('calculates and pays capitation exactly once', async () => {
    const run = await h.call('POST', `${V1}/hmo/capitation/runs`, { month: '2026-12' }, unity);
    expect(run.body.length).toBeGreaterThan(0);
    const row = run.body.find((c: { providerId: string }) => c.providerId === 'prv-001');
    expect(row.lives).toBeGreaterThan(0);
    expect((await h.call('POST', `${V1}/hmo/capitation/${row.id}/pay`, undefined, unity)).body.paidAt).toBeTruthy();
    expect((await h.call('POST', `${V1}/hmo/capitation/${row.id}/pay`, undefined, unity)).status).toBe(409);
    expect((await h.call('POST', `${V1}/hmo/capitation/${row.id}/pay`, undefined, arewa)).status).toBe(404);
    const mine = await h.call('GET', `${V1}/provider/capitation`, undefined, provider);
    expect(mine.body.some((c: { id: string }) => c.id === row.id)).toBe(true);
  });
});

describe('USSD', () => {
  const dial = (phone: string, text: string) =>
    h.app.inject({ method: 'POST', url: `${V1}/ussd`, payload: new URLSearchParams({ sessionId: 's1', phoneNumber: phone, text }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  it('serves the menu and checks cover', async () => {
    expect((await dial('+2348031234567', '')).body).toMatch(/^CON Welcome Adaeze/);
    expect((await dial('+2348031234567', '1')).body).toMatch(/^END HealthGuard Standard/);
  });

  it('starts a mobile-money payment that the gateway then confirms', async () => {
    const r = await dial('+2348031234567', '2*1*1');
    expect(r.body).toMatch(/^END Approve the N/);
    const pending = await h.sql.query<{ reference: string; amount: number }>(`SELECT reference, amount FROM payments WHERE method = 'ussd' AND status = 'pending'`);
    expect(pending).toHaveLength(1);
  });

  it('records call-back requests from unregistered numbers', async () => {
    await dial('+2348099990000', '1');
    const rows = await h.sql.query(`SELECT * FROM enrolment_callbacks WHERE phone = '08099990000'`);
    expect(rows).toHaveLength(1);
  });
});

describe('regulator', () => {
  it('sees scheme-wide numbers and an audit trail', async () => {
    const r = await h.call('GET', `${V1}/regulator/summary`, undefined, regulator);
    expect(r.body.summary.enrollees).toBeGreaterThan(240);
    expect(r.body.hmos).toHaveLength(3);
    const audit = await h.call('GET', `${V1}/regulator/audit?entityType=claim&limit=5`, undefined, regulator);
    expect(audit.body.length).toBeGreaterThan(0);
  });

  it('publishes HMO performance for people choosing an HMO', async () => {
    const r = await h.call('GET', `${V1}/hmos/performance`);
    expect(r.body).toHaveLength(3);
    expect(r.body[0]).not.toHaveProperty('premiums');
  });
});
