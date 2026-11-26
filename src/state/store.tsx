import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { adjudicate, canPay, reviewClaim, type ClaimDraft } from '../domain/adjudication';
import { ENROLLEE_DISPUTE_FLAG, REVIEW_THRESHOLD } from '../domain/fraud';
import { PROVIDERS, providerById } from '../domain/catalog';
import { decidePA } from '../domain/preauth';
import { extendCover, quotePremium } from '../domain/pricing';
import { DEMO_PERSONAS, generateSeed } from '../domain/seed';
import type { Claim, Complaint, ComplaintCategory, Db, Enrollee, PARequest, PaymentFrequency, PaymentMethod, ServiceCategory } from '../domain/types';
import { addDays, isoDate, makeHealthGuardId, randomCode } from '../domain/util';

/**
 * In-browser data store. Every mutation goes through a domain function, so swapping
 * this for a real API later only means replacing the bodies of these actions.
 */

const STORAGE_KEY = 'healthguard-db-v1';

interface Persisted {
  seededOn: string;
  db: Db;
}

const load = (today: string): Persisted => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      if (p?.db?.enrollees?.length) return p;
    }
  } catch {
    /* storage unavailable — fall back to fresh demo data */
  }
  return { seededOn: today, db: generateSeed(today) };
};

export type EnrollInput = Omit<Enrollee, 'id' | 'enrolledOn' | 'paidThrough' | 'ninVerified'> & { method: PaymentMethod };

export interface Store {
  db: Db;
  today: string;
  nowIso: () => string;
  enroll: (input: EnrollInput) => Enrollee;
  pay: (enrolleeId: string, frequency: PaymentFrequency, method: PaymentMethod) => { amount: number; paidThrough: string };
  changeProvider: (enrolleeId: string, providerId: string) => void;
  submitClaim: (draft: Omit<ClaimDraft, 'submittedAt'>) => Claim;
  review: (claimId: string, verdict: 'approve' | 'reject', note: string) => void;
  payClaims: (claimIds: string[]) => number;
  respondToClaim: (claimId: string, answer: 'confirmed' | 'disputed') => void;
  requestPA: (req: { enrolleeId: string; providerId: string; category: ServiceCategory; description: string; estimatedCost: number }) => PARequest;
  decidePAManually: (code: string, approve: boolean, note: string) => void;
  fileComplaint: (c: { enrolleeId: string; category: ComplaintCategory; description: string; providerId?: string; channel: 'app' | 'ussd' }) => Complaint;
  resolveComplaint: (id: string, resolution: string) => void;
  escalateComplaint: (id: string) => void;
  payCapitation: (id: string) => void;
  reset: () => void;
  /** Who the demo user is "acting as" in each portal. */
  acting: Acting;
  setActing: (a: Partial<Acting>) => void;
}

export interface Acting {
  memberId: string;
  providerId: string;
  hmoId: string;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const today = useMemo(() => isoDate(new Date()), []);
  const [state, setState] = useState<Persisted>(() => load(today));
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* quota or privacy mode: the demo still works, it just won't persist */
    }
  }, [state]);

  const commit = useCallback((fn: (db: Db) => Db) => {
    const next = { ...ref.current, db: fn(ref.current.db) };
    ref.current = next;
    setState(next);
  }, []);

  const nowIso = () => new Date().toISOString();
  const [acting, setActingState] = useState<Acting>({ memberId: DEMO_PERSONAS.trader, providerId: 'prv-001', hmoId: 'hmo-unity' });

  const store: Store = {
    db: state.db,
    today,
    nowIso,
    acting,
    setActing: (a) => setActingState((prev) => ({ ...prev, ...a })),

    enroll(input) {
      const { method, ...rest } = input;
      const db = ref.current.db;
      const seq = db.enrollees.length + 1;
      const enrollee: Enrollee = {
        ...rest,
        id: makeHealthGuardId(seq),
        enrolledOn: today,
        paidThrough: addDays(today, -1),
        ninVerified: true,
      };
      const q = quotePremium({ planId: rest.planId, dependants: rest.dependants, frequency: rest.frequency, groupCode: rest.groupCode, sector: rest.sector });
      enrollee.paidThrough = extendCover(enrollee.paidThrough, q.daysCovered, today);
      commit((d) => ({
        ...d,
        enrollees: [...d.enrollees, enrollee],
        payments: [
          ...d.payments,
          { id: `PAY-${enrollee.id}-0`, enrolleeId: enrollee.id, amount: q.installment, method: rest.sector === 'vulnerable' ? 'sponsor' : method, paidAt: today, daysCovered: q.daysCovered, reference: randomCode('RCPT', Math.random, 8) },
        ],
      }));
      return enrollee;
    },

    pay(enrolleeId, frequency, method) {
      const e = ref.current.db.enrollees.find((x) => x.id === enrolleeId)!;
      const q = quotePremium({ planId: e.planId, dependants: e.dependants, frequency, groupCode: e.groupCode, sector: e.sector });
      const paidThrough = extendCover(e.paidThrough, q.daysCovered, today);
      commit((d) => ({
        ...d,
        enrollees: d.enrollees.map((x) => (x.id === enrolleeId ? { ...x, paidThrough, frequency } : x)),
        payments: [
          ...d.payments,
          { id: `PAY-${enrolleeId}-${d.payments.length}`, enrolleeId, amount: q.installment, method, paidAt: today, daysCovered: q.daysCovered, reference: randomCode('RCPT', Math.random, 8) },
        ],
      }));
      return { amount: q.installment, paidThrough };
    },

    changeProvider(enrolleeId, providerId) {
      commit((d) => ({ ...d, enrollees: d.enrollees.map((x) => (x.id === enrolleeId ? { ...x, primaryProviderId: providerId } : x)) }));
    },

    submitClaim(input) {
      const db = ref.current.db;
      const enrollee = db.enrollees.find((e) => e.id === input.enrolleeId)!;
      const provider = providerById(input.providerId)!;
      const draft: ClaimDraft = { ...input, paCode: input.paCode?.trim().toUpperCase() || undefined, submittedAt: today };
      const r = adjudicate(draft, { enrollee, provider, paRequests: db.paRequests, history: db.claims });
      const claim: Claim = {
        id: `CLM-${String(db.claims.length + 1).padStart(5, '0')}`,
        ...draft,
        hmoId: enrollee.hmoId,
        status: r.status,
        decisions: r.decisions,
        fraudFlags: r.fraudFlags,
        riskScore: r.riskScore,
        billedTotal: r.billedTotal,
        approvedTotal: r.approvedTotal,
        copayTotal: r.copayTotal,
        decidedAt: r.status === 'pending_review' ? undefined : today,
      };
      commit((d) => ({
        ...d,
        claims: [claim, ...d.claims],
        paRequests: d.paRequests.map((p) => (p.code === draft.paCode && p.status === 'approved' && claim.status !== 'rejected' ? { ...p, status: 'used' } : p)),
      }));
      return claim;
    },

    review(claimId, verdict, note) {
      commit((d) => ({ ...d, claims: d.claims.map((c) => (c.id === claimId ? reviewClaim(c, verdict, note, today) : c)) }));
    },

    payClaims(ids) {
      const set = new Set(ids);
      const total = ref.current.db.claims.filter((c) => set.has(c.id) && canPay(c)).reduce((s, c) => s + c.approvedTotal, 0);
      commit((d) => ({ ...d, claims: d.claims.map((c) => (set.has(c.id) && canPay(c) ? { ...c, status: 'paid', paidAt: today } : c)) }));
      return total;
    },

    respondToClaim(claimId, answer) {
      commit((d) => ({
        ...d,
        claims: d.claims.map((c) => {
          if (c.id !== claimId) return c;
          if (answer === 'confirmed') return { ...c, enrolleeConfirmation: 'confirmed' };
          // A dispute sends any unpaid claim back for review.
          const fraudFlags = [...c.fraudFlags, ENROLLEE_DISPUTE_FLAG];
          const riskScore = Math.min(100, c.riskScore + 40);
          return {
            ...c,
            enrolleeConfirmation: 'disputed',
            fraudFlags,
            riskScore,
            status: c.status === 'paid' || c.status === 'rejected' ? c.status : riskScore >= REVIEW_THRESHOLD ? 'pending_review' : c.status,
          };
        }),
      }));
    },

    requestPA(req) {
      const db = ref.current.db;
      const enrollee = db.enrollees.find((e) => e.id === req.enrolleeId)!;
      const provider = PROVIDERS.find((p) => p.id === req.providerId)!;
      const d = decidePA(req, enrollee, provider, today);
      const pa: PARequest = {
        ...req,
        code: randomCode('PA'),
        hmoId: enrollee.hmoId,
        status: d.status,
        requestedAt: nowIso(),
        decidedAt: d.status === 'pending' ? undefined : nowIso(),
        expiresAt: d.expiresAt,
        autoDecided: d.status !== 'pending',
        note: d.note,
      };
      commit((x) => ({ ...x, paRequests: [pa, ...x.paRequests] }));
      return pa;
    },

    decidePAManually(code, approve, note) {
      commit((d) => ({
        ...d,
        paRequests: d.paRequests.map((p) =>
          p.code === code
            ? { ...p, status: approve ? 'approved' : 'denied', decidedAt: nowIso(), expiresAt: approve ? addDays(today, 14) : undefined, note }
            : p,
        ),
      }));
    },

    fileComplaint(c) {
      const db = ref.current.db;
      const enrollee = db.enrollees.find((e) => e.id === c.enrolleeId)!;
      const complaint: Complaint = {
        id: `CMP-${String(db.complaints.length + 1).padStart(4, '0')}`,
        enrolleeId: c.enrolleeId,
        providerId: c.providerId ?? enrollee.primaryProviderId,
        hmoId: enrollee.hmoId,
        category: c.category,
        description: c.description,
        status: 'open',
        createdAt: nowIso(),
        channel: c.channel,
      };
      commit((d) => ({ ...d, complaints: [complaint, ...d.complaints] }));
      return complaint;
    },

    resolveComplaint(id, resolution) {
      commit((d) => ({ ...d, complaints: d.complaints.map((c) => (c.id === id ? { ...c, status: 'resolved', resolution, resolvedAt: nowIso() } : c)) }));
    },

    escalateComplaint(id) {
      commit((d) => ({ ...d, complaints: d.complaints.map((c) => (c.id === id ? { ...c, status: 'escalated' } : c)) }));
    },

    payCapitation(id) {
      commit((d) => ({ ...d, capitation: d.capitation.map((c) => (c.id === id ? { ...c, paidAt: today } : c)) }));
    },

    reset() {
      const fresh = { seededOn: today, db: generateSeed(today) };
      ref.current = fresh;
      setState(fresh);
    },
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore must be used inside <StoreProvider>');
  return s;
}
