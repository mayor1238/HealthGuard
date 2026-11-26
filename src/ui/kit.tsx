import { useEffect, useState, type ReactNode } from 'react';
import type { Claim, ClaimStatus, Complaint, PARequest } from '../domain/types';
import type { CoverStatus } from '../domain/pricing';

// ---------- Routing (hash based: #/section/tab) ----------

export function useRoute(): [string, string | undefined, (path: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/');
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      setParts(read());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [parts[0] ?? '', parts[1], (path: string) => (window.location.hash = '/' + path)];
}

export const go = (path: string) => (window.location.hash = '/' + path);

// ---------- Primitives ----------

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray' | 'violet';

export const Badge = ({ tone = 'gray', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`badge ${tone}`}>{children}</span>
);

export const Card = ({ title, action, children, className = '' }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card ${className}`}>
    {(title || action) && (
      <header className="card-head">
        {title && <h3>{title}</h3>}
        {action}
      </header>
    )}
    {children}
  </section>
);

export const Stat = ({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) => (
  <div className={`stat ${tone ?? ''}`}>
    <span className="stat-label">{label}</span>
    <strong className="stat-value">{value}</strong>
    {hint && <span className="stat-hint">{hint}</span>}
  </div>
);

export const Field = ({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | false; children: ReactNode }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
  </label>
);

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: [T, ReactNode][]; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={value === id} className={value === id ? 'tab active' : 'tab'} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export const Notice = ({ tone = 'blue', children }: { tone?: Tone; children: ReactNode }) => (
  <div className={`notice ${tone}`} role="status">
    {children}
  </div>
);

/** Horizontal bar list — single series, values labelled directly, so colour is never the only cue. */
export function BarList({ rows, format = String, max }: { rows: { label: string; value: number; note?: string }[]; format?: (n: number) => string; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="barlist">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${format(r.value)}${r.note ? ` — ${r.note}` : ''}`}>
          <span className="barlist-label">{r.label}</span>
          <span className="barlist-track">
            <span className="barlist-fill" style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / top) * 100)}%` }} />
          </span>
          <span className="barlist-value">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

export const Meter = ({ value, label }: { value: number; label: string }) => (
  <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
    <span style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
  </div>
);

// ---------- Domain-aware badges ----------

const CLAIM_TONE: Record<ClaimStatus, [Tone, string]> = {
  pending_review: ['amber', 'Under review'],
  approved: ['blue', 'Approved · awaiting payment'],
  partially_approved: ['blue', 'Part-approved · awaiting payment'],
  rejected: ['red', 'Rejected'],
  paid: ['green', 'Paid'],
};
export const ClaimBadge = ({ claim }: { claim: Claim }) => <Badge tone={CLAIM_TONE[claim.status][0]}>{CLAIM_TONE[claim.status][1]}</Badge>;

const COVER_TONE: Record<CoverStatus, [Tone, string]> = {
  active: ['green', 'Active'],
  grace: ['amber', 'Grace period'],
  waiting: ['blue', 'Waiting period'],
  lapsed: ['red', 'Lapsed'],
  unpaid: ['gray', 'Awaiting first payment'],
};
export const CoverBadge = ({ status }: { status: CoverStatus }) => <Badge tone={COVER_TONE[status][0]}>{COVER_TONE[status][1]}</Badge>;

const PA_TONE: Record<PARequest['status'], [Tone, string]> = {
  approved: ['green', 'Approved'],
  used: ['gray', 'Used'],
  pending: ['amber', 'Pending'],
  denied: ['red', 'Denied'],
};
export const PABadge = ({ pa }: { pa: PARequest }) => <Badge tone={PA_TONE[pa.status][0]}>{PA_TONE[pa.status][1]}</Badge>;

const COMPLAINT_TONE: Record<Complaint['status'], [Tone, string]> = {
  open: ['amber', 'Open'],
  escalated: ['red', 'Escalated to regulator'],
  resolved: ['green', 'Resolved'],
};
export const ComplaintBadge = ({ c }: { c: Complaint }) => <Badge tone={COMPLAINT_TONE[c.status][0]}>{COMPLAINT_TONE[c.status][1]}</Badge>;

export { COMPLAINT_LABELS } from '../domain/catalog';

export const pct = (n: number) => `${Math.round(n * 100)}%`;
