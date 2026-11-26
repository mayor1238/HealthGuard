import { HMOS, STATES, hmoById } from './catalog';
import { checkEligibility } from './pricing';
import type { Claim, Db, Enrollee } from './types';
import { daysBetween } from './util';

/** Lapsed or never-paid members don't count as covered (and earn clinics no capitation). */
export const hasCover = (e: Enrollee, today: string) => {
  const s = checkEligibility(e, today).status;
  return s !== 'lapsed' && s !== 'unpaid';
};

export const isSettled = (c: Claim) => c.status === 'paid';
export const isAwaitingPayment = (c: Claim) => c.status === 'approved' || c.status === 'partially_approved';

/** Days a claim has been (or was) waiting for payment. */
export const claimAgeDays = (c: Claim, today: string) => daysBetween(c.submittedAt, c.paidAt ?? today);

export const isOverdue = (c: Claim, today: string) =>
  (isAwaitingPayment(c) || c.status === 'pending_review') && claimAgeDays(c, today) > hmoById(c.hmoId).claimsSlaDays;

export interface HmoScore {
  hmoId: string;
  name: string;
  enrollees: number;
  activeEnrollees: number;
  /** Premiums, claims and capitation are all for the last MLR_WINDOW_DAYS days. */
  premiums: number;
  claimsPaid: number;
  capitationPaid: number;
  /** (claims + capitation) / premiums. Very low ratios suggest providers are being underpaid. */
  medicalLossRatio: number;
  avgDaysToPay: number;
  paidWithinSla: number;
  overdueClaims: number;
  complaintsPer1000: number;
  complaintResolution: number;
  paAutoRate: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const ratio = (a: number, b: number) => (b ? a / b : 0);

/** Window for financial ratios, so premiums and claims cover the same period. */
export const MLR_WINDOW_DAYS = 90;

export function hmoScorecard(db: Db, today: string): HmoScore[] {
  const inWindow = (d?: string) => !!d && daysBetween(d, today) >= 0 && daysBetween(d, today) < MLR_WINDOW_DAYS;
  return HMOS.map((h) => {
    const enrollees = db.enrollees.filter((e) => e.hmoId === h.id);
    const ids = new Set(enrollees.map((e) => e.id));
    const claims = db.claims.filter((c) => c.hmoId === h.id);
    const paid = claims.filter(isSettled);
    const premiums = db.payments.filter((p) => ids.has(p.enrolleeId) && inWindow(p.paidAt)).reduce((s, p) => s + p.amount, 0);
    const claimsPaid = paid.filter((c) => inWindow(c.paidAt)).reduce((s, c) => s + c.approvedTotal, 0);
    const capitationPaid = db.capitation.filter((c) => c.hmoId === h.id && inWindow(c.paidAt)).reduce((s, c) => s + c.amount, 0);
    const complaints = db.complaints.filter((c) => c.hmoId === h.id);
    const pas = db.paRequests.filter((p) => p.hmoId === h.id);
    return {
      hmoId: h.id,
      name: h.name,
      enrollees: enrollees.length,
      activeEnrollees: enrollees.filter((e) => hasCover(e, today)).length,
      premiums,
      claimsPaid,
      capitationPaid,
      medicalLossRatio: ratio(claimsPaid + capitationPaid, premiums),
      avgDaysToPay: avg(paid.map((c) => claimAgeDays(c, today))),
      paidWithinSla: ratio(paid.filter((c) => claimAgeDays(c, today) <= h.claimsSlaDays).length, paid.length),
      overdueClaims: claims.filter((c) => isOverdue(c, today)).length,
      complaintsPer1000: ratio(complaints.length * 1000, enrollees.length),
      complaintResolution: ratio(complaints.filter((c) => c.status === 'resolved').length, complaints.length),
      paAutoRate: ratio(pas.filter((p) => p.autoDecided).length, pas.length),
    };
  });
}

export function systemSummary(db: Db, today: string) {
  const bySector = { formal: 0, informal: 0, vulnerable: 0 };
  const byState: Record<string, number> = Object.fromEntries(STATES.map((s) => [s, 0]));
  let active = 0;
  for (const e of db.enrollees) {
    bySector[e.sector]++;
    byState[e.state] = (byState[e.state] ?? 0) + 1;
    if (hasCover(e, today)) active++;
  }
  const livesCovered = db.enrollees.reduce((s, e) => s + 1 + e.dependants, 0);
  const flagged = db.claims.filter((c) => c.fraudFlags.length > 0);
  const tariffSavings = db.claims.reduce((s, c) => s + Math.max(0, c.billedTotal - c.approvedTotal - c.copayTotal), 0);
  const blockedFraud = db.claims
    .filter((c) => c.status === 'rejected' && c.fraudFlags.some((f) => f.severity === 'high'))
    .reduce((s, c) => s + c.billedTotal, 0);
  const paid = db.claims.filter(isSettled);
  return {
    enrollees: db.enrollees.length,
    livesCovered,
    active,
    bySector,
    byState: Object.entries(byState).sort((a, b) => b[1] - a[1]),
    claims: db.claims.length,
    autoAdjudicated: ratio(db.claims.filter((c) => !c.reviewerNote).length, db.claims.length),
    avgDaysToPay: avg(paid.map((c) => claimAgeDays(c, today))),
    overdueClaims: db.claims.filter((c) => isOverdue(c, today)).length,
    flaggedClaims: flagged.length,
    tariffSavings,
    blockedFraud,
    openComplaints: db.complaints.filter((c) => c.status !== 'resolved').length,
    premiums: db.payments.reduce((s, p) => s + p.amount, 0),
    sponsoredLives: db.enrollees.filter((e) => e.sector === 'vulnerable').length,
  };
}

/** Capitation due to a primary provider for a month: lives registered with it × plan rate. */
export function capitationDue(db: Db, providerId: string, hmoId: string, rates: Record<string, number>, today: string) {
  const lives = db.enrollees.filter(
    (e) => e.primaryProviderId === providerId && e.hmoId === hmoId && hasCover(e, today),
  );
  return {
    lives: lives.reduce((s, e) => s + 1 + e.dependants, 0),
    amount: lives.reduce((s, e) => s + rates[e.planId] * (1 + e.dependants), 0),
  };
}
