import type { HmoScore, systemSummary } from '../domain/analytics';
import type { Eligibility, Quote } from '../domain/pricing';
import type { Claim, Complaint, Enrollee, Hmo, PARequest, Plan, Provider } from '../domain/types';

export type Role = 'member' | 'provider' | 'hmo' | 'regulator';

export interface Principal {
  id: string;
  role: Role;
  enrolleeId?: string;
  providerId?: string;
  hmoId?: string;
  username?: string;
}

export interface Meta {
  environment: 'development' | 'test' | 'production';
  today: string;
  devGateway: boolean;
  demoLogins: boolean;
}

export interface PaymentView {
  reference: string;
  amount: number;
  method: string;
  frequency: string;
  daysCovered: number;
  status: 'pending' | 'confirmed' | 'failed';
  paidAt?: string;
}

export interface MemberProfile {
  enrollee: Enrollee;
  eligibility: Eligibility;
  plan: Plan;
  primaryProvider?: Provider;
  benefitUsedThisYear: number;
  benefitRemaining: number;
  nextPayment: Quote | null;
}

export interface EligibilityView {
  id: string;
  firstName: string;
  lastName: string;
  gender: string;
  age: number;
  dependants: number;
  ninVerified: boolean;
  plan: Pick<Plan, 'id' | 'name' | 'benefits' | 'annualLimit'>;
  hmo: Hmo;
  eligibility: Eligibility;
  contractedWithHmo: boolean;
  isPrimaryProvider: boolean;
  referralNeeded: boolean;
  benefitRemaining: number;
}

export interface HmoPerformance {
  hmoId: string;
  name: string;
  avgDaysToPay: number;
  paidWithinSla: number;
  complaintResolution: number;
  complaintsPer1000: number;
}

export type Named<T> = T & { patientName: string };
export type NamedClaim = Named<Claim>;
export type NamedPA = Named<PARequest>;
export type NamedComplaint = Named<Complaint>;

export interface RegulatorSummary {
  summary: ReturnType<typeof systemSummary>;
  hmos: HmoScore[];
  fraudFlags: { rule: string; count: number }[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actorId?: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  details?: unknown;
}
