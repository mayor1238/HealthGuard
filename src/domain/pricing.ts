import { GROUPS, planById } from './catalog';
import type { Enrollee, PaymentFrequency, Sector } from './types';
import { addDays, daysBetween } from './util';

/** Each dependant (spouse/child) adds this share of the principal's premium. */
export const DEPENDANT_LOADING = 0.6;
export const MAX_DEPENDANTS = 5;

export const FREQUENCIES: Record<PaymentFrequency, { label: string; days: number; discount: number }> = {
  daily: { label: 'Daily', days: 1, discount: 0 },
  weekly: { label: 'Weekly', days: 7, discount: 0 },
  monthly: { label: 'Monthly', days: 30, discount: 0 },
  quarterly: { label: 'Quarterly', days: 91, discount: 0.03 },
  annual: { label: 'Yearly', days: 365, discount: 0.08 },
};

export interface QuoteInput {
  planId: string;
  dependants: number;
  frequency: PaymentFrequency;
  groupCode?: string;
  sector: Sector;
}

export interface Quote {
  /** What is charged each time the enrollee pays at the chosen frequency. */
  installment: number;
  daysCovered: number;
  annualCost: number;
  monthlyEquivalent: number;
  groupName?: string;
  groupDiscount: number;
  frequencyDiscount: number;
  /** Vulnerable enrollees are fully sponsored (e.g. Basic Health Care Provision Fund, NGOs, philanthropists). */
  payer: 'enrollee' | 'sponsor';
}

const roundUpTo10 = (n: number) => Math.ceil(n / 10) * 10;
/** Small (daily) instalments round to the Naira so the poorest payers are not overcharged by rounding. */
const roundInstallment = (n: number) => (n < 1000 ? Math.ceil(n) : roundUpTo10(n));

export function quotePremium(input: QuoteInput): Quote {
  const plan = planById(input.planId);
  const dependants = Math.max(0, Math.min(MAX_DEPENDANTS, Math.floor(input.dependants)));
  const group = input.groupCode ? GROUPS[input.groupCode.trim().toUpperCase()] : undefined;
  const groupDiscount = group?.discount ?? 0;
  const freq = FREQUENCIES[input.frequency];

  const monthly = plan.monthlyPremium * (1 + dependants * DEPENDANT_LOADING) * (1 - groupDiscount);
  const annualBase = monthly * 12;
  const installment = roundInstallment((annualBase / 365) * freq.days * (1 - freq.discount));

  return {
    installment,
    daysCovered: freq.days,
    annualCost: roundUpTo10(installment * (365 / freq.days)),
    monthlyEquivalent: roundUpTo10(monthly * (1 - freq.discount)),
    groupName: group?.name,
    groupDiscount,
    frequencyDiscount: freq.discount,
    payer: input.sector === 'vulnerable' ? 'sponsor' : 'enrollee',
  };
}

/**
 * Extend cover after a payment. If cover had lapsed, the new period starts today
 * rather than back-filling the lapsed days.
 */
export function extendCover(paidThrough: string, daysCovered: number, today: string): string {
  const start = daysBetween(today, paidThrough) >= 0 ? paidThrough : addDays(today, -1);
  return addDays(start, daysCovered);
}

export const GRACE_DAYS = 7;

export type CoverStatus = 'active' | 'grace' | 'waiting' | 'lapsed';

export interface Eligibility {
  eligible: boolean;
  status: CoverStatus;
  emergencyOnly: boolean;
  message: string;
  daysOfCoverLeft: number;
}

export function checkEligibility(enrollee: Enrollee, on: string): Eligibility {
  const plan = planById(enrollee.planId);
  const daysLeft = daysBetween(on, enrollee.paidThrough);
  const waitingEnds = addDays(enrollee.enrolledOn, plan.waitingPeriodDays);

  if (daysLeft < -GRACE_DAYS) {
    return {
      eligible: false,
      status: 'lapsed',
      emergencyOnly: false,
      daysOfCoverLeft: daysLeft,
      message: `Cover lapsed ${-daysLeft} days ago. Renew to restore access (emergency stabilisation is never refused).`,
    };
  }
  if (daysBetween(on, waitingEnds) > 0) {
    return {
      eligible: true,
      status: 'waiting',
      emergencyOnly: true,
      daysOfCoverLeft: daysLeft,
      message: `In waiting period until ${waitingEnds}. Emergency care only.`,
    };
  }
  if (daysLeft < 0) {
    return {
      eligible: true,
      status: 'grace',
      emergencyOnly: false,
      daysOfCoverLeft: daysLeft,
      message: `Premium overdue by ${-daysLeft} day(s). Grace period ends in ${GRACE_DAYS + daysLeft} day(s).`,
    };
  }
  return {
    eligible: true,
    status: 'active',
    emergencyOnly: false,
    daysOfCoverLeft: daysLeft,
    message: `Active — covered for the next ${daysLeft} day(s).`,
  };
}
