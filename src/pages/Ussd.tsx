import { MessageSquare, Phone, PhoneOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { DEMO_PERSONAS } from '../domain/seed';
import { USSD_CODE, ussd, type UssdResponse } from '../domain/ussd';
import { useStore } from '../state/store';
import { COMPLAINT_LABELS, Card, Field } from '../ui/kit';

export function Ussd() {
  const store = useStore();
  const { db, today } = store;
  const phones = Object.values(DEMO_PERSONAS)
    .map((id) => db.enrollees.find((e) => e.id === id)!)
    .map((e) => [e.phone, `${e.firstName} ${e.lastName} (${e.phone})`] as const);
  const [phone, setPhone] = useState<string>(phones[0][0]);
  const [session, setSession] = useState<string | null>(null);
  const [screen, setScreen] = useState<UssdResponse | null>(null);
  const [input, setInput] = useState('');
  const [sms, setSms] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = (text: string) => {
    const res = ussd(phone, text, db.enrollees, today);
    setScreen(res);
    setSession(res.kind === 'CON' ? text : null);
    setInput('');
    if (res.action) {
      const a = res.action;
      if (a.type === 'pay') {
        const r = store.pay(a.enrolleeId, a.frequency, 'ussd');
        setSms((s) => [`HealthGuard: N${r.amount.toLocaleString('en-NG')} received. Cover active till ${r.paidThrough}.`, ...s]);
      } else if (a.type === 'complaint') {
        const c = store.fileComplaint({ enrolleeId: a.enrolleeId, category: a.category, description: `${COMPLAINT_LABELS[a.category]} (reported by USSD)`, channel: 'ussd' });
        setSms((s) => [`HealthGuard: Complaint ${c.id} received. Your HMO will call you within 48 hours.`, ...s]);
      } else {
        setSms((s) => ['HealthGuard: Thanks! An enrolment agent will call you shortly.', ...s]);
      }
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="grid two">
      <div className="stack">
        <div>
          <h1>USSD for any phone</h1>
          <p className="muted">
            Most Nigerians in the informal sector use basic phones. Dial <strong>{USSD_CODE}</strong> to check cover, pay a day's premium from mobile money, find a clinic or report a problem — no smartphone or data needed.
          </p>
        </div>
        <Card>
          <Field label="Phone in your hand (demo)">
            <select
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                setScreen(null);
                setSession(null);
              }}
            >
              {phones.map(([p, label]) => (
                <option key={p} value={p}>
                  {label}
                </option>
              ))}
              <option value="08099990000">Unregistered number (08099990000)</option>
            </select>
          </Field>
          <ul className="checklist small">
            <li>1 → check cover · 2 → pay premium · 3 → find hospital · 4 → report a problem · 5 → my ID</li>
            <li>Payments and complaints made here appear instantly in the member, HMO and regulator views.</li>
          </ul>
        </Card>
        {sms.length > 0 && (
          <Card
            title={
              <>
                <MessageSquare size={18} aria-hidden /> SMS inbox
              </>
            }
          >
            <ul className="list">
              {sms.map((m, i) => (
                <li key={i} className="small">
                  {m}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className="phone" aria-label="Phone simulator">
        <div className="phone-screen" aria-live="polite">
          {screen ? <pre>{screen.text}</pre> : <pre className="dim">Dial {USSD_CODE}</pre>}
        </div>
        {session !== null ? (
          <form
            className="phone-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (!input.trim()) return;
              run(session === '' ? input.trim() : `${session}*${input.trim()}`);
            }}
          >
            <input ref={inputRef} inputMode="numeric" aria-label="Reply" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9]/g, ''))} autoFocus />
            <button type="submit">Send</button>
            <button type="button" className="danger" onClick={() => { setSession(null); setScreen(null); }} aria-label="Cancel session">
              <PhoneOff size={16} />
            </button>
          </form>
        ) : (
          <button className="dial" onClick={() => run('')}>
            <Phone size={16} aria-hidden /> Dial {USSD_CODE}
          </button>
        )}
      </div>
    </div>
  );
}
