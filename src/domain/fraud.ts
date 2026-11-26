import type { Claim, ClaimLine, Enrollee, FraudFlag, Provider } from './types';
import { tariffByCode } from './catalog';
import { ageOn, daysBetween } from './util';

/** Claims at or above this risk score are held for a human reviewer instead of auto-paying. */
export const REVIEW_THRESHOLD = 40;

const WEIGHT: Record<FraudFlag['severity'], number> = { low: 10, medium: 20, high: 40 };

export interface FraudInput {
  enrollee: Enrollee;
  provider: Provider;
  encounterDate: string;
  submittedAt: string;
  lines: ClaimLine[];
  /** Earlier claims in the system (any status). */
  history: Claim[];
}

export function detectFraud(input: FraudInput): { flags: FraudFlag[]; riskScore: number } {
  const { enrollee, provider, encounterDate, submittedAt, lines, history } = input;
  const flags: FraudFlag[] = [];
  const add = (rule: string, severity: FraudFlag['severity'], detail: string) => flags.push({ rule, severity, detail });

  const live = history.filter((c) => c.status !== 'rejected');
  const codes = new Set(lines.map((l) => l.tariffCode));

  // 1. Duplicate billing: same patient, same provider, same day, same service.
  const dup = live.find(
    (c) =>
      c.enrolleeId === enrollee.id &&
      c.providerId === provider.id &&
      c.encounterDate === encounterDate &&
      c.lines.some((l) => codes.has(l.tariffCode)),
  );
  if (dup) add('DUPLICATE_CLAIM', 'high', `Same services already claimed for this visit in ${dup.id}.`);

  // 2. Visit frequency — "claim farming" on a single enrollee.
  const recent = live.filter(
    (c) =>
      c.enrolleeId === enrollee.id &&
      daysBetween(c.encounterDate, encounterDate) >= 0 &&
      daysBetween(c.encounterDate, encounterDate) <= 30,
  ).length;
  if (recent >= 4) add('HIGH_VISIT_FREQUENCY', 'medium', `${recent} other visits by this enrollee in the last 30 days.`);

  // 3. Dates that cannot be right.
  if (daysBetween(submittedAt, encounterDate) > 0) add('FUTURE_ENCOUNTER', 'high', 'Encounter date is after the submission date.');
  if (daysBetween(enrollee.enrolledOn, encounterDate) < 0) add('BEFORE_ENROLMENT', 'high', 'Encounter happened before the enrollee joined.');
  if (daysBetween(encounterDate, submittedAt) > 90) add('LATE_SUBMISSION', 'low', 'Submitted more than 90 days after the visit.');

  // 4. Clinical plausibility.
  const age = ageOn(enrollee.dateOfBirth, encounterDate);
  const hasMaternity = lines.some((l) => tariffByCode(l.tariffCode)?.category === 'maternity');
  if (hasMaternity && enrollee.gender === 'male') add('GENDER_MISMATCH', 'high', 'Maternity service billed for a male enrollee.');
  else if (hasMaternity && (age < 12 || age > 55)) add('AGE_MISMATCH', 'medium', `Maternity service billed for a ${age}-year-old.`);

  // 5. Upcoding and padding.
  for (const l of lines) {
    const t = tariffByCode(l.tariffCode);
    if (!t) continue;
    if (l.unitPrice > t.price * 1.5) add('ABOVE_TARIFF', 'medium', `${t.code} billed at ${Math.round((l.unitPrice / t.price) * 100)}% of agreed tariff.`);
    const qtyLimit = t.category === 'admission' ? 14 : t.category === 'drugs' ? 6 : 3;
    if (l.quantity > qtyLimit) add('QUANTITY_OUTLIER', 'medium', `${t.code} quantity ${l.quantity} exceeds the usual maximum of ${qtyLimit}.`);
  }

  // 6. Ghost-enrollee risk.
  if (!enrollee.ninVerified) add('NIN_NOT_VERIFIED', 'medium', 'Enrollee identity has not been verified against NIN.');

  // 7. Provider volume spike versus its own baseline.
  const providerClaims = live.filter((c) => c.providerId === provider.id);
  const lastWeek = providerClaims.filter((c) => {
    const d = daysBetween(c.submittedAt, submittedAt);
    return d >= 0 && d < 7;
  }).length;
  const prior8Weeks = providerClaims.filter((c) => {
    const d = daysBetween(c.submittedAt, submittedAt);
    return d >= 7 && d < 63;
  }).length;
  const weeklyBaseline = prior8Weeks / 8;
  if (lastWeek >= 6 && lastWeek > weeklyBaseline * 3) {
    add('PROVIDER_VOLUME_SPIKE', 'low', `${lastWeek} claims this week vs. a baseline of ${weeklyBaseline.toFixed(1)}/week.`);
  }

  const riskScore = Math.min(100, flags.reduce((s, f) => s + WEIGHT[f.severity], 0));
  return { flags, riskScore };
}

export const ENROLLEE_DISPUTE_FLAG: FraudFlag = {
  rule: 'ENROLLEE_DISPUTED',
  severity: 'high',
  detail: 'The enrollee says they did not receive these services.',
};
