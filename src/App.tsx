import { Building2, Landmark, Menu, Phone, RotateCcw, ShieldCheck, Stethoscope, UserRound, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { useStore } from './state/store';
import { useRoute } from './ui/kit';
import { Landing } from './pages/Landing';
import { Enroll } from './pages/Enroll';
import { Member } from './pages/Member';
import { ProviderPortal } from './pages/Provider';
import { HmoPortal } from './pages/Hmo';
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
  const { reset } = useStore();
  const [open, setOpen] = useState(false);

  const page = (() => {
    switch (section) {
      case 'enroll': return <Enroll />;
      case 'member': return <Member tab={tab} navigate={navigate} />;
      case 'provider': return <ProviderPortal tab={tab} navigate={navigate} />;
      case 'hmo': return <HmoPortal tab={tab} navigate={navigate} />;
      case 'regulator': return <Regulator />;
      case 'ussd': return <Ussd />;
      default: return <Landing />;
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
          <button
            className="ghost small"
            title="Restore the demo data"
            onClick={() => {
              if (confirm('Reset all demo data to its starting state?')) reset();
            }}
          >
            <RotateCcw size={14} aria-hidden /> Reset demo
          </button>
        </nav>
      </header>
      <main key={section}>{page}</main>
      <footer className="footer">
        HealthGuard prototype · demo data only · organisation names are fictional
      </footer>
    </>
  );
}
