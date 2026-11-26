import { ArrowRight, BadgeCheck, Banknote, Building2, Clock, Eye, FileSearch, Landmark, MessageSquareWarning, Phone, ShieldAlert, Smartphone, Stethoscope, UserRound, Users } from 'lucide-react';
import { PLANS } from '../domain/catalog';
import { quotePremium } from '../domain/pricing';
import { DEMO_PERSONAS } from '../domain/seed';
import { naira } from '../domain/util';
import { Badge, go } from '../ui/kit';

const PROBLEMS = [
  {
    icon: Users,
    problem: 'Most Nigerians are uninsured',
    detail: 'Schemes are built around salaried workers, but most people earn daily in the informal sector.',
    fix: 'Pay daily, weekly or monthly by USSD, mobile money or agent. Group codes for markets and cooperatives. Sponsored cover for the vulnerable.',
    link: 'enroll',
  },
  {
    icon: Clock,
    problem: 'Hospitals wait months to be paid',
    detail: 'Opaque, manual vetting means claims sit for weeks; providers then turn insured patients away.',
    fix: 'Rules-based adjudication decides every claim line instantly, with reasons. Payment SLAs are tracked publicly per HMO.',
    link: 'provider/claim',
  },
  {
    icon: ShieldAlert,
    problem: 'Fraud and ghost enrollees',
    detail: 'Duplicate bills, padded quantities, impossible services and unverifiable members drain the pool.',
    fix: 'NIN-verified enrolment, check-digit IDs and a fraud engine that holds risky claims for review. Members confirm their own visits.',
    link: 'hmo/claims',
  },
  {
    icon: FileSearch,
    problem: 'Slow verification and authorisation codes',
    detail: 'Patients wait at the front desk while staff phone the HMO for eligibility and PA codes.',
    fix: 'One search returns live eligibility and benefits. Routine PA codes are issued in seconds; complex ones have a 24-hour SLA.',
    link: 'provider/verify',
  },
  {
    icon: Banknote,
    problem: 'Insured patients still pay out of pocket',
    detail: 'Members are asked to pay for covered drugs and tests and rarely know what their plan includes.',
    fix: 'Plain-language benefits, co-pays shown upfront, and a complaint line (app or USSD) with escalation to the regulator.',
    link: 'member/benefits',
  },
  {
    icon: Eye,
    problem: 'Regulators fly blind',
    detail: 'There is little real-time data on enrolment, claims turnaround or complaints.',
    fix: 'A live regulator dashboard: coverage by state and sector, HMO league table, payment speed, fraud caught, complaints.',
    link: 'regulator',
  },
];

const ROLES = [
  { icon: UserRound, title: 'Member', text: 'See your cover, pay premiums, check visits billed in your name, complain.', link: 'member' },
  { icon: Stethoscope, title: 'Hospital', text: 'Verify patients, get PA codes, submit claims, track payments and capitation.', link: 'provider' },
  { icon: Building2, title: 'HMO', text: 'Work the review queue, approve PA requests, pay providers, resolve complaints.', link: 'hmo' },
  { icon: Landmark, title: 'Regulator', text: 'Monitor coverage, HMO performance, fraud and complaints nationwide.', link: 'regulator' },
  { icon: Smartphone, title: 'USSD', text: 'The whole member experience on any phone — no data needed.', link: 'ussd' },
];

export function Landing() {
  const daily = quotePremium({ planId: 'basic', dependants: 0, frequency: 'daily', sector: 'informal' }).installment;
  return (
    <div className="stack-lg">
      <section className="hero">
        <div>
          <Badge tone="green">Health insurance for every Nigerian</Badge>
          <h1>Cover that works for the trader, the rider and the hospital.</h1>
          <p className="lead">
            HealthGuard connects members, hospitals, HMOs and the regulator on one platform — so premiums are affordable,
            claims are paid fast, fraud is caught early and nobody is turned away.
          </p>
          <div className="actions">
            <button onClick={() => go('enroll')}>
              Get covered from {naira(daily)}/day <ArrowRight size={16} aria-hidden />
            </button>
            <button className="secondary" onClick={() => go('ussd')}>
              <Phone size={16} aria-hidden /> Try the USSD menu
            </button>
          </div>
        </div>
        <div className="hero-card" aria-hidden>
          <div className="idcard">
            <div className="idcard-top">
              <span>HealthGuard</span>
              <BadgeCheck size={18} />
            </div>
            <div className="idcard-id">{DEMO_PERSONAS.trader}</div>
            <div className="idcard-name">Adaeze Okafor</div>
            <div className="idcard-meta">
              <span>Standard plan</span>
              <span>Ikeja Family Clinic</span>
            </div>
            <div className="idcard-status">● Active · paid weekly via USSD</div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="section-title">Six problems, fixed at the root</h2>
        <div className="grid three">
          {PROBLEMS.map(({ icon: Icon, problem, detail, fix, link }) => (
            <article key={problem} className="card problem">
              <Icon className="problem-icon" aria-hidden />
              <h3>{problem}</h3>
              <p className="muted">{detail}</p>
              <p className="fix">
                <strong>HealthGuard:</strong> {fix}
              </p>
              <a className="link" href={`#/${link}`}>
                See it working <ArrowRight size={14} aria-hidden />
              </a>
            </article>
          ))}
        </div>
      </section>

      <section>
        <h2 className="section-title">Plans</h2>
        <div className="grid three">
          {PLANS.map((p) => {
            const q = quotePremium({ planId: p.id, dependants: 0, frequency: 'daily', sector: 'informal' });
            const covered = Object.values(p.benefits).filter((b) => b.covered).length;
            return (
              <article key={p.id} className="card plan">
                <h3>{p.name}</h3>
                <p className="muted">{p.tagline}</p>
                <p className="price">
                  {naira(p.monthlyPremium)}<span>/month</span>
                </p>
                <p className="muted small">or {naira(q.installment)}/day · up to {naira(p.annualLimit)} a year · {covered} of 10 benefit types</p>
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="section-title">Explore every side of the system</h2>
        <div className="grid five">
          {ROLES.map(({ icon: Icon, title, text, link }) => (
            <a key={title} className="card role" href={`#/${link}`}>
              <Icon aria-hidden />
              <h3>{title}</h3>
              <p className="muted small">{text}</p>
            </a>
          ))}
        </div>
        <p className="muted small center footnote">
          <MessageSquareWarning size={14} aria-hidden /> All data here is generated demo data. Changes are saved in your browser; use “Reset demo” to start over.
        </p>
      </section>
    </div>
  );
}
