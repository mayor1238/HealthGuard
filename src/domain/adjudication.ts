import { CATEGORY_LABELS, planById, tariffByCode } from './catalog';
import { REVIEW_THRESHOLD, detectFraud } from './fraud';
import { checkEligibility } from './pricing';
import type { Claim, ClaimLine, ClaimStatus, Enrollee, FraudFlag, LineDecision, PARequest, Provider, ServiceCategory } from './types';
import { daysBetween } from './util';

export interface ClaimDraft {
  enrolleeId: string;
  providerId: string;
  encounterDate: string;
  submittedAt: string;
  diagnosis: string;
  paCode?: string;
  lines: ClaimLine[];
}

export interface AdjudicationContext {
  enrollee: Enrollee;
  provider: Provider;
  paRequests: PARequest[];
  /** All other claims already in the system. */
  history: Claim[];
}

export interface AdjudicationResult {
  status: ClaimStatus;
  decisions: LineDecision[];
  claimReasons: string[];
  fraudFlags: FraudFlag[];
  riskScore: number;
  billedTotal: number;
  approvedTotal: number;
  copayTotal: number;
}

/** Amount of the annual limit already used in the encounter's calendar year. */
export function utilisedInYear(enrolleeId: string, year: string, claims: Claim[]) {
  return claims
    .filter((c) => c.enrolleeId === enrolleeId && c.encounterDate.startsWith(year) && c.status !== 'rejected')
    .reduce((s, c) => s + c.approvedTotal, 0);
}

/**
 * A PA code authorises an episode of care, not a single line: e.g. a surgery PA also
 * covers the admission, drugs and tests that go with it.
 */
const SUPPORTING: ServiceCategory[] = ['consultation', 'laboratory', 'drugs'];
export function paCovers(paCategory: ServiceCategory, lineCategory: ServiceCategory) {
  if (paCategory === lineCategory || SUPPORTING.includes(lineCategory)) return true;
  if (paCategory === 'surgery' || paCategory === 'maternity') return lineCategory === 'admission' || lineCategory === 'imaging';
  if (paCategory === 'consultation') return lineCategory === 'imaging';
  return false;
}

/** A PA code is valid for a line if it was approved for this enrollee and provider, covers the service and has not expired. */
export function findValidPA(paRequests: PARequest[], draft: ClaimDraft, category: ServiceCategory): PARequest | undefined {
  if (!draft.paCode) return undefined;
  const code = draft.paCode.trim().toUpperCase();
  return paRequests.find(
    (p) =>
      p.code === code &&
      (p.status === 'approved' || p.status === 'used') &&
      p.enrolleeId === draft.enrolleeId &&
      p.providerId === draft.providerId &&
      paCovers(p.category, category) &&
      (!p.expiresAt || daysBetween(draft.encounterDate, p.expiresAt) >= 0),
  );
}

/**
 * Rules-based auto-adjudication. Every claim gets an instant, explainable decision
 * per line so providers know exactly what will be paid and why — no more opaque
 * "vetting" that takes months.
 */
export function adjudicate(draft: ClaimDraft, ctx: AdjudicationContext): AdjudicationResult {
  const { enrollee, provider } = ctx;
  const plan = planById(enrollee.planId);
  const eligibility = checkEligibility(enrollee, draft.encounterDate);
  const claimReasons: string[] = [];

  // Claim-level blockers.
  let blockAll = false;
  if (!provider.accredited) {
    claimReasons.push('Provider is not accredited.');
    blockAll = true;
  }
  if (!provider.hmoIds.includes(enrollee.hmoId)) {
    claimReasons.push("Provider is not contracted with the enrollee's HMO.");
    blockAll = true;
  }
  if (eligibility.status === 'lapsed' || daysBetween(enrollee.enrolledOn, draft.encounterDate) < 0) {
    claimReasons.push('Cover was not active on the encounter date.');
    blockAll = true;
  }

  const isOwnPrimary = provider.id === enrollee.primaryProviderId;
  const categorySpend: Record<string, number> = {};

  const decisions: LineDecision[] = draft.lines.map((line) => {
    const reasons: string[] = [];
    const tariff = tariffByCode(line.tariffCode);
    const billed = Math.max(0, line.unitPrice) * Math.max(0, line.quantity);
    const reject = (why: string): LineDecision => ({ tariffCode: line.tariffCode, billed, approved: 0, copay: 0, reasons: [...reasons, why] });

    if (blockAll) return reject(claimReasons.join(' '));
    if (!tariff) return reject('Unknown tariff code.');
    if (line.quantity <= 0) return reject('Quantity must be at least 1.');

    const benefit = plan.benefits[tariff.category];
    const label = CATEGORY_LABELS[tariff.category];
    const isEmergency = tariff.category === 'emergency';

    if (!benefit.covered) return reject(`${label} is not covered on ${plan.name}.`);
    if (eligibility.emergencyOnly && !isEmergency) return reject('Enrollee is in waiting period — emergency care only.');

    // Referral pathway: primary care must happen at the enrollee's chosen primary provider;
    // anything at a secondary/tertiary facility needs a referral (PA code) unless it is an emergency.
    const needsReferral = !isEmergency && (provider.level !== 'primary' || !isOwnPrimary);
    const needsPA = benefit.requiresPA || needsReferral;
    if (needsPA && !findValidPA(ctx.paRequests, draft, tariff.category)) {
      return reject(
        needsReferral && !benefit.requiresPA
          ? 'Referral/PA code required for care outside the registered primary provider.'
          : `${label} requires a valid pre-authorisation code.`,
      );
    }

    let unit = line.unitPrice;
    if (unit > tariff.price) {
      reasons.push(`Price capped at agreed tariff of ₦${tariff.price.toLocaleString('en-NG')}.`);
      unit = tariff.price;
    }
    let allowed = unit * line.quantity;

    if (benefit.perVisitCap !== undefined) {
      const used = categorySpend[tariff.category] ?? 0;
      const room = Math.max(0, benefit.perVisitCap - used);
      if (allowed > room) {
        reasons.push(`${label} capped at ₦${benefit.perVisitCap.toLocaleString('en-NG')} per visit.`);
        allowed = room;
      }
    }
    categorySpend[tariff.category] = (categorySpend[tariff.category] ?? 0) + allowed;

    const copay = Math.round(allowed * benefit.copay);
    if (copay > 0) reasons.push(`${Math.round(benefit.copay * 100)}% co-pay collected from enrollee.`);
    return { tariffCode: line.tariffCode, billed, approved: allowed - copay, copay, reasons };
  });

  // Annual benefit limit.
  let remaining = Math.max(
    0,
    plan.annualLimit - utilisedInYear(enrollee.id, draft.encounterDate.slice(0, 4), ctx.history),
  );
  for (const d of decisions) {
    if (d.approved > remaining) {
      d.reasons.push('Annual benefit limit reached.');
      d.approved = remaining;
    }
    remaining -= d.approved;
  }

  const { flags, riskScore } = detectFraud({
    enrollee,
    provider,
    encounterDate: draft.encounterDate,
    submittedAt: draft.submittedAt,
    lines: draft.lines,
    history: ctx.history,
  });

  const billedTotal = decisions.reduce((s, d) => s + d.billed, 0);
  const approvedTotal = decisions.reduce((s, d) => s + d.approved, 0);
  const copayTotal = decisions.reduce((s, d) => s + d.copay, 0);

  let status: ClaimStatus;
  if (approvedTotal === 0 && copayTotal === 0) status = 'rejected';
  else if (riskScore >= REVIEW_THRESHOLD) status = 'pending_review';
  else if (approvedTotal + copayTotal < billedTotal) status = 'partially_approved';
  else status = 'approved';

  return { status, decisions, claimReasons, fraudFlags: flags, riskScore, billedTotal, approvedTotal, copayTotal };
}

/** Apply a human reviewer's verdict to a claim that was held for review. */
export function reviewClaim(claim: Claim, verdict: 'approve' | 'reject', note: string, today: string): Claim {
  if (verdict === 'reject') {
    return {
      ...claim,
      status: 'rejected',
      approvedTotal: 0,
      copayTotal: 0,
      decisions: claim.decisions.map((d) => ({ ...d, approved: 0, copay: 0, reasons: [...d.reasons, `Rejected on review: ${note}`] })),
      reviewerNote: note,
      decidedAt: today,
    };
  }
  return {
    ...claim,
    status: claim.approvedTotal + claim.copayTotal < claim.billedTotal ? 'partially_approved' : 'approved',
    reviewerNote: note,
    decidedAt: today,
  };
}

export const canPay = (c: Claim) => c.status === 'approved' || c.status === 'partially_approved';
