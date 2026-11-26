import { AlertTriangle, BadgeCheck, CheckCircle2, Hospital, Scale, ThumbsDown, ThumbsUp } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { api } from '../api/client';
import type { MemberProfile, PaymentView } from '../api/types';
import { CATEGORY_LABELS, PROVIDERS, hmoById, planById, providerById, tariffByCode } from '../domain/catalog';
import { FREQUENCIES, quotePremium } from '../domain/pricing';
import type { Claim, Complaint, ComplaintCategory, PaymentFrequency, PaymentMethod, ServiceCategory } from '../domain/types';
import { naira, prettyDate } from '../domain/util';
import { useApiMutation, useApiQuery, useMeta } from '../state/session';
import { Badge, COMPLAINT_LABELS, Card, ClaimBadge, ComplaintBadge, CoverBadge, Empty, ErrorNotice, Field, Loadable, Meter, Notice, Stat, Tabs, pct } from '../ui/kit';

type Tab = 'overview' | 'benefits' | 'payments' | 'visits' | 'complaints';
const MEMBER = ['member'];

const useProfile = () => useApiQuery<MemberProfile>(['member', 'profile'], '/member/profile');
const useClaims = () => useApiQuery<Claim[]>(['member', 'claims'], '/member/claims');

export function Member({ tab, navigate }: { tab?: string; navigate: (p: string) => void }) {
  const current = (['overview', 'benefits', 'payments', 'visits', 'complaints'].includes(tab ?? '') ? tab : 'overview') as Tab;
  const profile = useProfile();
  const claims = useClaims();
  const unconfirmed = (claims.data ?? []).filter((c) => !c.enrolleeConfirmation && c.status !== 'rejected').length;

  return (
    <Loadable q={profile} label="Loading your cover…">
      {(p) => (
        <div className="stack">
          <div className="page-head">
            <div>
              <h1>
                Hello, {p.enrollee.firstName} <span className="muted thin">· {p.enrollee.id}</span>
              </h1>
              <p className="muted">
                {p.plan.name} with {hmoById(p.enrollee.hmoId).name}
              </p>
            </div>
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
          {current === 'overview' && <Overview p={p} unconfirmed={unconfirmed} navigate={navigate} />}
          {current === 'benefits' && <Benefits planId={p.enrollee.planId} />}
          {current === 'payments' && <Payments p={p} />}
          {current === 'visits' && <Visits />}
          {current === 'complaints' && <Complaints p={p} />}
        </div>
      )}
    </Loadable>
  );
}

function Overview({ p, unconfirmed, navigate }: { p: MemberProfile; unconfirmed: number; navigate: (p: string) => void }) {
  const e = p.enrollee;
  const elig = p.eligibility;
  const [changing, setChanging] = useState(false);
  const change = useApiMutation((providerId: string) => api('/member/primary-provider', { method: 'PUT', body: { providerId } }), [MEMBER]);
  const options = PROVIDERS.filter((x) => x.state === e.state && x.level === 'primary' && x.accredited && x.hmoIds.includes(e.hmoId));

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
                <span>{p.plan.name}</span>
                <span>{p.primaryProvider?.name}</span>
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
          <Stat label="Next payment" value={p.nextPayment ? naira(p.nextPayment.installment) : 'Sponsored'} hint={p.nextPayment ? FREQUENCIES[e.frequency].label : e.sponsor} />
        </div>
        <Card title={`Benefit used this year`}>
          <p className="big-number">
            {naira(p.benefitUsedThisYear)} <span className="muted thin">of {naira(p.plan.annualLimit)}</span>
          </p>
          <Meter value={p.benefitUsedThisYear / p.plan.annualLimit} label="Annual limit used" />
        </Card>
        <Card
          title={<><Hospital size={18} aria-hidden /> My primary hospital</>}
          action={
            <button className="ghost small" onClick={() => setChanging(!changing)}>
              {changing ? 'Cancel' : 'Change'}
            </button>
          }
        >
          <p>
            <strong>{p.primaryProvider?.name}</strong>
            <br />
            <span className="muted small">
              {p.primaryProvider?.lga}, {p.primaryProvider?.state} · {p.primaryProvider?.phone}
            </span>
          </p>
          {changing && (
            <div className="stack-sm">
              {options.map((x) => (
                <button
                  key={x.id}
                  className={x.id === e.primaryProviderId ? 'secondary small' : 'ghost small'}
                  disabled={x.id === e.primaryProviderId || change.isPending}
                  onClick={() => change.mutate(x.id, { onSuccess: () => setChanging(false) })}
                >
                  {x.name} ({x.lga})
                </button>
              ))}
              {change.error && <ErrorNotice error={change.error} />}
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
      <Card title={<><Scale size={18} aria-hidden /> Know your rights</>}>
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

const PAY_LABEL: Record<PaymentFrequency, string> = { daily: '1 day', weekly: '1 week', monthly: '1 month', quarterly: '3 months', annual: '1 year' };
const METHOD_LABEL: Record<string, string> = { ussd: 'USSD', mobile_money: 'Mobile money', card: 'Card', bank_transfer: 'Bank transfer', agent: 'Agent (cash)', sponsor: 'Sponsor' };

function Payments({ p }: { p: MemberProfile }) {
  const e = p.enrollee;
  const meta = useMeta();
  const history = useApiQuery<PaymentView[]>(['member', 'payments'], '/member/payments');
  const [frequency, setFrequency] = useState<PaymentFrequency>(e.frequency);
  const [method, setMethod] = useState<PaymentMethod>('ussd');
  const q = quotePremium({ planId: e.planId, dependants: e.dependants, frequency, groupCode: e.groupCode, sector: e.sector });
  const start = useApiMutation(() => api<PaymentView>('/member/payments', { body: { frequency, method } }), [MEMBER]);
  const simulate = useApiMutation((ref: string) => api(`/dev/payments/${encodeURIComponent(ref)}/confirm`, { method: 'POST' }), [MEMBER]);

  return (
    <div className="grid two">
      <Card title="Pay premium">
        {e.sector === 'vulnerable' ? (
          <Notice tone="green">Your cover is sponsored by {e.sponsor}. Nothing to pay.</Notice>
        ) : (
          <div className="stack-sm">
            <p className="muted small">
              Paid through <strong>{prettyDate(e.paidThrough)}</strong> <CoverBadge status={p.eligibility.status} />
            </p>
            <div className="form-grid">
              <Field label="Pay for">
                <select value={frequency} onChange={(ev) => setFrequency(ev.target.value as PaymentFrequency)}>
                  {(Object.keys(FREQUENCIES) as PaymentFrequency[]).map((k) => (
                    <option key={k} value={k}>
                      {PAY_LABEL[k]}
                      {FREQUENCIES[k].discount ? ` (save ${pct(FREQUENCIES[k].discount)})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Method">
                <select value={method} onChange={(ev) => setMethod(ev.target.value as PaymentMethod)}>
                  {['ussd', 'mobile_money', 'card', 'bank_transfer', 'agent'].map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button disabled={start.isPending} onClick={() => start.mutate(undefined)}>
              {start.isPending ? 'Starting payment…' : `Pay ${naira(q.installment)}`}
            </button>
            {start.error && <ErrorNotice error={start.error} />}
            {start.data && (
              <Notice tone="blue">
                Payment {start.data.reference} for {naira(start.data.amount)} started. Approve it on your phone or card — your cover is extended as soon as the payment provider confirms it.
              </Notice>
            )}
            {e.groupCode && <p className="muted small">Group discount applied ({e.groupCode}).</p>}
          </div>
        )}
      </Card>
      <Card title="Payment history">
        <Loadable q={history}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty>No payments yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Amount</th>
                      <th>Method</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 15).map((x) => (
                      <tr key={x.reference}>
                        <td className="nowrap">{x.paidAt ? prettyDate(x.paidAt) : 'Pending'}</td>
                        <td>{naira(x.amount)}</td>
                        <td className="small">{METHOD_LABEL[x.method] ?? x.method}</td>
                        <td>
                          {x.status === 'confirmed' ? (
                            <Badge tone="green">Paid · {x.daysCovered}d</Badge>
                          ) : x.status === 'failed' ? (
                            <Badge tone="red">Failed</Badge>
                          ) : (
                            <span className="inline-actions">
                              <Badge tone="amber">Pending</Badge>
                              {meta.data?.devGateway && (
                                <button className="ghost small" disabled={simulate.isPending} title="Development only: acts as the payment gateway" onClick={() => simulate.mutate(x.reference)}>
                                  Simulate gateway OK
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Loadable>
        {simulate.error && <ErrorNotice error={simulate.error} />}
      </Card>
    </div>
  );
}

function Visits() {
  const claims = useClaims();
  const respond = useApiMutation(({ id, answer }: { id: string; answer: 'confirmed' | 'disputed' }) => api<Claim>(`/member/claims/${id}/response`, { body: { answer } }), [MEMBER]);
  return (
    <Loadable q={claims}>
      {(rows) =>
        rows.length === 0 ? (
          <Empty>No hospital visits have been billed to your cover yet.</Empty>
        ) : (
          <div className="stack">
            <p className="muted">Every bill a hospital sends in your name appears here. If you didn't receive a service, tell us — the claim is frozen and investigated.</p>
            {respond.error && <ErrorNotice error={respond.error} />}
            {[...rows]
              .sort((a, b) => b.encounterDate.localeCompare(a.encounterDate))
              .map((c) => (
                <Card key={c.id} title={<>{prettyDate(c.encounterDate)} · {providerById(c.providerId)?.name}</>} action={<ClaimBadge claim={c} />}>
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
                      <button className="secondary small" disabled={respond.isPending} onClick={() => respond.mutate({ id: c.id, answer: 'confirmed' })}>
                        <ThumbsUp size={14} aria-hidden /> Yes, I had this
                      </button>
                      <button className="danger small" disabled={respond.isPending} onClick={() => respond.mutate({ id: c.id, answer: 'disputed' })}>
                        <ThumbsDown size={14} aria-hidden /> I didn't receive this
                      </button>
                    </div>
                  )}
                </Card>
              ))}
          </div>
        )
      }
    </Loadable>
  );
}

function Complaints({ p }: { p: MemberProfile }) {
  const e = p.enrollee;
  const list = useApiQuery<Complaint[]>(['member', 'complaints'], '/member/complaints');
  const [category, setCategory] = useState<ComplaintCategory>('asked_to_pay');
  const [description, setDescription] = useState('');
  const [providerId, setProviderId] = useState(e.primaryProviderId);
  const file = useApiMutation(() => api<Complaint>('/member/complaints', { body: { category, description: description.trim(), providerId } }), [MEMBER]);

  return (
    <div className="grid two">
      <Card title="Report a problem">
        <form
          className="stack-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            file.mutate(undefined, { onSuccess: () => setDescription('') });
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
              {PROVIDERS.filter((x) => x.hmoIds.includes(e.hmoId)).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Details (optional)">
            <textarea rows={3} maxLength={1000} value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="e.g. They asked me to pay ₦5,000 for malaria drugs" />
          </Field>
          <button type="submit" disabled={file.isPending}>
            {file.isPending ? 'Sending…' : 'Send to my HMO'}
          </button>
          {file.error && <ErrorNotice error={file.error} />}
          {file.data && (
            <Notice tone="green">
              <CheckCircle2 size={16} aria-hidden /> Complaint {file.data.id} logged. {hmoById(e.hmoId).name} must respond within 48 hours or it is escalated to the regulator.
            </Notice>
          )}
        </form>
      </Card>
      <Card title="My complaints">
        <Loadable q={list}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty>No complaints filed.</Empty>
            ) : (
              <ul className="list">
                {rows.map((c) => (
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
            )
          }
        </Loadable>
      </Card>
    </div>
  );
}
