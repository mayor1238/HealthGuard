// Core domain model for HealthGuard.
// Amounts are always in whole Naira (NGN). Dates are ISO-8601 strings.

export type ServiceCategory =
  | 'consultation'
  | 'laboratory'
  | 'drugs'
  | 'imaging'
  | 'maternity'
  | 'admission'
  | 'surgery'
  | 'emergency'
  | 'dental'
  | 'optical';

export type Sector = 'formal' | 'informal' | 'vulnerable';
export type Gender = 'female' | 'male';
export type PaymentFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
export type PaymentMethod = 'card' | 'ussd' | 'bank_transfer' | 'mobile_money' | 'agent' | 'sponsor';
export type ProviderLevel = 'primary' | 'secondary' | 'tertiary';

export interface Benefit {
  covered: boolean;
  /** Share of the approved amount the enrollee pays at point of care (0–1). */
  copay: number;
  /** Pre-authorisation (PA) code required before service. */
  requiresPA: boolean;
  /** Optional cap per encounter for this category. */
  perVisitCap?: number;
}

export interface Plan {
  id: string;
  name: string;
  tagline: string;
  monthlyPremium: number;
  annualLimit: number;
  waitingPeriodDays: number;
  /** Monthly capitation paid to the primary provider per enrolled life. */
  capitationRate: number;
  benefits: Record<ServiceCategory, Benefit>;
}

export interface Hmo {
  id: string;
  name: string;
  /** Target number of days to pay a vetted claim. */
  claimsSlaDays: number;
}

export interface Provider {
  id: string;
  name: string;
  level: ProviderLevel;
  state: string;
  lga: string;
  accredited: boolean;
  hmoIds: string[];
  phone: string;
}

export interface Enrollee {
  id: string;
  nin: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  dateOfBirth: string;
  phone: string;
  state: string;
  lga: string;
  sector: Sector;
  planId: string;
  hmoId: string;
  primaryProviderId: string;
  dependants: number;
  enrolledOn: string;
  /** Coverage is active up to and including this date. */
  paidThrough: string;
  frequency: PaymentFrequency;
  groupCode?: string;
  sponsor?: string;
  ninVerified: boolean;
}

export interface Payment {
  id: string;
  enrolleeId: string;
  amount: number;
  method: PaymentMethod;
  paidAt: string;
  daysCovered: number;
  reference: string;
}

export interface TariffItem {
  code: string;
  description: string;
  category: ServiceCategory;
  price: number;
}

export interface ClaimLine {
  tariffCode: string;
  quantity: number;
  /** What the provider billed per unit. */
  unitPrice: number;
}

export type ClaimStatus = 'pending_review' | 'approved' | 'partially_approved' | 'rejected' | 'paid';

export interface LineDecision {
  tariffCode: string;
  billed: number;
  approved: number;
  copay: number;
  reasons: string[];
}

export interface FraudFlag {
  rule: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

export interface Claim {
  id: string;
  enrolleeId: string;
  providerId: string;
  hmoId: string;
  encounterDate: string;
  submittedAt: string;
  diagnosis: string;
  paCode?: string;
  lines: ClaimLine[];
  status: ClaimStatus;
  decisions: LineDecision[];
  fraudFlags: FraudFlag[];
  riskScore: number;
  billedTotal: number;
  approvedTotal: number;
  copayTotal: number;
  decidedAt?: string;
  paidAt?: string;
  /** Enrollee confirmation that the visit really happened. */
  enrolleeConfirmation?: 'confirmed' | 'disputed';
  reviewerNote?: string;
}

export type PAStatus = 'approved' | 'pending' | 'denied' | 'used';

export interface PARequest {
  code: string;
  enrolleeId: string;
  providerId: string;
  hmoId: string;
  category: ServiceCategory;
  description: string;
  estimatedCost: number;
  status: PAStatus;
  requestedAt: string;
  decidedAt?: string;
  expiresAt?: string;
  autoDecided: boolean;
  note?: string;
}

export type ComplaintCategory =
  | 'denied_service'
  | 'asked_to_pay'
  | 'drug_unavailable'
  | 'long_wait'
  | 'poor_attitude'
  | 'claim_dispute'
  | 'other';

export interface Complaint {
  id: string;
  enrolleeId: string;
  providerId?: string;
  hmoId: string;
  category: ComplaintCategory;
  description: string;
  status: 'open' | 'escalated' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
  channel: 'app' | 'ussd';
}

export interface CapitationPayment {
  id: string;
  providerId: string;
  hmoId: string;
  month: string; // YYYY-MM
  lives: number;
  amount: number;
  paidAt?: string;
}

export interface Db {
  enrollees: Enrollee[];
  payments: Payment[];
  claims: Claim[];
  paRequests: PARequest[];
  complaints: Complaint[];
  capitation: CapitationPayment[];
}
