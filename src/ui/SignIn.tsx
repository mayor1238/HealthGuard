import { LogIn } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import type { Role } from '../api/types';
import { HMOS, PROVIDERS } from '../domain/catalog';
import { roleLabel, useMeta, useSession } from '../state/session';
import { Card, Field, Loading, Notice } from './kit';

/** Demo accounts created by the server's demo seed (SEED_DEMO=true). Shown only when the server says demo logins exist. */
const DEMO: Record<Role, { label: string; username: string; password: string }[]> = {
  member: [
    { label: 'Adaeze Okafor — trader, Lagos', username: '08031234567', password: '123456' },
    { label: 'Musa Abdullahi — okada rider, Kano', username: '08061234567', password: '123456' },
    { label: 'Funke Adeyemi — employee, Ibadan', username: '08091234567', password: '123456' },
    { label: 'Blessing Eze — sponsored, Lagos', username: '07031234567', password: '123456' },
  ],
  provider: PROVIDERS.map((p) => ({ label: `${p.name} — ${p.state}`, username: p.id, password: 'demo-provider' })),
  hmo: HMOS.map((h) => ({ label: h.name, username: h.id, password: 'demo-hmo' })),
  regulator: [{ label: 'Scheme regulator', username: 'regulator', password: 'demo-regulator' }],
};

export function SignIn({ role }: { role: Role }) {
  const { login, principal, expired } = useSession();
  const meta = useMeta();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMember = role === 'member';

  const submit = async (u: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      const who = await login(u, p);
      if (who.role !== role) setError(`That is a ${roleLabel[who.role].toLowerCase()} account. This area needs a ${roleLabel[role].toLowerCase()} account.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="narrow signin">
      <Card title={<><LogIn size={18} aria-hidden /> {roleLabel[role]} sign-in</>}>
        {expired && <Notice tone="amber">Your session expired. Please sign in again.</Notice>}
        {principal && principal.role !== role && (
          <Notice tone="blue">You're signed in as a {roleLabel[principal.role].toLowerCase()}. Sign in with a {roleLabel[role].toLowerCase()} account to continue.</Notice>
        )}
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            submit(username.trim(), password);
          }}
        >
          <Field label={isMember ? 'Phone number' : 'Username'}>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" inputMode={isMember ? 'tel' : undefined} required />
          </Field>
          <Field label={isMember ? '6-digit PIN' : 'Password'}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" inputMode={isMember ? 'numeric' : undefined} required />
          </Field>
          {error && <Notice tone="red">{error}</Notice>}
          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {isMember && (
            <p className="muted small">
              Not a member yet? <a className="link" href="#/enroll">Join HealthGuard</a>
            </p>
          )}
        </form>
      </Card>
      {meta.data?.demoLogins && (
        <Card title="Demo accounts">
          <p className="muted small">This server has demo data loaded. Pick an account to sign in instantly.</p>
          <div className="demo-logins">
            {DEMO[role].map((d) => (
              <button key={d.username} className="ghost small" disabled={busy} onClick={() => submit(d.username, d.password)}>
                {d.label}
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/** Shows the page only to a signed-in user with the given role; otherwise a sign-in form. */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { principal, checking } = useSession();
  if (checking) return <Loading label="Checking your session…" />;
  if (!principal || principal.role !== role) return <SignIn role={role} />;
  return <>{children}</>;
}
