import { ArrowLeft, ArrowRight, BadgeCheck, CheckCircle2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import type { HmoPerformance, PaymentView } from '../api/types';
import { CATEGORY_LABELS, GROUPS, HMOS, PLANS, PROVIDERS, STATES, planById } from '../domain/catalog';
import { FREQUENCIES, MAX_DEPENDANTS, quotePremium } from '../domain/pricing';
import type { Enrollee, Gender, PaymentFrequency, PaymentMethod, Sector } from '../domain/types';
import { addDays, isValidNin, isValidPhone, naira, prettyDate } from '../domain/util';
import { useApiMutation, useApiQuery, useMeta, useSession } from '../state/session';
import { Badge, Card, ErrorNotice, Field, Notice, go, pct } from '../ui/kit';

const METHODS: [PaymentMethod, string][] = [
  ['ussd', 'USSD (any phone)'],
  ['mobile_money', 'Mobile money wallet'],
  ['card', 'Debit card'],
  ['bank_transfer', 'Bank transfer'],
  ['agent', 'Cash via HealthGuard agent'],
];

const SECTORS: [Sector, string, string][] = [
  ['informal', 'Self-employed / informal', 'Trader, artisan, driver, farmer…'],
  ['formal', 'Employed', 'Salary earner — premium can come from payroll'],
  ['vulnerable', 'Need sponsorship', 'Pregnant women, under-5s, elderly, people with disabilities, the poor'],
];

const STEPS = ['About you', 'Plan & price', 'HMO & hospital', 'Pay'];

const normalisePhone = (raw: string) => {
  const d = raw.replace(/[^\d]/g, '');
  return d.startsWith('234') && d.length === 13 ? '0' + d.slice(3) : d;
};

export function Enroll() {
  const { login } = useSession();
  const meta = useMeta();
  const perf = useApiQuery<HmoPerformance[]>(['public', 'hmo-performance'], '/hmos/performance');
  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState(false);
  const [f, setF] = useState({
    firstName: '',
    lastName: '',
    gender: 'female' as Gender,
    dateOfBirth: '',
    phone: '',
    nin: '',
    pin: '',
    pin2: '',
    state: 'Lagos',
    sector: 'informal' as Sector,
    groupCode: '',
    planId: 'basic',
    dependants: 0,
    frequency: 'weekly' as PaymentFrequency,
    hmoId: '',
    providerId: '',
    method: 'ussd' as PaymentMethod,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const enrol = useApiMutation(() =>
    api<{ enrollee: Enrollee; payment: PaymentView }>('/enrolments', {
      body: {
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        gender: f.gender,
        dateOfBirth: f.dateOfBirth,
        phone: normalisePhone(f.phone),
        nin: f.nin,
        state: f.state,
        sector: f.sector,
        planId: f.planId,
        hmoId: f.hmoId,
        primaryProviderId: f.providerId,
        dependants: f.dependants,
        frequency: f.sector === 'vulnerable' ? 'quarterly' : f.frequency,
        method: f.method,
        groupCode: f.sector !== 'vulnerable' && f.groupCode.trim() ? f.groupCode.trim() : undefined,
        pin: f.pin,
      },
    }),
  );
  const confirmPay = useApiMutation((ref: string) => api<{ payment: PaymentView }>(`/dev/payments/${encodeURIComponent(ref)}/confirm`, { method: 'POST' }));

  const group = f.groupCode ? GROUPS[f.groupCode.trim().toUpperCase()] : undefined;
  const sector = f.sector;
  const quote = quotePremium({ planId: f.planId, dependants: f.dependants, frequency: sector === 'vulnerable' ? 'quarterly' : f.frequency, groupCode: f.groupCode, sector });
  const hospitals = PROVIDERS.filter((p) => p.state === f.state && p.level === 'primary' && p.accredited && (!f.hmoId || p.hmoIds.includes(f.hmoId)));
  const hmosInState = HMOS.filter((h) => PROVIDERS.some((p) => p.state === f.state && p.level === 'primary' && p.accredited && p.hmoIds.includes(h.id)));
  const today = meta.data?.today ?? new Date().toISOString().slice(0, 10);

  const errors = {
    firstName: !f.firstName.trim() && 'Enter your first name',
    lastName: !f.lastName.trim() && 'Enter your surname',
    dateOfBirth: (!f.dateOfBirth && 'Enter your date of birth') || (f.dateOfBirth > today && 'Date of birth cannot be in the future'),
    phone: !isValidPhone(normalisePhone(f.phone)) && 'Enter an 11-digit Nigerian number, e.g. 08031234567',
    nin: !isValidNin(f.nin) && 'NIN must be 11 digits',
    pin: !/^\d{6}$/.test(f.pin) && 'Choose a 6-digit PIN',
    pin2: f.pin !== f.pin2 && 'PINs do not match',
    groupCode: sector !== 'vulnerable' && !!f.groupCode.trim() && !group && 'Unknown group code',
  };
  const step0Ok = Object.values(errors).every((e) => !e);
  const step2Ok = !!f.hmoId && !!f.providerId;

  const next = () => {
    setTouched(true);
    if (step === 0 && !step0Ok) return;
    if (step === 2 && !step2Ok) return;
    setTouched(false);
    setStep(step + 1);
  };

  // A duplicate phone/NIN or bad field is about step 1 — send the person back there.
  const enrolError = enrol.error;
  const backToDetails = enrolError instanceof ApiError && (enrolError.status === 409 || enrolError.status === 422 || enrolError.issues.length > 0);

  const done = enrol.data;
  if (done) {
    const plan = planById(done.enrollee.planId);
    const payment = confirmPay.data?.payment ?? done.payment;
    const paid = payment.status === 'confirmed';
    return (
      <div className="narrow stack">
        <Notice tone="green">
          <CheckCircle2 size={18} aria-hidden /> Welcome to HealthGuard, {done.enrollee.firstName}! Your ID is <strong>{done.enrollee.id}</strong>.
        </Notice>
        <div className="idcard big">
          <div className="idcard-top">
            <span>HealthGuard</span>
            <BadgeCheck size={18} aria-hidden />
          </div>
          <div className="idcard-row">
            <div>
              <div className="idcard-id">{done.enrollee.id}</div>
              <div className="idcard-name">
                {done.enrollee.firstName} {done.enrollee.lastName}
              </div>
              <div className="idcard-meta">
                <span>{plan.name}</span>
                <span>{PROVIDERS.find((p) => p.id === done.enrollee.primaryProviderId)?.name}</span>
              </div>
            </div>
            <div className="qr">
              <QRCodeSVG value={done.enrollee.id} size={84} />
            </div>
          </div>
          <div className="idcard-status">
            {paid ? `Waiting period ends ${prettyDate(addDays(done.enrollee.enrolledOn, plan.waitingPeriodDays))} · emergencies covered from today` : 'Cover starts when your first payment is confirmed'}
          </div>
        </div>
        {!paid && (
          <Card title="Complete your first payment">
            <p>
              Payment <strong className="mono">{payment.reference}</strong> for <strong>{naira(payment.amount)}</strong> has been created. Approve it with your {METHODS.find(([m]) => m === payment.method)?.[1].toLowerCase()} — your cover starts as soon as the payment provider confirms it.
            </p>
            {meta.data?.devGateway && (
              <div className="actions">
                <button className="secondary" disabled={confirmPay.isPending} onClick={() => confirmPay.mutate(payment.reference)}>
                  {confirmPay.isPending ? 'Confirming…' : 'Simulate gateway confirmation (development)'}
                </button>
              </div>
            )}
            {confirmPay.error && <ErrorNotice error={confirmPay.error} />}
          </Card>
        )}
        <SignInAfterEnrol phone={done.enrollee.phone} pin={f.pin} login={login} />
      </div>
    );
  }

  return (
    <div className="narrow stack">
      <div>
        <h1>Join HealthGuard</h1>
        <p className="muted">Takes about 3 minutes. You can also join from any phone by dialling the USSD code, or through a HealthGuard agent.</p>
      </div>
      <ol className="stepper" aria-label="Enrolment steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
            <span>{i + 1}</span> {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <div className="form-grid">
            <Field label="First name" error={touched && errors.firstName}>
              <input value={f.firstName} maxLength={60} onChange={(e) => set('firstName', e.target.value)} autoComplete="given-name" />
            </Field>
            <Field label="Surname" error={touched && errors.lastName}>
              <input value={f.lastName} maxLength={60} onChange={(e) => set('lastName', e.target.value)} autoComplete="family-name" />
            </Field>
            <Field label="Sex">
              <select value={f.gender} onChange={(e) => set('gender', e.target.value as Gender)}>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </select>
            </Field>
            <Field label="Date of birth" error={touched && errors.dateOfBirth}>
              <input type="date" value={f.dateOfBirth} max={today} onChange={(e) => set('dateOfBirth', e.target.value)} />
            </Field>
            <Field label="Phone number" error={touched && errors.phone} hint="You'll sign in with this number. Also used for SMS and USSD.">
              <input inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value.replace(/\s/g, ''))} placeholder="08031234567" autoComplete="tel" />
            </Field>
            <Field label="State of residence">
              <select value={f.state} onChange={(e) => setF((p) => ({ ...p, state: e.target.value, hmoId: '', providerId: '' }))}>
                {STATES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Choose a 6-digit PIN" error={touched && errors.pin} hint="For signing in. Never share it.">
              <input type="password" inputMode="numeric" maxLength={6} value={f.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} autoComplete="new-password" />
            </Field>
            <Field label="Confirm PIN" error={touched && errors.pin2}>
              <input type="password" inputMode="numeric" maxLength={6} value={f.pin2} onChange={(e) => set('pin2', e.target.value.replace(/\D/g, ''))} autoComplete="new-password" />
            </Field>
          </div>
          <Field label="National Identification Number (NIN)" error={touched && errors.nin} hint="Checked with the national identity database when you submit. Stops anyone else enrolling as you — and stops “ghost” members. We never store it in readable form.">
            <input inputMode="numeric" maxLength={11} value={f.nin} onChange={(e) => set('nin', e.target.value.replace(/\D/g, ''))} placeholder="11 digits" />
          </Field>
          <fieldset className="choices">
            <legend>How do you earn a living?</legend>
            {SECTORS.map(([id, label, hint]) => (
              <label key={id} className={`choice ${sector === id ? 'selected' : ''}`}>
                <input type="radio" name="sector" checked={sector === id} onChange={() => setF((p) => ({ ...p, sector: id, planId: id === 'vulnerable' ? 'basic' : p.planId }))} />
                <span>
                  <strong>{label}</strong>
                  <span className="muted small">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {sector !== 'vulnerable' && (
            <Field label="Group code (optional)" error={touched && errors.groupCode} hint={group ? `✓ ${group.name} — ${pct(group.discount)} off` : 'Market association, cooperative or employer code. Try OSHODI-TRADERS'}>
              <input value={f.groupCode} maxLength={40} onChange={(e) => set('groupCode', e.target.value.toUpperCase())} />
            </Field>
          )}
        </Card>
      )}

      {step === 1 && (
        <Card>
          {sector === 'vulnerable' && <Notice tone="green">Your premium is fully paid by a sponsor (Basic Health Care Provision Fund / Sponsor-a-Life). You pay nothing.</Notice>}
          <div className="grid three">
            {PLANS.filter((p) => sector !== 'vulnerable' || p.id === 'basic').map((p) => (
              <label key={p.id} className={`choice plan-choice ${f.planId === p.id ? 'selected' : ''}`}>
                <input type="radio" name="plan" checked={f.planId === p.id} onChange={() => set('planId', p.id)} />
                <span>
                  <strong>{p.name}</strong>
                  <span className="muted small">{p.tagline}</span>
                  <span className="small">Up to {naira(p.annualLimit)} a year</span>
                  <span className="benefit-dots">
                    {Object.entries(p.benefits).map(([k, b]) => (
                      <span key={k} className={b.covered ? 'on' : 'off'}>
                        {b.covered ? '✓' : '✕'} {CATEGORY_LABELS[k as keyof typeof CATEGORY_LABELS]}
                      </span>
                    ))}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="form-grid">
            <Field label="Dependants (spouse & children)" hint={`Each adds ${pct(0.6)} of your premium. Max ${MAX_DEPENDANTS}.`}>
              <input type="number" min={0} max={MAX_DEPENDANTS} value={f.dependants} onChange={(e) => set('dependants', Math.max(0, Math.min(MAX_DEPENDANTS, Number(e.target.value) || 0)))} />
            </Field>
            {sector !== 'vulnerable' && (
              <Field label="How often do you want to pay?">
                <select value={f.frequency} onChange={(e) => set('frequency', e.target.value as PaymentFrequency)}>
                  {Object.entries(FREQUENCIES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                      {v.discount ? ` (save ${pct(v.discount)})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <div className="quote">
            <div>
              <span className="muted small">You pay</span>
              <strong>{quote.payer === 'sponsor' ? '₦0' : naira(quote.installment)}</strong>
              <span className="muted small">{quote.payer === 'sponsor' ? 'sponsored' : `${FREQUENCIES[f.frequency].label.toLowerCase()} · covers ${quote.daysCovered} day(s)`}</span>
            </div>
            <div>
              <span className="muted small">Per year</span>
              <strong>{naira(quote.annualCost)}</strong>
              <span className="muted small">
                for {1 + f.dependants} {f.dependants ? 'people' : 'person'}
              </span>
            </div>
            {quote.groupName && (
              <div>
                <span className="muted small">Group discount</span>
                <strong>{pct(quote.groupDiscount)}</strong>
                <span className="muted small">{quote.groupName}</span>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <h3>Choose your HMO</h3>
          <p className="muted small">Real performance data, so you can pick an HMO that pays hospitals on time and resolves complaints.</p>
          {hmosInState.length === 0 && <Notice tone="amber">No HMO has an accredited clinic in {f.state} yet. We've logged demand for your area — choose a nearby state for now.</Notice>}
          <div className="grid three">
            {hmosInState.map((h) => {
              const s = perf.data?.find((x) => x.hmoId === h.id);
              return (
                <label key={h.id} className={`choice ${f.hmoId === h.id ? 'selected' : ''}`}>
                  <input type="radio" name="hmo" checked={f.hmoId === h.id} onChange={() => setF((p) => ({ ...p, hmoId: h.id, providerId: '' }))} />
                  <span>
                    <strong>{h.name}</strong>
                    {s ? (
                      <>
                        <span className="small">Pays hospitals in ~{Math.round(s.avgDaysToPay)} days</span>
                        <span className="small">{pct(s.complaintResolution)} of complaints resolved</span>
                        {s.avgDaysToPay > h.claimsSlaDays && <Badge tone="amber">Often pays late</Badge>}
                      </>
                    ) : (
                      <span className="muted small">{perf.isPending ? 'Loading performance…' : 'No performance data yet'}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          {touched && !f.hmoId && <p className="field-error">Choose an HMO</p>}
          {f.hmoId && (
            <>
              <h3>Choose your primary hospital</h3>
              <p className="muted small">You'll go here first for care. You can change it later from your dashboard.</p>
              <div className="grid two">
                {hospitals.map((p) => (
                  <label key={p.id} className={`choice ${f.providerId === p.id ? 'selected' : ''}`}>
                    <input type="radio" name="provider" checked={f.providerId === p.id} onChange={() => set('providerId', p.id)} />
                    <span>
                      <strong>{p.name}</strong>
                      <span className="muted small">
                        {p.lga}, {p.state} · {p.phone}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {touched && !f.providerId && <p className="field-error">Choose a hospital</p>}
            </>
          )}
        </Card>
      )}

      {step === 3 && (
        <Card>
          <dl className="summary">
            <dt>Name</dt>
            <dd>
              {f.firstName} {f.lastName}
            </dd>
            <dt>Plan</dt>
            <dd>
              {planById(f.planId).name} · {1 + f.dependants} {f.dependants ? 'people' : 'person'}
            </dd>
            <dt>HMO</dt>
            <dd>{HMOS.find((h) => h.id === f.hmoId)?.name}</dd>
            <dt>Hospital</dt>
            <dd>{PROVIDERS.find((p) => p.id === f.providerId)?.name}</dd>
            <dt>First payment</dt>
            <dd>
              <strong>{quote.payer === 'sponsor' ? '₦0 — sponsored' : naira(quote.installment)}</strong> covers {quote.daysCovered} day(s)
            </dd>
          </dl>
          {quote.payer !== 'sponsor' && (
            <fieldset className="choices">
              <legend>Pay with</legend>
              <div className="grid two">
                {METHODS.map(([id, label]) => (
                  <label key={id} className={`choice ${f.method === id ? 'selected' : ''}`}>
                    <input type="radio" name="method" checked={f.method === id} onChange={() => set('method', id)} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <p className="muted small">{planById(f.planId).waitingPeriodDays}-day waiting period for non-emergency care.</p>
          {enrolError && (
            <Notice tone="red">
              {enrolError.message}
              {enrolError instanceof ApiError && enrolError.issues.length > 0 && <> ({enrolError.issues.map((i) => `${i.path}: ${i.message}`).join('; ')})</>}{' '}
              {backToDetails && (
                <button
                  className="ghost small"
                  onClick={() => {
                    enrol.reset();
                    setStep(0);
                  }}
                >
                  Edit my details
                </button>
              )}
            </Notice>
          )}
        </Card>
      )}

      <div className="actions spread">
        {step > 0 ? (
          <button className="secondary" onClick={() => setStep(step - 1)} disabled={enrol.isPending}>
            <ArrowLeft size={16} aria-hidden /> Back
          </button>
        ) : (
          <span />
        )}
        {step < 3 ? (
          <button onClick={next}>
            Continue <ArrowRight size={16} aria-hidden />
          </button>
        ) : (
          <button onClick={() => enrol.mutate(undefined)} disabled={enrol.isPending}>
            {enrol.isPending ? 'Enrolling…' : quote.payer === 'sponsor' ? 'Complete enrolment' : `Enrol & pay ${naira(quote.installment)}`}
          </button>
        )}
      </div>
    </div>
  );
}

function SignInAfterEnrol({ phone, pin, login }: { phone: string; pin: string; login: (u: string, p: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="actions">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await login(phone, pin);
            go('member');
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Signing in…' : 'Open my member dashboard'} <ArrowRight size={16} aria-hidden />
      </button>
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}
