import { AlertTriangle, BadgeCheck, CheckCircle2, Hospital, Scale, ThumbsDown, ThumbsUp } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { utilisedInYear } from '../domain/adjudication';
import { CATEGORY_LABELS, PROVIDERS, hmoById, planById, providerById, tariffByCode } from '../domain/catalog';
import { DEMO_PERSONAS } from '../domain/seed';
import { FREQUENCIES, checkEligibility, quotePremium } from '../domain/pricing';
import type { ComplaintCategory, PaymentFrequency, PaymentMethod, ServiceCategory } from '../domain/types';
import { naira, prettyDate } from '../domain/util';
import { useStore } from '../state/store';
import { Badge, COMPLAINT_LABELS, Card, ClaimBadge, ComplaintBadge, CoverBadge, Empty, Field, Meter, Notice, Stat, Tabs, pct } from '../ui/kit';

type Tab = 'overview' | 'benefits' | 'payments' | 'visits' | 'complaints';

export function Member({ tab, navigate }: { tab?: string; navigate: (p: string) => void }) {
  const { db, today, acting, setActing } = useStore();
  const current = (['overview', 'benefits', 'payments', 'visits', 'complaints'].includes(tab ?? '') ? tab : 'overview') as Tab;
  const me = db.enrollees.find((e) => e.id === acting.memberId) ?? db.enrollees[0];
  const myClaims = db.claims.filter((c) => c.enrolleeId === me.id);
  const unconfirmed = myClaims.filter((c) => !c.enrolleeConfirmation && c.status !== 'rejected').length;

  // Named personas, anyone who enrolled during this demo, and whoever is currently selected.
  const personas = [...new Set([...Object.values(DEMO_PERSONAS), ...db.enrollees.filter((e) => e.enrolledOn === today).map((e) => e.id), me.id])];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>
            Hello, {me.firstName} <span className="muted thin">· {me.id}</span>
          </h1>
          <p className="muted">
            {planById(me.planId).name} with {hmoById(me.hmoId).name}
          </p>
        </div>
        <Field label="Viewing as (demo)">
          <select value={me.id} onChange={(e) => setActing({ memberId: e.target.value })}>
            {personas.map((id) => {
              const e = db.enrollees.find((x) => x.id === id)!;
              return (
                <option key={id} value={id}>
                  {e.firstName} {e.lastName} — {e.sector}, {e.state}
                </option>
              );
            })}
          </select>
        </Field>
      </div>
      <Tabs<Tab>
        value={current}
        onChange={(t) => navigate(`member/${t}`)}
        tabs={[
          ['overview', 'Overview'],
          ['benefits', 'My benefits'],
          ['payments', 'Payments'],
          ['visits', <>Visits & bills {unconfirmed > 0 && <span className="count">{unconfirmed}</span>}</>],
          ['complaints', 'Complaints'],
        ]}
      />
      {current === 'overview' && <Overview memberId={me.id} navigate={navigate} unconfirmed={unconfirmed} />}
      {current === 'benefits' && <Benefits planId={me.planId} />}
      {current === 'payments' && <Payments memberId={me.id} />}
      {current === 'visits' && <Visits memberId={me.id} />}
      {current === 'complaints' && <Complaints memberId={me.id} />}
    </div>
  );
}

function Overview({ memberId, unconfirmed, navigate }: { memberId: string; unconfirmed: number; navigate: (p: string) => void }) {
  const store = useStore();
  const { db, today } = store;
  const e = db.enrollees.find((x) => x.id === memberId)!;
  const plan = planById(e.planId);
  const elig = checkEligibility(e, today);
  const used = utilisedInYear(e.id, today.slice(0, 4), db.claims);
  const provider = providerById(e.primaryProviderId);
  const [changing, setChanging] = useState(false);
  const options = PROVIDERS.filter((p) => p.state === e.state && p.level === 'primary' && p.accredited && p.hmoIds.includes(e.hmoId));
  return (
    <div className="grid two">
      <div className="stack">
        <div className="idcard big">
          <div className="idcard-top">
            <span>HealthGuard</span>
            <BadgeCheck size={18} aria-hidden />
          </div>
          <div className="idcard-row">
            <div>
              <div className="idcard-id">{e.id}</div>
              <div className="idcard-name">
                {e.firstName} {e.lastName}
                {e.dependants > 0 && <span className="thin"> + {e.dependants} dependant(s)</span>}
              </div>
              <div className="idcard-meta">
                <span>{plan.name}</span>
                <span>{provider?.name}</span>
              </div>
            </div>
            <div className="qr">
              <QRCodeSVG value={e.id} size={84} />
            </div>
          </div>
          <div className="idcard-status">Show this card or say your ID at reception. No card? Your phone number works too.</div>
        </div>
        {elig.status !== 'active' && (
          <Notice tone={elig.status === 'lapsed' || elig.status === 'unpaid' ? 'red' : 'amber'}>
            <AlertTriangle size={16} aria-hidden /> {elig.message}{' '}
            {(elig.status === 'lapsed' || elig.status === 'grace' || elig.status === 'unpaid') && (
              <a className="link" href="#/member/payments">
                Pay now
              </a>
            )}
          </Notice>
        )}
        {unconfirmed > 0 && (
          <Notice tone="blue">
            {unconfirmed} hospital visit(s) were billed to your cover. <a className="link" href="#/member/visits">Check they are genuine</a> — it protects your benefit limit.
          </Notice>
        )}
      </div>
      <div className="stack">
        <div className="grid two tight">
          <Stat label="Cover status" value={<CoverBadge status={elig.status} />} hint={`Paid through ${prettyDate(e.paidThrough)}`} />
          <Stat label="Next payment" value={e.sector === 'vulnerable' ? 'Sponsored' : naira(quotePremium({ ...e, groupCode: e.groupCode }).installment)} hint={e.sector === 'vulnerable' ? e.sponsor : `${FREQUENCIES[e.frequency].label}`} />
        </div>
        <Card title={`Benefit used in ${today.slice(0, 4)}`}>
          <p className="big-number">
            {naira(used)} <span className="muted thin">of {naira(plan.annualLimit)}</span>
          </p>
          <Meter value={used / plan.annualLimit} label="Annual limit used" />
        </Card>
        <Card
          title={
            <>
              <Hospital size={18} aria-hidden /> My primary hospital
            </>
          }
          action={
            <button className="ghost small" onClick={() => setChanging(!changing)}>
              {changing ? 'Cancel' : 'Change'}
            </button>
          }
        >
          <p>
            <strong>{provider?.name}</strong>
            <br />
            <span className="muted small">
              {provider?.lga}, {provider?.state} · {provider?.phone}
            </span>
          </p>
          {changing && (
            <div className="stack-sm">
              {options.map((p) => (
                <button
                  key={p.id}
                  className={p.id === e.primaryProviderId ? 'secondary small' : 'ghost small'}
                  disabled={p.id === e.primaryProviderId}
                  onClick={() => {
                    store.changeProvider(e.id, p.id);
                    setChanging(false);
                  }}
                >
                  {p.name} ({p.lga})
                </button>
              ))}
              <p className="muted small">Unhappy with your hospital? You can switch at any time — capitation follows you.</p>
            </div>
          )}
        </Card>
        <div className="actions">
          <button onClick={() => navigate('member/payments')}>Pay premium</button>
          <button className="secondary" onClick={() => navigate('member/complaints')}>
            Report a problem
          </button>
        </div>
      </div>
    </div>
  );
}

function Benefits({ planId }: { planId: string }) {
  const plan = planById(planId);
  return (
    <div className="grid two wide-left">
      <Card title={`What ${plan.name} covers`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Covered?</th>
                <th>You pay</th>
                <th>Approval needed</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(plan.benefits) as ServiceCategory[]).map((k) => {
                const b = plan.benefits[k];
                return (
                  <tr key={k}>
                    <td>{CATEGORY_LABELS[k]}</td>
                    <td>{b.covered ? <Badge tone="green">Covered</Badge> : <Badge tone="gray">Not covered</Badge>}</td>
                    <td>{!b.covered ? '—' : b.copay ? `${pct(b.copay)} of the bill` : 'Nothing'}</td>
                    <td className="small">
                      {!b.covered ? '—' : b.requiresPA ? 'Hospital gets a code from your HMO' : 'No'}
                      {b.perVisitCap ? ` · up to ${naira(b.perVisitCap)} per visit` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Annual limit {naira(plan.annualLimit)} · {plan.waitingPeriodDays}-day waiting period for new members (emergencies always covered).
        </p>
      </Card>
      <Card
        title={
          <>
            <Scale size={18} aria-hidden /> Know your rights
          </>
        }
      >
        <ul className="checklist">
          <li>A hospital must never ask you to pay cash for a covered service. The only charge is the co-pay shown here.</li>
          <li>Emergency care must be given first — paperwork comes after.</li>
          <li>You never need to chase an approval code yourself. The hospital requests it; routine codes are issued in seconds.</li>
          <li>You can see every bill sent in your name and dispute anything you did not receive.</li>
          <li>Your HMO must respond to a complaint within 48 hours, or it goes to the regulator automatically.</li>
          <li>You may change your primary hospital whenever you want.</li>
        </ul>
      </Card>
    </div>
  );
}

function Payments({ memberId }: { memberId: string }) {
  const { db, pay, today } = useStore();
  const e = db.enrollees.find((x) => x.id === memberId)!;
  const [frequency, setFrequency] = useState<PaymentFrequency>(e.frequency);
  const [method, setMethod] = useState<PaymentMethod>('ussd');
  const [receipt, setReceipt] = useState<{ amount: number; paidThrough: string } | null>(null);
  const q = quotePremium({ planId: e.planId, dependants: e.dependants, frequency, groupCode: e.groupCode, sector: e.sector });
  const history = db.payments.filter((p) => p.enrolleeId === e.id).sort((a, b) => b.paidAt.localeCompare(a.paidAt));
  const elig = checkEligibility(e, today);

  return (
    <div className="grid two">
      <Card title="Pay premium">
        {e.sector === 'vulnerable' ? (
          <Notice tone="green">Your cover is sponsored by {e.sponsor}. Nothing to pay.</Notice>
        ) : (
          <div className="stack-sm">
            <p className="muted small">
              Paid through <strong>{prettyDate(e.paidThrough)}</strong> <CoverBadge status={elig.status} />
            </p>
            <div className="form-grid">
              <Field label="Pay for">
                <select value={frequency} onChange={(ev) => setFrequency(ev.target.value as PaymentFrequency)}>
                  {Object.entries(FREQUENCIES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.days === 1 ? '1 day' : v.days === 7 ? '1 week' : v.days === 30 ? '1 month' : v.days === 91 ? '3 months' : '1 year'}
                      {v.discount ? ` (save ${pct(v.discount)})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Method">
                <select value={method} onChange={(ev) => setMethod(ev.target.value as PaymentMethod)}>
                  <option value="ussd">USSD</option>
                  <option value="mobile_money">Mobile money</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="agent">Agent (cash)</option>
                </select>
              </Field>
            </div>
            <button onClick={() => setReceipt(pay(e.id, frequency, method))}>Pay {naira(q.installment)}</button>
            {receipt && (
              <Notice tone="green">
                <CheckCircle2 size={16} aria-hidden /> {naira(receipt.amount)} received. Covered through {prettyDate(receipt.paidThrough)}.
              </Notice>
            )}
            {e.groupCode && <p className="muted small">Group discount applied ({e.groupCode}).</p>}
          </div>
        )}
      </Card>
      <Card title="Payment history">
        {history.length === 0 ? (
          <Empty>No payments yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Covers</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 12).map((p) => (
                  <tr key={p.id}>
                    <td>{prettyDate(p.paidAt)}</td>
                    <td>{naira(p.amount)}</td>
                    <td className="small">{p.method.replace('_', ' ')}</td>
                    <td className="small">{p.daysCovered} day(s)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Visits({ memberId }: { memberId: string }) {
  const { db, respondToClaim } = useStore();
  const claims = db.claims.filter((c) => c.enrolleeId === memberId).sort((a, b) => b.encounterDate.localeCompare(a.encounterDate));
  if (!claims.length) return <Empty>No hospital visits have been billed to your cover yet.</Empty>;
  return (
    <div className="stack">
      <p className="muted">Every bill a hospital sends in your name appears here. If you didn't receive a service, tell us — the claim is frozen and investigated.</p>
      {claims.map((c) => (
        <Card
          key={c.id}
          title={
            <>
              {prettyDate(c.encounterDate)} · {providerById(c.providerId)?.name}
            </>
          }
          action={<ClaimBadge claim={c} />}
        >
          <p className="muted small">
            {c.id} · {c.diagnosis}
          </p>
          <ul className="lines">
            {c.lines.map((l, i) => (
              <li key={i}>
                <span>
                  {tariffByCode(l.tariffCode)?.description ?? l.tariffCode} × {l.quantity}
                </span>
                <span>{naira(l.unitPrice * l.quantity)}</span>
              </li>
            ))}
          </ul>
          <div className="visit-totals">
            <span>
              Insurer pays <strong>{naira(c.approvedTotal)}</strong>
            </span>
            <span>
              Your co-pay <strong>{naira(c.copayTotal)}</strong>
            </span>
          </div>
          {c.enrolleeConfirmation === 'confirmed' && <Badge tone="green">You confirmed this visit</Badge>}
          {c.enrolleeConfirmation === 'disputed' && <Badge tone="red">You disputed this — under investigation</Badge>}
          {!c.enrolleeConfirmation && c.status !== 'rejected' && (
            <div className="actions">
              <button className="secondary small" onClick={() => respondToClaim(c.id, 'confirmed')}>
                <ThumbsUp size={14} aria-hidden /> Yes, I had this
              </button>
              <button className="danger small" onClick={() => respondToClaim(c.id, 'disputed')}>
                <ThumbsDown size={14} aria-hidden /> I didn't receive this
              </button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Complaints({ memberId }: { memberId: string }) {
  const { db, fileComplaint } = useStore();
  const e = db.enrollees.find((x) => x.id === memberId)!;
  const [category, setCategory] = useState<ComplaintCategory>('asked_to_pay');
  const [description, setDescription] = useState('');
  const [providerId, setProviderId] = useState(e.primaryProviderId);
  const [sent, setSent] = useState<string | null>(null);
  const mine = db.complaints.filter((c) => c.enrolleeId === memberId);

  return (
    <div className="grid two">
      <Card title="Report a problem">
        <form
          className="stack-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            const c = fileComplaint({ enrolleeId: e.id, category, description: description.trim() || COMPLAINT_LABELS[category], providerId, channel: 'app' });
            setSent(c.id);
            setDescription('');
          }}
        >
          <Field label="What happened?">
            <select value={category} onChange={(ev) => setCategory(ev.target.value as ComplaintCategory)}>
              {Object.entries(COMPLAINT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Where?">
            <select value={providerId} onChange={(ev) => setProviderId(ev.target.value)}>
              {PROVIDERS.filter((p) => p.hmoIds.includes(e.hmoId)).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Details (optional)">
            <textarea rows={3} value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="e.g. They asked me to pay ₦5,000 for malaria drugs" />
          </Field>
          <button type="submit">Send to my HMO</button>
          {sent && (
            <Notice tone="green">
              Complaint {sent} logged. {hmoById(e.hmoId).name} must respond within 48 hours or it is escalated to the regulator.
            </Notice>
          )}
        </form>
      </Card>
      <Card title="My complaints">
        {mine.length === 0 ? (
          <Empty>No complaints filed.</Empty>
        ) : (
          <ul className="list">
            {mine.map((c) => (
              <li key={c.id}>
                <div className="list-row">
                  <strong>{COMPLAINT_LABELS[c.category]}</strong>
                  <ComplaintBadge c={c} />
                </div>
                <span className="muted small">
                  {c.id} · {prettyDate(c.createdAt)} · {providerById(c.providerId ?? '')?.name} · via {c.channel.toUpperCase()}
                </span>
                {c.resolution && <span className="small">Resolution: {c.resolution}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
