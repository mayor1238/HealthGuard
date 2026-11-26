import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Plus, Search, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { EligibilityView, NamedClaim, NamedPA } from '../api/types';
import type { AdjudicationResult } from '../domain/adjudication';
import { claimAgeDays, isAwaitingPayment, isOverdue } from '../domain/analytics';
import { CATEGORY_LABELS, DIAGNOSES, TARIFFS, hmoById, providerById, tariffByCode } from '../domain/catalog';
import { PA_AUTO_APPROVE_LIMIT } from '../domain/preauth';
import type { CapitationPayment, Claim, ClaimLine, PARequest, ServiceCategory } from '../domain/types';
import { naira, prettyDate } from '../domain/util';
import { useApiMutation, useApiQuery, useMeta, useSession } from '../state/session';
import { Badge, Card, ClaimBadge, CoverBadge, Empty, ErrorNotice, Field, Loadable, Loading, Notice, PABadge, Stat, Tabs } from '../ui/kit';

type Tab = 'verify' | 'preauth' | 'claim' | 'claims' | 'capitation';
const TABS: [Tab, string][] = [
  ['verify', 'Verify patient'],
  ['preauth', 'PA codes'],
  ['claim', 'New claim'],
  ['claims', 'My claims'],
  ['capitation', 'Capitation'],
];
const PROVIDER = ['provider'];

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Live lookup by HealthGuard ID, phone or NIN. */
function usePatient(q: string) {
  const term = useDebounced(q.trim());
  return useApiQuery<EligibilityView>(['provider', 'eligibility', term], term.length >= 6 ? `/provider/eligibility?q=${encodeURIComponent(term)}` : null);
}

export function ProviderPortal({ tab, navigate }: { tab?: string; navigate: (p: string) => void }) {
  const { principal } = useSession();
  const current = (TABS.some(([t]) => t === tab) ? tab : 'verify') as Tab;
  const provider = providerById(principal!.providerId!)!;
  const [patient, setPatient] = useState('');

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
      </div>
      <Tabs<Tab> value={current} onChange={(t) => navigate(`provider/${t}`)} tabs={TABS} />
      {current === 'verify' && (
        <Verify
          onUse={(id, next) => {
            setPatient(id);
            navigate(`provider/${next}`);
          }}
        />
      )}
      {current === 'preauth' && <PreAuth patient={patient} setPatient={setPatient} />}
      {current === 'claim' && <NewClaim patient={patient} setPatient={setPatient} navigate={navigate} />}
      {current === 'claims' && <MyClaims />}
      {current === 'capitation' && <Capitation level={provider.level} />}
    </div>
  );
}

function Verify({ onUse }: { onUse: (id: string, next: Tab) => void }) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const res = useApiQuery<EligibilityView>(['provider', 'eligibility', submitted], submitted ? `/provider/eligibility?q=${encodeURIComponent(submitted)}` : null);

  return (
    <div className="grid two wide-right">
      <Card title="Check eligibility">
        <form
          className="stack-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            setSubmitted(q.trim());
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
        {res.error && <Notice tone="red">{res.error.message}</Notice>}
        <p className="muted small">Results are live from the scheme database. Every lookup is recorded in the audit log.</p>
      </Card>
      {res.isFetching && !res.data ? (
        <Card>
          <Loading label="Checking cover…" />
        </Card>
      ) : res.data ? (
        <PatientCard e={res.data} onUse={onUse} />
      ) : (
        <Card>
          <Empty>Search for a patient to see their cover, benefits and what needs approval.</Empty>
        </Card>
      )}
    </div>
  );
}

function PatientCard({ e, onUse }: { e: EligibilityView; onUse: (id: string, next: Tab) => void }) {
  const elig = e.eligibility;
  return (
    <Card title={<>{e.firstName} {e.lastName}</>} action={<CoverBadge status={elig.status} />}>
      <p className="muted small">
        {e.id} · {e.gender}, {e.age} yrs · {e.dependants} dependant(s) · NIN {e.ninVerified ? 'verified' : <Badge tone="amber">not verified</Badge>}
      </p>
      <Notice tone={!elig.eligible || !e.contractedWithHmo ? 'red' : elig.status === 'active' && !e.referralNeeded ? 'green' : 'amber'}>
        {!e.contractedWithHmo
          ? `Your facility is not contracted with ${e.hmo.name}. Stabilise emergencies, then refer.`
          : !elig.eligible
            ? elig.message
            : `${elig.message}${e.referralNeeded ? ' Non-emergency care here needs a referral PA code.' : ''}`}
      </Notice>
      <dl className="summary">
        <dt>Plan</dt>
        <dd>{e.plan.name}</dd>
        <dt>HMO</dt>
        <dd>{e.hmo.name}</dd>
        <dt>Benefit left</dt>
        <dd>{naira(e.benefitRemaining)}</dd>
      </dl>
      <div className="benefit-dots">
        {(Object.keys(e.plan.benefits) as ServiceCategory[]).map((k) => {
          const b = e.plan.benefits[k];
          return (
            <span key={k} className={b.covered ? 'on' : 'off'}>
              {b.covered ? '✓' : '✕'} {CATEGORY_LABELS[k]}
              {b.covered && b.requiresPA ? ' (PA)' : ''}
              {b.covered && b.copay ? ` ${Math.round(b.copay * 100)}%` : ''}
            </span>
          );
        })}
      </div>
      {elig.eligible && e.contractedWithHmo && (
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

function PatientField({ value, onChange, patient }: { value: string; onChange: (v: string) => void; patient: ReturnType<typeof usePatient> }) {
  return (
    <>
      <Field label="Patient (ID, phone or NIN)" error={value.trim().length >= 6 && patient.error ? patient.error.message : undefined}>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="HG-00000018" />
      </Field>
      {patient.data && (
        <p className="small">
          ✓ {patient.data.firstName} {patient.data.lastName} · {patient.data.id} · {patient.data.plan.name} <CoverBadge status={patient.data.eligibility.status} />
        </p>
      )}
    </>
  );
}

function PreAuth({ patient: q, setPatient }: { patient: string; setPatient: (s: string) => void }) {
  const patient = usePatient(q);
  const list = useApiQuery<NamedPA[]>(['provider', 'pa'], '/provider/pa-requests');
  const [category, setCategory] = useState<ServiceCategory>('imaging');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState(15000);
  const request = useApiMutation(
    () => api<PARequest>('/provider/pa-requests', { body: { enrolleeId: patient.data!.id, category, description: description.trim() || CATEGORY_LABELS[category], estimatedCost: cost } }),
    [PROVIDER],
  );
  const result = request.data;

  return (
    <div className="grid two">
      <Card title="Request a pre-authorisation (PA) code">
        <form
          className="stack-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (patient.data) request.mutate(undefined);
          }}
        >
          <PatientField value={q} onChange={setPatient} patient={patient} />
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
              <input type="number" min={0} step={500} value={cost} onChange={(e) => setCost(Math.max(0, Number(e.target.value) || 0))} />
            </Field>
          </div>
          <Field label="Clinical reason">
            <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Suspected pneumonia — chest X-ray" />
          </Field>
          <button type="submit" disabled={!patient.data || request.isPending}>
            {request.isPending ? 'Requesting…' : 'Request code'}
          </button>
          <p className="muted small">Covered requests up to {naira(PA_AUTO_APPROVE_LIMIT)} (except surgery) are approved instantly. Others go to an HMO doctor with a 24-hour deadline.</p>
        </form>
        {request.error && <ErrorNotice error={request.error} />}
        {result && (
          <Notice tone={result.status === 'approved' ? 'green' : result.status === 'pending' ? 'amber' : 'red'}>
            {result.status === 'approved' ? <CheckCircle2 size={16} aria-hidden /> : result.status === 'denied' ? <XCircle size={16} aria-hidden /> : null}{' '}
            <strong>{result.status === 'approved' ? `Code ${result.code}` : result.status === 'pending' ? `Request ${result.code} pending` : 'Denied'}</strong> — {result.note}
            {result.expiresAt && ` Valid until ${prettyDate(result.expiresAt)}.`}
          </Notice>
        )}
      </Card>
      <Card title="Recent PA requests">
        <Loadable q={list}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty>No requests yet.</Empty>
            ) : (
              <ul className="list">
                {rows.slice(0, 15).map((p) => (
                  <li key={p.code}>
                    <div className="list-row">
                      <strong>
                        {p.code} · {CATEGORY_LABELS[p.category]}
                      </strong>
                      <PABadge pa={p} />
                    </div>
                    <span className="muted small">
                      {p.patientName} · {naira(p.estimatedCost)} · {p.autoDecided ? 'instant decision' : 'reviewed by HMO doctor'}
                    </span>
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

function NewClaim({ patient: q, setPatient, navigate }: { patient: string; setPatient: (s: string) => void; navigate: (p: string) => void }) {
  const meta = useMeta();
  const today = meta.data?.today ?? new Date().toISOString().slice(0, 10);
  const patient = usePatient(q);
  const pas = useApiQuery<NamedPA[]>(['provider', 'pa'], '/provider/pa-requests');
  const [encounterDate, setEncounterDate] = useState(today);
  const [diagnosis, setDiagnosis] = useState(DIAGNOSES[0]);
  const [paCode, setPaCode] = useState('');
  const [lines, setLines] = useState<ClaimLine[]>([
    { tariffCode: 'CON-01', quantity: 1, unitPrice: 5000 },
    { tariffCode: 'LAB-01', quantity: 1, unitPrice: 2500 },
    { tariffCode: 'DRG-01', quantity: 1, unitPrice: 3500 },
  ]);
  const body = patient.data && lines.length ? { enrolleeId: patient.data.id, encounterDate, diagnosis, paCode: paCode.trim() || undefined, lines } : null;
  const debouncedBody = useDebounced(body, 350);
  const preview = useQuery<AdjudicationResult, ApiError>({
    queryKey: ['provider', 'preview', debouncedBody],
    queryFn: () => api<AdjudicationResult>('/provider/claims/preview', { body: debouncedBody }),
    enabled: !!debouncedBody,
    placeholderData: (prev) => prev,
  });
  const submit = useApiMutation(() => api<Claim>('/provider/claims', { body }), [PROVIDER]);
  const myPAs = (pas.data ?? []).filter((p) => p.enrolleeId === patient.data?.id && (p.status === 'approved' || p.status === 'used'));
  const updateLine = (i: number, patch: Partial<ClaimLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  if (submit.data) {
    const c = submit.data;
    return (
      <Card title={`Claim ${c.id} submitted`} action={<ClaimBadge claim={c} />}>
        <p>
          {c.status === 'pending_review'
            ? 'Held for a quick human review because the fraud engine raised a flag. You will see the decision under My claims.'
            : c.status === 'rejected'
              ? 'Rejected — see the reasons in the preview. Fix and resubmit if needed.'
              : `Decided instantly. ${naira(c.approvedTotal)} will be paid by ${hmoById(c.hmoId).name} within ${hmoById(c.hmoId).claimsSlaDays} days.`}
        </p>
        <div className="actions">
          <button
            onClick={() => {
              submit.reset();
              setPatient('');
            }}
          >
            New claim
          </button>
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
            <div className="stack-sm">
              <PatientField value={q} onChange={setPatient} patient={patient} />
            </div>
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
              <input list="pa-codes" value={paCode} onChange={(e) => setPaCode(e.target.value)} placeholder="PA-XXXXXXXX" />
              <datalist id="pa-codes">
                {myPAs.map((p) => (
                  <option key={p.code} value={p.code}>
                    {CATEGORY_LABELS[p.category]}
                  </option>
                ))}
              </datalist>
            </Field>
          </div>
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
                      <select aria-label="Service" value={l.tariffCode} onChange={(e) => updateLine(i, { tariffCode: e.target.value, unitPrice: tariffByCode(e.target.value)!.price })}>
                        {TARIFFS.map((t) => (
                          <option key={t.code} value={t.code}>
                            {t.code} · {t.description}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input aria-label="Quantity" type="number" min={1} max={100} value={l.quantity} onChange={(e) => updateLine(i, { quantity: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
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
          {submit.error && <ErrorNotice error={submit.error} />}
          <div className="actions spread">
            <button className="ghost small" onClick={() => setLines([...lines, { tariffCode: 'DRG-03', quantity: 1, unitPrice: 600 }])}>
              <Plus size={14} aria-hidden /> Add service
            </button>
            <button disabled={!body || submit.isPending} onClick={() => submit.mutate(undefined)}>
              {submit.isPending ? 'Submitting…' : 'Submit claim'}
            </button>
          </div>
        </div>
      </Card>
      <Card title="Live decision preview">
        {!body ? (
          <Empty>Enter a patient to see exactly what will be paid — before you submit.</Empty>
        ) : preview.error ? (
          <ErrorNotice error={preview.error} />
        ) : !preview.data ? (
          <Loading label="Calculating…" />
        ) : (
          <div className={`stack-sm ${preview.isFetching ? 'stale' : ''}`}>
            <div className="grid three tight">
              <Stat label="Billed" value={naira(preview.data.billedTotal)} />
              <Stat label="Insurer pays" value={naira(preview.data.approvedTotal)} tone="green" />
              <Stat label="Collect co-pay" value={naira(preview.data.copayTotal)} />
            </div>
            <ul className="decisions">
              {preview.data.decisions.map((d, i) => (
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
            {preview.data.fraudFlags.length > 0 && (
              <Notice tone="amber">
                Risk score {preview.data.riskScore}/100: {preview.data.fraudFlags.map((f) => f.detail).join(' ')}
                {preview.data.riskScore >= 40 ? ' This claim will be held for review.' : ''}
              </Notice>
            )}
            <p className="muted small">Calculated by the HealthGuard server using the same rules that will decide the claim.</p>
          </div>
        )}
      </Card>
    </div>
  );
}

function MyClaims() {
  const meta = useMeta();
  const today = meta.data?.today ?? new Date().toISOString().slice(0, 10);
  const q = useApiQuery<NamedClaim[]>(['provider', 'claims'], '/provider/claims?limit=500');
  const [filter, setFilter] = useState<'all' | 'waiting' | 'paid' | 'rejected'>('all');

  return (
    <Loadable q={q}>
      {(claims) => {
        const waiting = claims.filter((c) => isAwaitingPayment(c) || c.status === 'pending_review');
        const paid = claims.filter((c) => c.status === 'paid');
        const overdue = claims.filter((c) => isOverdue(c, today));
        const shown = claims.filter((c) => filter === 'all' || (filter === 'waiting' ? waiting.includes(c) : filter === 'paid' ? c.status === 'paid' : c.status === 'rejected'));
        const avgDays = paid.length ? paid.reduce((s, c) => s + claimAgeDays(c, today), 0) / paid.length : 0;
        return (
          <div className="stack">
            <div className="grid four tight">
              <Stat label="Awaiting payment" value={naira(waiting.reduce((s, c) => s + c.approvedTotal, 0))} hint={`${waiting.length} claims`} />
              <Stat label="Paid" value={naira(paid.reduce((s, c) => s + c.approvedTotal, 0))} hint={`${paid.length} claims`} tone="green" />
              <Stat label="Average time to payment" value={`${avgDays.toFixed(1)} days`} />
              <Stat label="Overdue (past target)" value={overdue.length} tone={overdue.length ? 'red' : undefined} hint="Visible to the regulator" />
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
                    {shown.slice(0, 80).map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.id}</td>
                        <td>{c.patientName}</td>
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
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      }}
    </Loadable>
  );
}

function Capitation({ level }: { level: string }) {
  const meta = useMeta();
  const thisMonth = (meta.data?.today ?? new Date().toISOString()).slice(0, 7);
  const q = useApiQuery<CapitationPayment[]>(['provider', 'capitation'], level === 'primary' ? '/provider/capitation' : null);
  if (level !== 'primary')
    return (
      <Card>
        <Empty>Capitation is paid to primary providers. Secondary and tertiary hospitals are paid fee-for-service through claims.</Empty>
      </Card>
    );
  return (
    <Card title="Capitation — a fixed monthly payment per registered member">
      <p className="muted small">Paid in advance so you can stock drugs and staff the clinic. Late capitation is visible to the regulator.</p>
      <Loadable q={q}>
        {(rows) =>
          rows.length === 0 ? (
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
                      <td>{c.paidAt ? <Badge tone="green">Paid {prettyDate(c.paidAt)}</Badge> : c.month < thisMonth ? <Badge tone="red">Overdue</Badge> : <Badge tone="amber">Due</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loadable>
    </Card>
  );
}
