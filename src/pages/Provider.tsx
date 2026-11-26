import { CheckCircle2, Plus, Search, Trash2, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { adjudicate, utilisedInYear, type ClaimDraft } from '../domain/adjudication';
import { claimAgeDays, isAwaitingPayment, isOverdue } from '../domain/analytics';
import { CATEGORY_LABELS, DIAGNOSES, PROVIDERS, TARIFFS, hmoById, planById, providerById, tariffByCode } from '../domain/catalog';
import { PA_AUTO_APPROVE_LIMIT } from '../domain/preauth';
import { checkEligibility } from '../domain/pricing';
import type { ClaimLine, Enrollee, PARequest, Provider, ServiceCategory } from '../domain/types';
import { ageOn, isValidHealthGuardId, naira, prettyDate } from '../domain/util';
import { useStore } from '../state/store';
import { Badge, Card, ClaimBadge, CoverBadge, Empty, Field, Notice, PABadge, Stat, Tabs } from '../ui/kit';

type Tab = 'verify' | 'preauth' | 'claim' | 'claims' | 'capitation';
const TABS: [Tab, string][] = [
  ['verify', 'Verify patient'],
  ['preauth', 'PA codes'],
  ['claim', 'New claim'],
  ['claims', 'My claims'],
  ['capitation', 'Capitation'],
];

/** Find an enrollee by HealthGuard ID, phone number or NIN. */
function lookup(enrollees: Enrollee[], q: string): { enrollee?: Enrollee; error?: string } {
  const v = q.trim().toUpperCase();
  if (!v) return {};
  if (v.startsWith('HG-')) {
    if (!isValidHealthGuardId(v)) return { error: 'That ID fails its check digit — probably a typo. Ask the patient to read it again.' };
    const e = enrollees.find((x) => x.id === v);
    return e ? { enrollee: e } : { error: 'No member with this ID.' };
  }
  const digits = v.replace(/\D/g, '');
  const e = enrollees.find((x) => x.phone === digits || x.nin === digits);
  return e ? { enrollee: e } : { error: 'No member found for that phone number or NIN.' };
}

export function ProviderPortal({ tab, navigate }: { tab?: string; navigate: (p: string) => void }) {
  const { acting, setActing } = useStore();
  const current = (TABS.some(([t]) => t === tab) ? tab : 'verify') as Tab;
  const provider = providerById(acting.providerId)!;
  const [patientId, setPatientId] = useState('');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{provider.name}</h1>
          <p className="muted">
            {provider.level[0].toUpperCase() + provider.level.slice(1)} care · {provider.lga}, {provider.state} ·{' '}
            {provider.accredited ? <Badge tone="green">Accredited</Badge> : <Badge tone="red">Not accredited</Badge>}
          </p>
        </div>
        <Field label="Signed in as (demo)">
          <select value={provider.id} onChange={(e) => setActing({ providerId: e.target.value })}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.state}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Tabs<Tab> value={current} onChange={(t) => navigate(`provider/${t}`)} tabs={TABS} />
      {current === 'verify' && <Verify providerId={provider.id} onUse={(id, next) => { setPatientId(id); navigate(`provider/${next}`); }} />}
      {current === 'preauth' && <PreAuth providerId={provider.id} patientId={patientId} setPatientId={setPatientId} />}
      {current === 'claim' && <NewClaim providerId={provider.id} patientId={patientId} setPatientId={setPatientId} navigate={navigate} />}
      {current === 'claims' && <MyClaims providerId={provider.id} />}
      {current === 'capitation' && <Capitation providerId={provider.id} />}
    </div>
  );
}

function Verify({ providerId, onUse }: { providerId: string; onUse: (id: string, next: Tab) => void }) {
  const { db } = useStore();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const res = lookup(db.enrollees, submitted);
  const provider = providerById(providerId)!;
  const e = res.enrollee;

  return (
    <div className="grid two wide-right">
      <Card title="Check eligibility">
        <form
          className="stack-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            setSubmitted(q);
          }}
        >
          <Field label="HealthGuard ID, phone number or NIN" hint="Scan the QR on the member card, or type. Try HG-00000018 or 08061234567.">
            <div className="inline">
              <input value={q} onChange={(ev) => setQ(ev.target.value)} placeholder="HG-00000018" autoFocus />
              <button type="submit">
                <Search size={16} aria-hidden /> Check
              </button>
            </div>
          </Field>
        </form>
        {res.error && <Notice tone="red">{res.error}</Notice>}
        <p className="muted small">Results are live — no phone calls to the HMO, no waiting.</p>
      </Card>
      {e ? (
        <PatientCard e={e} onUse={onUse} provider={provider} />
      ) : (
        <Card>
          <Empty>Search for a patient to see their cover, benefits and what needs approval.</Empty>
        </Card>
      )}
    </div>
  );
}

function PatientCard({ e, onUse, provider }: { e: Enrollee; onUse: (id: string, next: Tab) => void; provider: Provider }) {
  const { db, today } = useStore();
  const elig = checkEligibility(e, today);
  const plan = planById(e.planId);
  const contracted = provider.hmoIds.includes(e.hmoId);
  const isPrimary = e.primaryProviderId === provider.id;
  const used = utilisedInYear(e.id, today.slice(0, 4), db.claims);
  return (
    <Card
      title={
        <>
          {e.firstName} {e.lastName}
        </>
      }
      action={<CoverBadge status={elig.status} />}
    >
      <p className="muted small">
        {e.id} · {e.gender}, {ageOn(e.dateOfBirth, today)} yrs · {e.dependants} dependant(s) · NIN {e.ninVerified ? 'verified' : <Badge tone="amber">not verified</Badge>}
      </p>
      <Notice tone={!elig.eligible || !contracted ? 'red' : elig.status === 'active' && isPrimary ? 'green' : 'amber'}>
        {!contracted
          ? `Your facility is not contracted with ${hmoById(e.hmoId).name}. Stabilise emergencies, then refer.`
          : !elig.eligible
            ? elig.message
            : isPrimary || provider.level !== 'primary'
              ? `${elig.message}${provider.level !== 'primary' ? ' Non-emergency care here needs a referral PA code.' : ''}`
              : `${elig.message} Note: registered at ${providerById(e.primaryProviderId)?.name} — non-emergency care here needs a PA code.`}
      </Notice>
      <dl className="summary">
        <dt>Plan</dt>
        <dd>{plan.name}</dd>
        <dt>HMO</dt>
        <dd>{hmoById(e.hmoId).name}</dd>
        <dt>Benefit left</dt>
        <dd>{naira(plan.annualLimit - used)}</dd>
      </dl>
      <div className="benefit-dots">
        {(Object.keys(plan.benefits) as ServiceCategory[]).map((k) => {
          const b = plan.benefits[k];
          return (
            <span key={k} className={b.covered ? 'on' : 'off'} title={b.covered ? `Co-pay ${Math.round(b.copay * 100)}%${b.requiresPA ? ', PA required' : ''}` : 'Not covered'}>
              {b.covered ? '✓' : '✕'} {CATEGORY_LABELS[k]}
              {b.covered && b.requiresPA ? ' (PA)' : ''}
              {b.covered && b.copay ? ` ${Math.round(b.copay * 100)}%` : ''}
            </span>
          );
        })}
      </div>
      {elig.eligible && contracted && (
        <div className="actions">
          <button onClick={() => onUse(e.id, 'claim')}>Start claim</button>
          <button className="secondary" onClick={() => onUse(e.id, 'preauth')}>
            Request PA code
          </button>
        </div>
      )}
    </Card>
  );
}

function PreAuth({ providerId, patientId, setPatientId }: { providerId: string; patientId: string; setPatientId: (s: string) => void }) {
  const { db, requestPA } = useStore();
  const [category, setCategory] = useState<ServiceCategory>('imaging');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState(15000);
  const [result, setResult] = useState<PARequest | null>(null);
  const found = lookup(db.enrollees, patientId);
  const mine = db.paRequests.filter((p) => p.providerId === providerId).slice(0, 15);

  return (
    <div className="grid two">
      <Card title="Request a pre-authorisation (PA) code">
        <form
          className="stack-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!found.enrollee) return;
            setResult(requestPA({ enrolleeId: found.enrollee.id, providerId, category, description: description || CATEGORY_LABELS[category], estimatedCost: cost }));
          }}
        >
          <Field label="Patient (ID, phone or NIN)" error={patientId && found.error}>
            <input value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder="HG-00000018" />
          </Field>
          {found.enrollee && <p className="small">✓ {found.enrollee.firstName} {found.enrollee.lastName} · {planById(found.enrollee.planId).name}</p>}
          <div className="form-grid">
            <Field label="Service">
              <select value={category} onChange={(e) => setCategory(e.target.value as ServiceCategory)}>
                {(Object.keys(CATEGORY_LABELS) as ServiceCategory[]).map((k) => (
                  <option key={k} value={k}>
                    {CATEGORY_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Estimated cost (₦)">
              <input type="number" min={0} step={500} value={cost} onChange={(e) => setCost(Number(e.target.value) || 0)} />
            </Field>
          </div>
          <Field label="Clinical reason">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Suspected pneumonia — chest X-ray" />
          </Field>
          <button type="submit" disabled={!found.enrollee}>
            Request code
          </button>
          <p className="muted small">Covered requests up to {naira(PA_AUTO_APPROVE_LIMIT)} (except surgery) are approved instantly. Others go to an HMO doctor with a 24-hour deadline.</p>
        </form>
        {result && (
          <Notice tone={result.status === 'approved' ? 'green' : result.status === 'pending' ? 'amber' : 'red'}>
            {result.status === 'approved' ? <CheckCircle2 size={16} aria-hidden /> : result.status === 'denied' ? <XCircle size={16} aria-hidden /> : null}{' '}
            <strong>{result.status === 'approved' ? `Code ${result.code}` : result.status === 'pending' ? `Request ${result.code} pending` : 'Denied'}</strong> — {result.note}
            {result.expiresAt && ` Valid until ${prettyDate(result.expiresAt)}.`}
          </Notice>
        )}
      </Card>
      <Card title="Recent PA requests">
        {mine.length === 0 ? (
          <Empty>No requests yet.</Empty>
        ) : (
          <ul className="list">
            {mine.map((p) => {
              const e = db.enrollees.find((x) => x.id === p.enrolleeId);
              return (
                <li key={p.code}>
                  <div className="list-row">
                    <strong>
                      {p.code} · {CATEGORY_LABELS[p.category]}
                    </strong>
                    <PABadge pa={p} />
                  </div>
                  <span className="muted small">
                    {e?.firstName} {e?.lastName} · {naira(p.estimatedCost)} · {p.autoDecided ? 'instant decision' : 'reviewed by HMO doctor'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function NewClaim({ providerId, patientId, setPatientId, navigate }: { providerId: string; patientId: string; setPatientId: (s: string) => void; navigate: (p: string) => void }) {
  const { db, today, submitClaim } = useStore();
  const found = lookup(db.enrollees, patientId);
  const [encounterDate, setEncounterDate] = useState(today);
  const [diagnosis, setDiagnosis] = useState(DIAGNOSES[0]);
  const [paCode, setPaCode] = useState('');
  const [lines, setLines] = useState<ClaimLine[]>([
    { tariffCode: 'CON-01', quantity: 1, unitPrice: 5000 },
    { tariffCode: 'LAB-01', quantity: 1, unitPrice: 2500 },
    { tariffCode: 'DRG-01', quantity: 1, unitPrice: 3500 },
  ]);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const provider = providerById(providerId)!;

  const draft: ClaimDraft | null = found.enrollee
    ? { enrolleeId: found.enrollee.id, providerId, encounterDate, submittedAt: today, diagnosis, paCode: paCode.trim().toUpperCase() || undefined, lines }
    : null;
  const preview = useMemo(
    () => (draft && found.enrollee ? adjudicate(draft, { enrollee: found.enrollee, provider, paRequests: db.paRequests, history: db.claims }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(draft), db],
  );
  const myPAs = found.enrollee ? db.paRequests.filter((p) => p.enrolleeId === found.enrollee!.id && p.providerId === providerId && (p.status === 'approved' || p.status === 'used')) : [];
  const updateLine = (i: number, patch: Partial<ClaimLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  if (submitted) {
    const c = db.claims.find((x) => x.id === submitted)!;
    return (
      <Card title={`Claim ${c.id} submitted`} action={<ClaimBadge claim={c} />}>
        <p>
          {c.status === 'pending_review'
            ? 'Held for a quick human review because the fraud engine raised a flag. You will be notified of the decision.'
            : c.status === 'rejected'
              ? 'Rejected — see the reasons below. Fix and resubmit if needed.'
              : `Decided instantly. ${naira(c.approvedTotal)} will be paid by ${hmoById(c.hmoId).name} within ${hmoById(c.hmoId).claimsSlaDays} days.`}
        </p>
        <div className="actions">
          <button onClick={() => { setSubmitted(null); setPatientId(''); }}>New claim</button>
          <button className="secondary" onClick={() => navigate('provider/claims')}>
            Track my claims
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid two wide-left">
      <Card title="Submit a claim">
        <div className="stack-sm">
          <div className="form-grid">
            <Field label="Patient (ID, phone or NIN)" error={patientId && found.error}>
              <input value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder="HG-00000018" />
            </Field>
            <Field label="Date of visit">
              <input type="date" value={encounterDate} max={today} onChange={(e) => setEncounterDate(e.target.value)} />
            </Field>
            <Field label="Diagnosis (ICD-10)">
              <select value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)}>
                {DIAGNOSES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </Field>
            <Field label="PA code (if any)">
              <input list="pa-codes" value={paCode} onChange={(e) => setPaCode(e.target.value)} placeholder="PA-XXXXXX" />
              <datalist id="pa-codes">
                {myPAs.map((p) => (
                  <option key={p.code} value={p.code}>
                    {CATEGORY_LABELS[p.category]}
                  </option>
                ))}
              </datalist>
            </Field>
          </div>
          {found.enrollee && <p className="small">✓ {found.enrollee.firstName} {found.enrollee.lastName} · {planById(found.enrollee.planId).name}</p>}
          <div className="table-wrap">
            <table className="lines-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Qty</th>
                  <th>Unit price (₦)</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <select
                        aria-label="Service"
                        value={l.tariffCode}
                        onChange={(e) => updateLine(i, { tariffCode: e.target.value, unitPrice: tariffByCode(e.target.value)!.price })}
                      >
                        {TARIFFS.map((t) => (
                          <option key={t.code} value={t.code}>
                            {t.code} · {t.description}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input aria-label="Quantity" type="number" min={1} value={l.quantity} onChange={(e) => updateLine(i, { quantity: Math.max(0, Number(e.target.value) || 0) })} />
                    </td>
                    <td>
                      <input aria-label="Unit price" type="number" min={0} step={100} value={l.unitPrice} onChange={(e) => updateLine(i, { unitPrice: Math.max(0, Number(e.target.value) || 0) })} />
                    </td>
                    <td>
                      <button className="icon-btn" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions spread">
            <button className="ghost small" onClick={() => setLines([...lines, { tariffCode: 'DRG-03', quantity: 1, unitPrice: 600 }])}>
              <Plus size={14} aria-hidden /> Add service
            </button>
            <button disabled={!draft || lines.length === 0} onClick={() => draft && setSubmitted(submitClaim(draft).id)}>
              Submit claim
            </button>
          </div>
        </div>
      </Card>
      <Card title="Live decision preview">
        {!preview ? (
          <Empty>Enter a patient to see exactly what will be paid — before you submit.</Empty>
        ) : (
          <div className="stack-sm">
            <div className="grid three tight">
              <Stat label="Billed" value={naira(preview.billedTotal)} />
              <Stat label="Insurer pays" value={naira(preview.approvedTotal)} tone="green" />
              <Stat label="Collect co-pay" value={naira(preview.copayTotal)} />
            </div>
            <ul className="decisions">
              {preview.decisions.map((d, i) => (
                <li key={i} className={d.approved + d.copay === 0 ? 'rejected' : d.approved + d.copay < d.billed ? 'partial' : 'ok'}>
                  <div className="list-row">
                    <span>{tariffByCode(d.tariffCode)?.description ?? d.tariffCode}</span>
                    <strong>{naira(d.approved)}</strong>
                  </div>
                  {d.reasons.map((r) => (
                    <span key={r} className="small muted">
                      {r}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            {preview.fraudFlags.length > 0 && (
              <Notice tone="amber">
                Risk score {preview.riskScore}/100: {preview.fraudFlags.map((f) => f.detail).join(' ')}
                {preview.riskScore >= 40 ? ' This claim will be held for review.' : ''}
              </Notice>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function MyClaims({ providerId }: { providerId: string }) {
  const { db, today } = useStore();
  const [filter, setFilter] = useState<'all' | 'waiting' | 'paid' | 'rejected'>('all');
  const claims = db.claims.filter((c) => c.providerId === providerId);
  const waiting = claims.filter((c) => isAwaitingPayment(c) || c.status === 'pending_review');
  const paid = claims.filter((c) => c.status === 'paid');
  const shown = claims
    .filter((c) => filter === 'all' || (filter === 'waiting' ? waiting.includes(c) : filter === 'paid' ? c.status === 'paid' : c.status === 'rejected'))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  const avgDays = paid.length ? paid.reduce((s, c) => s + claimAgeDays(c, today), 0) / paid.length : 0;

  return (
    <div className="stack">
      <div className="grid four tight">
        <Stat label="Awaiting payment" value={naira(waiting.reduce((s, c) => s + c.approvedTotal, 0))} hint={`${waiting.length} claims`} />
        <Stat label="Paid (all time)" value={naira(paid.reduce((s, c) => s + c.approvedTotal, 0))} hint={`${paid.length} claims`} tone="green" />
        <Stat label="Average time to payment" value={`${avgDays.toFixed(1)} days`} />
        <Stat label="Overdue (past SLA)" value={claims.filter((c) => isOverdue(c, today)).length} tone={claims.some((c) => isOverdue(c, today)) ? 'red' : undefined} hint="Escalated to regulator automatically" />
      </div>
      <Tabs
        value={filter}
        onChange={setFilter}
        tabs={[
          ['all', 'All'],
          ['waiting', 'Waiting'],
          ['paid', 'Paid'],
          ['rejected', 'Rejected'],
        ]}
      />
      {shown.length === 0 ? (
        <Empty>No claims here.</Empty>
      ) : (
        <div className="table-wrap card flush">
          <table>
            <thead>
              <tr>
                <th>Claim</th>
                <th>Patient</th>
                <th>Visit</th>
                <th>Billed</th>
                <th>Approved</th>
                <th>Status</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 60).map((c) => {
                const e = db.enrollees.find((x) => x.id === c.enrolleeId);
                return (
                  <tr key={c.id}>
                    <td className="mono">{c.id}</td>
                    <td>
                      {e?.firstName} {e?.lastName}
                    </td>
                    <td>{prettyDate(c.encounterDate)}</td>
                    <td>{naira(c.billedTotal)}</td>
                    <td>{naira(c.approvedTotal)}</td>
                    <td>
                      <ClaimBadge claim={c} />
                    </td>
                    <td>
                      {claimAgeDays(c, today)}d {isOverdue(c, today) && <Badge tone="red">Overdue</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Capitation({ providerId }: { providerId: string }) {
  const { db, today } = useStore();
  const provider = providerById(providerId)!;
  const rows = db.capitation.filter((c) => c.providerId === providerId).sort((a, b) => b.month.localeCompare(a.month));
  const thisMonth = today.slice(0, 7);
  if (provider.level !== 'primary')
    return (
      <Card>
        <Empty>Capitation is paid to primary providers. Secondary and tertiary hospitals are paid fee-for-service through claims.</Empty>
      </Card>
    );
  return (
    <Card title="Capitation — a fixed monthly payment per registered member">
      <p className="muted small">Paid in advance so you can stock drugs and staff the clinic. Late capitation is tracked and visible to the regulator.</p>
      {rows.length === 0 ? (
        <Empty>No members registered here yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th>HMO</th>
                <th>Lives</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.month}</td>
                  <td>{hmoById(c.hmoId).name}</td>
                  <td>{c.lives}</td>
                  <td>{naira(c.amount)}</td>
                  <td>
                    {c.paidAt ? (
                      <Badge tone="green">Paid {prettyDate(c.paidAt)}</Badge>
                    ) : c.month < thisMonth ? (
                      <Badge tone="red">Overdue</Badge>
                    ) : (
                      <Badge tone="amber">Due</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
