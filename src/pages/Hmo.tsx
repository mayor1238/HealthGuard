import { AlertTriangle, Check, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { canPay } from '../domain/adjudication';
import { claimAgeDays, hmoScorecard, isOverdue } from '../domain/analytics';
import { CATEGORY_LABELS, HMOS, hmoById, providerById, tariffByCode } from '../domain/catalog';
import { isPAOverdue } from '../domain/preauth';
import type { Claim } from '../domain/types';
import { naira, prettyDate } from '../domain/util';
import { useStore } from '../state/store';
import { Badge, COMPLAINT_LABELS, Card, ClaimBadge, ComplaintBadge, Empty, Field, Notice, Stat, Tabs, pct } from '../ui/kit';

type Tab = 'overview' | 'review' | 'payments' | 'preauth' | 'complaints' | 'capitation';

export function HmoPortal({ tab, navigate }: { tab?: string; navigate: (p: string) => void }) {
  const { db, acting, setActing, today, nowIso } = useStore();
  const hmo = hmoById(acting.hmoId);
  const claims = db.claims.filter((c) => c.hmoId === hmo.id);
  const toReview = claims.filter((c) => c.status === 'pending_review');
  const toPay = claims.filter(canPay);
  const pendingPA = db.paRequests.filter((p) => p.hmoId === hmo.id && p.status === 'pending');
  const openComplaints = db.complaints.filter((c) => c.hmoId === hmo.id && c.status !== 'resolved');
  const unpaidCap = db.capitation.filter((c) => c.hmoId === hmo.id && !c.paidAt);
  const tabs: [Tab, React.ReactNode][] = [
    ['overview', 'Overview'],
    ['review', <>Review queue <Count n={toReview.length} /></>],
    ['payments', <>Pay providers <Count n={toPay.length} /></>],
    ['preauth', <>PA requests <Count n={pendingPA.length} /></>],
    ['complaints', <>Complaints <Count n={openComplaints.length} /></>],
    ['capitation', <>Capitation <Count n={unpaidCap.length} /></>],
  ];
  const current = (tabs.some(([t]) => t === tab) ? tab : 'overview') as Tab;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{hmo.name}</h1>
          <p className="muted">Claims payment target: {hmo.claimsSlaDays} days from submission</p>
        </div>
        <Field label="Signed in as (demo)">
          <select value={hmo.id} onChange={(e) => setActing({ hmoId: e.target.value })}>
            {HMOS.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Tabs<Tab> value={current} onChange={(t) => navigate(`hmo/${t}`)} tabs={tabs} />
      {current === 'overview' && <Overview hmoId={hmo.id} />}
      {current === 'review' && <Review claims={toReview} />}
      {current === 'payments' && <Payments claims={toPay} />}
      {current === 'preauth' && <PreAuthQueue hmoId={hmo.id} nowIso={nowIso()} />}
      {current === 'complaints' && <ComplaintQueue hmoId={hmo.id} nowIso={nowIso()} />}
      {current === 'capitation' && <CapitationRun hmoId={hmo.id} today={today} />}
    </div>
  );
}

const Count = ({ n }: { n: number }) => (n > 0 ? <span className="count">{n}</span> : null);

function Overview({ hmoId }: { hmoId: string }) {
  const { db, today } = useStore();
  const s = useMemo(() => hmoScorecard(db, today).find((x) => x.hmoId === hmoId)!, [db, today, hmoId]);
  const hmo = hmoById(hmoId);
  return (
    <div className="stack">
      <div className="grid four tight">
        <Stat label="Members" value={s.enrollees} hint={`${s.activeEnrollees} with active cover`} />
        <Stat label="Avg days to pay a claim" value={s.avgDaysToPay.toFixed(1)} tone={s.avgDaysToPay > hmo.claimsSlaDays ? 'red' : 'green'} hint={`Target ≤ ${hmo.claimsSlaDays}`} />
        <Stat label="Claims paid within target" value={pct(s.paidWithinSla)} />
        <Stat label="Overdue claims" value={s.overdueClaims} tone={s.overdueClaims ? 'red' : undefined} />
        <Stat label="Premiums (90 days)" value={naira(s.premiums)} />
        <Stat label="Medical loss ratio (90 days)" value={pct(s.medicalLossRatio)} hint="Claims + capitation ÷ premiums" />
        <Stat label="Complaints resolved" value={pct(s.complaintResolution)} hint={`${s.complaintsPer1000.toFixed(0)} per 1,000 members`} />
        <Stat label="PA decided instantly" value={pct(s.paAutoRate)} />
      </div>
      {s.avgDaysToPay > hmo.claimsSlaDays && (
        <Notice tone="red">
          <AlertTriangle size={16} aria-hidden /> You are paying providers slower than the {hmo.claimsSlaDays}-day target. This is visible on the regulator's league table and to members choosing an HMO.
        </Notice>
      )}
    </div>
  );
}

function ClaimDetail({ c }: { c: Claim }) {
  const { db } = useStore();
  const e = db.enrollees.find((x) => x.id === c.enrolleeId);
  return (
    <>
      <p className="muted small">
        {providerById(c.providerId)?.name} · {e?.firstName} {e?.lastName} ({c.enrolleeId}) · visit {prettyDate(c.encounterDate)} · {c.diagnosis}
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

function Review({ claims }: { claims: Claim[] }) {
  const { review } = useStore();
  const [notes, setNotes] = useState<Record<string, string>>({});
  if (!claims.length) return <Empty>Nothing to review. Clean claims are decided automatically.</Empty>;
  return (
    <div className="stack">
      <p className="muted">Only claims the fraud engine flagged land here — everything else is decided automatically.</p>
      {[...claims].sort((a, b) => b.riskScore - a.riskScore).map((c) => (
        <Card
          key={c.id}
          title={
            <>
              {c.id} · {naira(c.billedTotal)}
            </>
          }
          action={<Badge tone={c.riskScore >= 70 ? 'red' : 'amber'}>Risk {c.riskScore}/100</Badge>}
        >
          <ul className="flags">
            {c.fraudFlags.map((f, i) => (
              <li key={i}>
                <Badge tone={f.severity === 'high' ? 'red' : f.severity === 'medium' ? 'amber' : 'gray'}>{f.rule.replace(/_/g, ' ').toLowerCase()}</Badge> {f.detail}
              </li>
            ))}
          </ul>
          <ClaimDetail c={c} />
          <div className="inline">
            <input aria-label={`Reviewer note for ${c.id}`} placeholder="Reviewer note" value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
            <button className="secondary small" onClick={() => review(c.id, 'approve', notes[c.id] || 'Verified with provider and member.')}>
              <Check size={14} aria-hidden /> Approve
            </button>
            <button className="danger small" onClick={() => review(c.id, 'reject', notes[c.id] || c.fraudFlags[0]?.detail || 'Rejected')}>
              <X size={14} aria-hidden /> Reject
            </button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Payments({ claims }: { claims: Claim[] }) {
  const { payClaims, today } = useStore();
  const sorted = [...claims].sort((a, b) => claimAgeDays(b, today) - claimAgeDays(a, today));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paid, setPaid] = useState<number | null>(null);
  const total = sorted.filter((c) => selected.has(c.id)).reduce((s, c) => s + c.approvedTotal, 0);
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSelected(n);
  };

  return (
    <div className="stack">
      {paid !== null && <Notice tone="green">{naira(paid)} sent to providers. They can see it immediately in their portal.</Notice>}
      {sorted.length === 0 ? (
        <Empty>All approved claims are paid. 🎉</Empty>
      ) : (
        <>
          <div className="actions spread">
            <div className="actions">
              <button className="ghost small" onClick={() => setSelected(new Set(sorted.map((c) => c.id)))}>
                Select all ({sorted.length})
              </button>
              <button className="ghost small" onClick={() => setSelected(new Set(sorted.filter((c) => isOverdue(c, today)).map((c) => c.id)))}>
                Select overdue
              </button>
            </div>
            <button
              disabled={selected.size === 0}
              onClick={() => {
                setPaid(payClaims([...selected]));
                setSelected(new Set());
              }}
            >
              Pay {selected.size} claim(s) · {naira(total)}
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
                    <td>{naira(c.approvedTotal)}</td>
                    <td>
                      <ClaimBadge claim={c} />
                    </td>
                    <td>
                      {claimAgeDays(c, today)} days {isOverdue(c, today) && <Badge tone="red">Overdue</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function PreAuthQueue({ hmoId, nowIso }: { hmoId: string; nowIso: string }) {
  const { db, decidePAManually } = useStore();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const pending = db.paRequests.filter((p) => p.hmoId === hmoId && p.status === 'pending');
  if (!pending.length) return <Empty>No PA requests waiting. Routine requests are approved instantly.</Empty>;
  return (
    <div className="stack">
      {pending.map((p) => {
        const e = db.enrollees.find((x) => x.id === p.enrolleeId)!;
        return (
          <Card
            key={p.code}
            title={
              <>
                {p.code} · {CATEGORY_LABELS[p.category]} · {naira(p.estimatedCost)}
              </>
            }
            action={isPAOverdue(p, nowIso) ? <Badge tone="red">Past 24h deadline</Badge> : <Badge tone="amber">Due within 24h</Badge>}
          >
            <p>{p.description}</p>
            <p className="muted small">
              {e.firstName} {e.lastName} ({e.id}) · {providerById(p.providerId)?.name} · requested {new Date(p.requestedAt).toLocaleString('en-GB')}
            </p>
            <div className="inline">
              <input aria-label={`Note for ${p.code}`} placeholder="Medical officer note" value={notes[p.code] ?? ''} onChange={(ev) => setNotes({ ...notes, [p.code]: ev.target.value })} />
              <button className="secondary small" onClick={() => decidePAManually(p.code, true, notes[p.code] || 'Clinically justified.')}>
                <Check size={14} aria-hidden /> Approve
              </button>
              <button className="danger small" onClick={() => decidePAManually(p.code, false, notes[p.code] || 'Not clinically justified.')}>
                <X size={14} aria-hidden /> Deny
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ComplaintQueue({ hmoId, nowIso }: { hmoId: string; nowIso: string }) {
  const { db, resolveComplaint } = useStore();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const list = db.complaints.filter((c) => c.hmoId === hmoId).sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || b.createdAt.localeCompare(a.createdAt));
  const hoursOpen = (iso: string) => (new Date(nowIso).getTime() - new Date(iso).getTime()) / 3_600_000;
  return (
    <div className="stack">
      {list.length === 0 && <Empty>No complaints.</Empty>}
      {list.slice(0, 30).map((c) => {
        const e = db.enrollees.find((x) => x.id === c.enrolleeId);
        return (
          <Card key={c.id} title={`${c.id} · ${COMPLAINT_LABELS[c.category]}`} action={<ComplaintBadge c={c} />}>
            <p>{c.description}</p>
            <p className="muted small">
              {e?.firstName} {e?.lastName} · {providerById(c.providerId ?? '')?.name} · {prettyDate(c.createdAt)} via {c.channel.toUpperCase()}
              {c.status === 'open' && hoursOpen(c.createdAt) > 48 && <> · <Badge tone="red">48h deadline missed</Badge></>}
            </p>
            {c.status === 'resolved' ? (
              <p className="small">✓ {c.resolution}</p>
            ) : (
              <div className="inline">
                <input aria-label={`Resolution for ${c.id}`} placeholder="What did you do?" value={notes[c.id] ?? ''} onChange={(ev) => setNotes({ ...notes, [c.id]: ev.target.value })} />
                <button className="secondary small" onClick={() => resolveComplaint(c.id, notes[c.id] || 'Provider contacted and issue resolved; member informed.')}>
                  Mark resolved
                </button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function CapitationRun({ hmoId, today }: { hmoId: string; today: string }) {
  const { db, payCapitation } = useStore();
  const rows = db.capitation.filter((c) => c.hmoId === hmoId).sort((a, b) => (a.paidAt ? 1 : 0) - (b.paidAt ? 1 : 0) || a.month.localeCompare(b.month));
  return (
    <Card title="Capitation to primary providers">
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
            {rows.map((c) => (
              <tr key={c.id}>
                <td>{c.month}</td>
                <td>{providerById(c.providerId)?.name}</td>
                <td>{c.lives}</td>
                <td>{naira(c.amount)}</td>
                <td>
                  {c.paidAt ? (
                    <Badge tone="green">Paid {prettyDate(c.paidAt)}</Badge>
                  ) : (
                    <button className="small" onClick={() => payCapitation(c.id)}>
                      Pay now {c.month < today.slice(0, 7) && '(overdue)'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
