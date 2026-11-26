import { CATEGORY_LABELS, planById } from './catalog';
import { checkEligibility } from './pricing';
import type { Enrollee, PARequest, Provider, ServiceCategory } from './types';
import { addDays } from './util';

/** Routine requests at or below this estimate get a PA code instantly — no phone calls to the HMO. */
export const PA_AUTO_APPROVE_LIMIT = 150_000;
export const PA_VALID_DAYS = 14;
/** Hours an HMO clinician has to decide a request that needs manual review. */
export const PA_REVIEW_SLA_HOURS = 24;

const MANUAL_REVIEW_CATEGORIES: ServiceCategory[] = ['surgery'];

export interface PADecision {
  status: 'approved' | 'pending' | 'denied';
  note: string;
  expiresAt?: string;
}

export function decidePA(
  req: { category: ServiceCategory; estimatedCost: number },
  enrollee: Enrollee,
  provider: Provider,
  today: string,
): PADecision {
  const plan = planById(enrollee.planId);
  const benefit = plan.benefits[req.category];
  const label = CATEGORY_LABELS[req.category];
  const elig = checkEligibility(enrollee, today);

  if (!provider.accredited || !provider.hmoIds.includes(enrollee.hmoId))
    return { status: 'denied', note: "Provider is not accredited for the enrollee's HMO." };
  if (!elig.eligible) return { status: 'denied', note: elig.message };
  if (elig.emergencyOnly && req.category !== 'emergency') return { status: 'denied', note: elig.message };
  if (!benefit.covered) return { status: 'denied', note: `${label} is not covered on ${plan.name}.` };

  if (req.estimatedCost <= PA_AUTO_APPROVE_LIMIT && !MANUAL_REVIEW_CATEGORIES.includes(req.category)) {
    return {
      status: 'approved',
      note: `Auto-approved: covered benefit within the ₦${PA_AUTO_APPROVE_LIMIT.toLocaleString('en-NG')} instant limit.`,
      expiresAt: addDays(today, PA_VALID_DAYS),
    };
  }
  return {
    status: 'pending',
    note: `Sent to HMO medical officer — decision due within ${PA_REVIEW_SLA_HOURS} hours.`,
  };
}

export const isPAOverdue = (pa: PARequest, nowIso: string) =>
  pa.status === 'pending' &&
  new Date(nowIso).getTime() - new Date(pa.requestedAt).getTime() > PA_REVIEW_SLA_HOURS * 3_600_000;
