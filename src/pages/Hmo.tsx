import { AlertTriangle, Check, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { NamedClaim, NamedComplaint, NamedPA } from '../api/types';
import { claimAgeDays, isOverdue, type HmoScore } from '../domain/analytics';
import { CATEGORY_LABELS, hmoById, providerById, tariffByCode } from '../domain/catalog';
import { isPAOverdue } from '../domain/preauth';
import type { CapitationPayment } from '../domain/types';
import { naira, prettyDate } from '../domain/util';
import { useApiMutation, useApiQuery, useMeta, useSession } from '../state/session';
import { Badge, COMPLAINT_LABELS, Card, ClaimBadge, ComplaintBadge, Empty, ErrorNotice, Loadable, Notice, Stat, Tabs, pct } from '../ui/kit';

type Tab = 'overview' | 'review' | 'payments' | 'preauth' | 'complaints' | 'capitation';
const HMO = ['hmo'];

const useReview = () => useApiQuery<NamedClaim[]>(['hmo', 'claims', 'review'], '/hmo/claims?queue=review');
const usePayable = () => useApiQuery<NamedClaim[]>(['hmo', 'claims', 'payable'], '/hmo/claims?queue=payable');
const usePendingPA = () => useApiQuery<NamedPA[]>(['hmo', 'pa', 'pending'], '/hmo/pa-requests?status=pending');
const useComplaints = () => useApiQuery<NamedComplaint[]>(['hmo', 'complaints'], '/hmo/complaints');
const useCapitation = () => useApiQuery<CapitationPayment[]>(['hmo', 'capitation'], '/hmo/capitation');

const today = (m?: { today: string }) => m?.today ?? new Date().toISOString().slice(0, 10);

export function HmoPortal({ tab, navigate }: { tab?: string; navigate: (p: string) => void }) {
  const { principal } = useSession();
  const hmo = hmoById(principal!.hmoId!);
  const review = useReview();
  const payable = usePayable();
  const pa = usePendingPA();
  const complaints = useComplaints();
  const cap = useCapitation();
  const n = (x?: unknown[]) => x?.length ?? 0;
  const tabs: [Tab, ReactNode][] = [
    ['overview', 'Overview'],
    ['review', <>Review queue <Count n={n(review.data)} /></>],
    ['payments', <>Pay providers <Count n={n(payable.data)} /></>],
    ['preauth', <>PA requests <Count n={n(pa.data)} /></>],
    ['complaints', <>Complaints <Count n={(complaints.data ?? []).filter((c) => c.status !== 'resolved').length} /></>],
    ['capitation', <>Capitation <Count n={(cap.data ?? []).filter((c) => !c.paidAt).length} /></>],
  ];
  const current = (tabs.some(([t]) => t === tab) ? tab : 'overview') as Tab;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{hmo.name}</h1>
          <p className="muted">Claims payment target: {hmo.claimsSlaDays} days from submission</p>
        </div>
      </div>
      <Tabs<Tab> value={current} onChange={(t) => navigate(`hmo/${t}`)} tabs={tabs} />
      {current === 'overview' && <Overview slaDays={hmo.claimsSlaDays} />}
      {current === 'review' && <Review />}
      {current === 'payments' && <Payments />}
      {current === 'preauth' && <PreAuthQueue />}
      {current === 'complaints' && <ComplaintQueue />}
      {current === 'capitation' && <CapitationRun />}
    </div>
  );
}

const Count = ({ n }: { n: number }) => (n > 0 ? <span className="count">{n}</span> : null);

function Overview({ slaDays }: { slaDays: number }) {
  const q = useApiQuery<HmoScore>(['hmo', 'overview'], '/hmo/overview');
  return (
    <Loadable q={q}>
      {(s) => (
        <div className="stack">
          <div className="grid four tight">
            <Stat label="Members" value={s.enrollees} hint={`${s.activeEnrollees} with active cover`} />
            <Stat label="Avg days to pay a claim" value={s.avgDaysToPay.toFixed(1)} tone={s.avgDaysToPay > slaDays ? 'red' : 'green'} hint={`Target ≤ ${slaDays}`} />
            <Stat label="Claims paid within target" value={pct(s.paidWithinSla)} />
            <Stat label="Overdue claims" value={s.overdueClaims} tone={s.overdueClaims ? 'red' : undefined} />
            <Stat label="Premiums (90 days)" value={naira(s.premiums)} />
            <Stat label="Medical loss ratio (90 days)" value={pct(s.medicalLossRatio)} hint="Claims + capitation ÷ premiums" />
            <Stat label="Complaints resolved" value={pct(s.complaintResolution)} hint={`${s.complaintsPer1000.toFixed(0)} per 1,000 members`} />
            <Stat label="PA decided instantly" value={pct(s.paAutoRate)} />
          </div>
          {s.avgDaysToPay > slaDays && (
            <Notice tone="red">
              <AlertTriangle size={16} aria-hidden /> You are paying providers slower than the {slaDays}-day target. This is visible on the regulator's league table and to people choosing an HMO.
            </Notice>
          )}
        </div>
      )}
    </Loadable>
  );
}

function ClaimDetail({ c }: { c: NamedClaim }) {
  return (
    <>
      <p className="muted small">
        {providerById(c.providerId)?.name} · {c.patientName} ({c.enrolleeId}) · visit {prettyDate(c.encounterDate)} · {c.diagnosis}
        {c.paCode ? ` · ${c.paCode}` : ''}
      </p>
      <ul className="decisions">
        {c.decisions.map((d, i) => (
          <li key={i} className={d.approved + d.copay === 0 ? 'rejected' : d.approved + d.copay < d.billed ? 'partial' : 'ok'}>
            <div className="list-row">
              <span>
                {tariffByCode(d.tariffCode)?.description ?? d.tariffCode} × {c.lines[i]?.quantity}
              </span>
              <span>
                {naira(d.billed)} → <strong>{naira(d.approved)}</strong>
              </span>
            </div>
            {d.reasons.map((r) => (
              <span key={r} className="small muted">
                {r}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

function Review() {
  const q = useReview();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const review = useApiMutation(({ id, verdict, note }: { id: string; verdict: 'approve' | 'reject'; note: string }) => api(`/hmo/claims/${id}/review`, { body: { verdict, note } }), [HMO]);
  return (
    <Loadable q={q}>
      {(claims) =>
        claims.length === 0 ? (
          <Empty>Nothing to review. Clean claims are decided automatically.</Empty>
        ) : (
          <div className="stack">
            <p className="muted">Only claims the fraud engine flagged — or members disputed — land here. Everything else is decided automatically.</p>
            {review.error && <ErrorNotice error={review.error} />}
            {[...claims]
              .sort((a, b) => b.riskScore - a.riskScore)
              .map((c) => (
                <Card key={c.id} title={<>{c.id} · {naira(c.billedTotal)}</>} action={<Badge tone={c.riskScore >= 70 ? 'red' : 'amber'}>Risk {c.riskScore}/100</Badge>}>
                  <ul className="flags">
                    {c.fraudFlags.map((f, i) => (
                      <li key={i}>
                        <Badge tone={f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'amber' : 'gray'}>{f.rule.replace(/_/g, ' ').toLowerCase()}</Badge> {f.detail}
                      </li>
                    ))}
                  </ul>
                  <ClaimDetail c={c} />
                  <div className="inline">
                    <input aria-label={`Reviewer note for ${c.id}`} placeholder="Reviewer note" maxLength={500} value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                    <button className="secondary small" disabled={review.isPending} onClick={() => review.mutate({ id: c.id, verdict: 'approve', note: notes[c.id]?.trim() || 'Verified with provider and member.' })}>
                      <Check size={14} aria-hidden /> Approve
                    </button>
                    <button className="danger small" disabled={review.isPending} onClick={() => review.mutate({ id: c.id, verdict: 'reject', note: notes[c.id]?.trim() || c.fraudFlags[0]?.detail || 'Rejected on review' })}>
                      <X size={14} aria-hidden /> Reject
                    </button>
                  </div>
                </Card>
              ))}
          </div>
        )
      }
    </Loadable>
  );
}

function Payments() {
  const meta = useMeta();
  const t = today(meta.data);
  const q = usePayable();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pay = useApiMutation((ids: string[]) => api<{ batch: string | null; paid: string[]; total: number; skipped: { id: string; reason: string }[] }>('/hmo/claim-payments', { body: { claimIds: ids } }), [HMO]);
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };

  return (
    <div className="stack">
      {pay.data && (
        <Notice tone="green">
          Batch {pay.data.batch}: {naira(pay.data.total)} for {pay.data.paid.length} claim(s) sent to providers.
          {pay.data.skipped.length > 0 && ` ${pay.data.skipped.length} skipped (already paid or no longer payable).`}
        </Notice>
      )}
      {pay.error && <ErrorNotice error={pay.error} />}
      <Loadable q={q}>
        {(claims) => {
          const sorted = [...claims].sort((a, b) => claimAgeDays(b, t) - claimAgeDays(a, t));
          const total = sorted.filter((c) => selected.has(c.id)).reduce((s, c) => s + c.approvedTotal, 0);
          if (!sorted.length) return <Empty>All approved claims are paid. 🎉</Empty>;
          return (
            <>
              <div className="actions spread">
                <div className="actions">
                  <button className="ghost small" onClick={() => setSelected(new Set(sorted.map((c) => c.id)))}>
                    Select all ({sorted.length})
                  </button>
                  <button className="ghost small" onClick={() => setSelected(new Set(sorted.filter((c) => isOverdue(c, t)).map((c) => c.id)))}>
                    Select overdue
                  </button>
                </div>
                <button disabled={selected.size === 0 || pay.isPending} onClick={() => pay.mutate([...selected], { onSuccess: () => setSelected(new Set()) })}>
                  {pay.isPending ? 'Paying…' : `Pay ${selected.size} claim(s) · ${naira(total)}`}
                </button>
              </div>
              <div className="table-wrap card flush">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <span className="sr-only">Select</span>
                      </th>
                      <th>Claim</th>
                      <th>Provider</th>
                      <th>Patient</th>
                      <th>Approved</th>
                      <th>Status</th>
                      <th>Waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((c) => (
                      <tr key={c.id} className={selected.has(c.id) ? 'selected' : ''}>
                        <td>
                          <input type="checkbox" aria-label={`Select ${c.id}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                        </td>
                        <td className="mono">{c.id}</td>
                        <td>{providerById(c.providerId)?.name}</td>
                        <td>{c.patientName}</td>
                        <td>{naira(c.approvedTotal)}</td>
                        <td>
                          <ClaimBadge claim={c} />
                        </td>
                        <td>
                          {claimAgeDays(c, t)} days {isOverdue(c, t) && <Badge tone="red">Overdue</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </Loadable>
    </div>
  );
}

function PreAuthQueue() {
  const q = usePendingPA();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const decide = useApiMutation(({ code, approve, note }: { code: string; approve: boolean; note: string }) => api(`/hmo/pa-requests/${code}/decision`, { body: { approve, note } }), [HMO]);
  const now = new Date().toISOString();
  return (
    <Loadable q={q}>
      {(pending) =>
        pending.length === 0 ? (
          <Empty>No PA requests waiting. Routine requests are approved instantly.</Empty>
        ) : (
          <div className="stack">
            {decide.error && <ErrorNotice error={decide.error} />}
            {pending.map((p) => (
              <Card
                key={p.code}
                title={<>{p.code} · {CATEGORY_LABELS[p.category]} · {naira(p.estimatedCost)}</>}
                action={isPAOverdue(p, now) ? <Badge tone="red">Past 24h deadline</Badge> : <Badge tone="amber">Due within 24h</Badge>}
              >
                <p>{p.description}</p>
                <p className="muted small">
                  {p.patientName} ({p.enrolleeId}) · {providerById(p.providerId)?.name} · requested {new Date(p.requestedAt).toLocaleString('en-GB')}
                </p>
                <div className="inline">
                  <input aria-label={`Note for ${p.code}`} placeholder="Medical officer note" maxLength={500} value={notes[p.code] ?? ''} onChange={(ev) => setNotes({ ...notes, [p.code]: ev.target.value })} />
                  <button className="secondary small" disabled={decide.isPending} onClick={() => decide.mutate({ code: p.code, approve: true, note: notes[p.code]?.trim() || 'Clinically justified.' })}>
                    <Check size={14} aria-hidden /> Approve
                  </button>
                  <button className="danger small" disabled={decide.isPending} onClick={() => decide.mutate({ code: p.code, approve: false, note: notes[p.code]?.trim() || 'Not clinically justified.' })}>
                    <X size={14} aria-hidden /> Deny
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )
      }
    </Loadable>
  );
}

function ComplaintQueue() {
  const q = useComplaints();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const resolve = useApiMutation(({ id, resolution }: { id: string; resolution: string }) => api(`/hmo/complaints/${id}/resolve`, { body: { resolution } }), [HMO]);
  const hoursOpen = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return (
    <Loadable q={q}>
      {(rows) => {
        const list = [...rows].sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || b.createdAt.localeCompare(a.createdAt));
        if (!list.length) return <Empty>No complaints.</Empty>;
        return (
          <div className="stack">
            {resolve.error && <ErrorNotice error={resolve.error} />}
            {list.slice(0, 30).map((c) => (
              <Card key={c.id} title={`${c.id} · ${COMPLAINT_LABELS[c.category]}`} action={<ComplaintBadge c={c} />}>
                <p>{c.description}</p>
                <p className="muted small">
                  {c.patientName} · {providerById(c.providerId ?? '')?.name} · {prettyDate(c.createdAt)} via {c.channel.toUpperCase()}
                  {c.status === 'open' && hoursOpen(c.createdAt) > 48 && (
                    <>
                      {' '}
                      · <Badge tone="red">48h deadline missed</Badge>
                    </>
                  )}
                </p>
                {c.status === 'resolved' ? (
                  <p className="small">✓ {c.resolution}</p>
                ) : (
                  <div className="inline">
                    <input aria-label={`Resolution for ${c.id}`} placeholder="What did you do?" maxLength={1000} value={notes[c.id] ?? ''} onChange={(ev) => setNotes({ ...notes, [c.id]: ev.target.value })} />
                    <button className="secondary small" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: c.id, resolution: notes[c.id]?.trim() || 'Provider contacted and issue resolved; member informed.' })}>
                      Mark resolved
                    </button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        );
      }}
    </Loadable>
  );
}

function CapitationRun() {
  const meta = useMeta();
  const month = today(meta.data).slice(0, 7);
  const q = useCapitation();
  const generate = useApiMutation(() => api('/hmo/capitation/runs', { body: { month } }), [HMO]);
  const pay = useApiMutation((id: string) => api(`/hmo/capitation/${encodeURIComponent(id)}/pay`, { method: 'POST' }), [HMO]);
  return (
    <Card
      title="Capitation to primary providers"
      action={
        <button className="secondary small" disabled={generate.isPending} onClick={() => generate.mutate(undefined)}>
          {generate.isPending ? 'Calculating…' : `Calculate ${month}`}
        </button>
      }
    >
      <p className="muted small">Calculated from members with active cover at each clinic. Recalculating updates unpaid months only.</p>
      {(generate.error || pay.error) && <ErrorNotice error={generate.error ?? pay.error} />}
      <Loadable q={q}>
        {(rows) => {
          const sorted = [...rows].sort((a, b) => (a.paidAt ? 1 : 0) - (b.paidAt ? 1 : 0) || a.month.localeCompare(b.month));
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Provider</th>
                    <th>Lives</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((c) => (
                    <tr key={c.id}>
                      <td>{c.month}</td>
                      <td>{providerById(c.providerId)?.name}</td>
                      <td>{c.lives}</td>
                      <td>{naira(c.amount)}</td>
                      <td>
                        {c.paidAt ? (
                          <Badge tone="green">Paid {prettyDate(c.paidAt)}</Badge>
                        ) : (
                          <button className="small" disabled={pay.isPending} onClick={() => pay.mutate(c.id)}>
                            Pay now {c.month < month && '(overdue)'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </Loadable>
    </Card>
  );
}
