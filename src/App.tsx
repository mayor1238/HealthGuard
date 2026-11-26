import { Building2, Landmark, LogOut, Menu, Phone, ShieldCheck, Stethoscope, UserPlus, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { roleLabel, useSession } from './state/session';
import { RequireRole } from './ui/SignIn';
import { useRoute } from './ui/kit';
import { Enroll } from './pages/Enroll';
import { HmoPortal } from './pages/Hmo';
import { Landing } from './pages/Landing';
import { Member } from './pages/Member';
import { ProviderPortal } from './pages/Provider';
import { Regulator } from './pages/Regulator';
import { Ussd } from './pages/Ussd';

const NAV = [
  ['enroll', 'Join', UserPlus],
  ['member', 'Member', UserRound],
  ['provider', 'Hospital', Stethoscope],
  ['hmo', 'HMO', Building2],
  ['regulator', 'Regulator', Landmark],
  ['ussd', 'USSD', Phone],
] as const;

export function App() {
  const [section, tab, navigate] = useRoute();
  const { principal, logout } = useSession();
  const [open, setOpen] = useState(false);

  const page = (() => {
    switch (section) {
      case 'enroll':
        return <Enroll />;
      case 'member':
        return <RequireRole role="member"><Member tab={tab} navigate={navigate} /></RequireRole>;
      case 'provider':
        return <RequireRole role="provider"><ProviderPortal tab={tab} navigate={navigate} /></RequireRole>;
      case 'hmo':
        return <RequireRole role="hmo"><HmoPortal tab={tab} navigate={navigate} /></RequireRole>;
      case 'regulator':
        return <RequireRole role="regulator"><Regulator /></RequireRole>;
      case 'ussd':
        return <Ussd />;
      default:
        return <Landing />;
    }
  })();

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/" onClick={() => setOpen(false)}>
          <ShieldCheck aria-hidden /> HealthGuard
        </a>
        <button className="icon-btn menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <X /> : <Menu />}
        </button>
        <nav className={open ? 'open' : ''} aria-label="Main">
          {NAV.map(([id, label, Icon]) => (
            <a key={id} href={`#/${id}`} className={section === id ? 'active' : ''} onClick={() => setOpen(false)}>
              <Icon size={16} aria-hidden /> {label}
            </a>
          ))}
          {principal && (
            <button
              className="ghost small"
              title={`Signed in as ${roleLabel[principal.role]}${principal.username ? ` (${principal.username})` : ''}`}
              onClick={() => {
                logout();
                setOpen(false);
              }}
            >
              <LogOut size={14} aria-hidden /> Sign out · {roleLabel[principal.role]}
            </button>
          )}
        </nav>
      </header>
      <main key={section}>{page}</main>
      <footer className="footer">HealthGuard prototype · organisation names are fictional</footer>
    </>
  );
}
