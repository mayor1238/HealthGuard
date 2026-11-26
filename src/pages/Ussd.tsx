import { Phone, PhoneOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { USSD_CODE } from '../domain/ussd';
import { useMeta } from '../state/session';
import { Card, Field, Notice } from '../ui/kit';

const DEMO_PHONES: [string, string][] = [
  ['08031234567', 'Adaeze Okafor (08031234567)'],
  ['08061234567', 'Musa Abdullahi (08061234567)'],
  ['08091234567', 'Funke Adeyemi (08091234567)'],
  ['07031234567', 'Blessing Eze (07031234567)'],
  ['08099990000', 'Unregistered number (08099990000)'],
];

/** Phone simulator that talks to the real USSD gateway endpoint, exactly as an aggregator would. */
export function Ussd() {
  const meta = useMeta();
  const [phone, setPhone] = useState(DEMO_PHONES[0][0]);
  const [custom, setCustom] = useState('');
  const [session, setSession] = useState<{ id: string; text: string } | null>(null);
  const [screen, setScreen] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const number = custom.trim() || phone;

  const send = async (sessionId: string, text: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<string>('/ussd', { form: { sessionId, phoneNumber: number, text, serviceCode: USSD_CODE } });
      const [kind, ...rest] = res.split(' ');
      setScreen(rest.join(' '));
      setSession(kind === 'CON' ? { id: sessionId, text } : null);
      setInput('');
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (e) {
      setError(errorMessage(e));
      setSession(null);
    } finally {
      setBusy(false);
    }
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
          {meta.data?.demoLogins && (
            <Field label="Phone in your hand (demo numbers)">
              <select
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setCustom('');
                  setScreen(null);
                  setSession(null);
                }}
              >
                {DEMO_PHONES.map(([p, label]) => (
                  <option key={p} value={p}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="…or type any phone number" hint="Use the number you enrolled with to see your own cover.">
            <input inputMode="tel" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d+]/g, ''))} placeholder="08031234567" />
          </Field>
          <ul className="checklist small">
            <li>1 → check cover · 2 → pay premium · 3 → find hospital · 4 → report a problem · 5 → my ID</li>
            <li>This simulator calls the same endpoint a USSD aggregator would. Payments start as pending until the mobile-money provider confirms them; complaints go straight to the HMO.</li>
          </ul>
        </Card>
        {error && <Notice tone="red">{error}</Notice>}
      </div>
      <div className="phone" aria-label="Phone simulator">
        <div className="phone-screen" aria-live="polite">
          {busy ? <pre className="dim">USSD code running…</pre> : screen ? <pre>{screen}</pre> : <pre className="dim">Dial {USSD_CODE}</pre>}
        </div>
        {session ? (
          <form
            className="phone-input"
            onSubmit={(e) => {
              e.preventDefault();
              if (!input.trim()) return;
              send(session.id, session.text === '' ? input.trim() : `${session.text}*${input.trim()}`);
            }}
          >
            <input ref={inputRef} inputMode="numeric" aria-label="Reply" value={input} onChange={(e) => setInput(e.target.value.replace(/[^0-9]/g, ''))} autoFocus disabled={busy} />
            <button type="submit" disabled={busy}>
              Send
            </button>
            <button
              type="button"
              className="danger"
              aria-label="Cancel session"
              onClick={() => {
                setSession(null);
                setScreen(null);
              }}
            >
              <PhoneOff size={16} />
            </button>
          </form>
        ) : (
          <button className="dial" disabled={busy} onClick={() => send(`web-${Date.now()}`, '')}>
            <Phone size={16} aria-hidden /> Dial {USSD_CODE}
          </button>
        )}
      </div>
    </div>
  );
}
