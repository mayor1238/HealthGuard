import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Apple, BadgeCheck, Bell, Clock, FileHeart, HeartPulse, Hospital, Lock, QrCode, ShieldCheck, Stethoscope, Users } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import './styles.css';

type Page = 'home' | 'passport' | 'sharing' | 'doctor' | 'hospital' | 'coach' | 'integrations' | 'nutrition' | 'recovery' | 'community' | 'learning';

const clinicalRecords = ['Allergies', 'Current Medications', 'Pregnancy History', 'Laboratory Results', 'Vaccinations', 'Delivery Summary'];
const wellnessLogs = ['Sleep: 6.5 hours', 'Hydration: 7 glasses', 'Mood: Calm', 'Activity: 5,240 steps'];
const integrations = ['Google Fit', 'Apple Health', 'Samsung Health', 'Fitbit', 'Garmin', 'Smartwatches'];

function Badge({ children, tone = 'green' }: { children: React.ReactNode; tone?: 'green' | 'blue' | 'pink' | 'gray' | 'amber' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

function App() {
  const [page, setPage] = useState<Page>('home');
  const [selected, setSelected] = useState(['Allergies', 'Current Medications', 'Pregnancy History']);
  const token = useMemo(() => `HP-${Math.random().toString(36).slice(2, 8).toUpperCase()}-30MIN`, [selected.length]);
  const nav: [Page, string][] = [['home','Home'],['passport','Health Passport'],['sharing','Manage Sharing'],['doctor','Doctor Portal'],['hospital','Hospital Portal'],['coach','AI Coach'],['integrations','Integrations'],['nutrition','Nutrition'],['recovery','Recovery'],['community','Community'],['learning','Learning Hub']];

  return <>
    <header className="topbar"><div className="brand"><HeartPulse /> HerPulse</div><nav>{nav.map(([id,label])=><button className={page===id?'active':''} onClick={()=>setPage(id)} key={id}>{label}</button>)}</nav></header>
    <main>
      {page==='home' && <Home setPage={setPage}/>} {page==='passport' && <Passport selected={selected} setSelected={setSelected} token={token}/>} {page==='sharing' && <Sharing/>}
      {page==='doctor' && <Doctor selected={selected}/>} {page==='hospital' && <HospitalPage/>} {page==='coach' && <Coach/>} {page==='integrations' && <Integrations/>}
      {['nutrition','recovery','community','learning'].includes(page) && <Placeholder page={page}/>} 
    </main>
  </>;
}

function Home({ setPage }: { setPage: (p: Page)=>void }) {
  return <div className="hero"><div><Badge tone="pink">Privacy-first women's health</Badge><h1>HerPulse Health Passport keeps care connected without giving up control.</h1><p>Women own their health story. Hospitals verify clinical records, doctors request temporary access, and patients approve exactly what is shared.</p><div className="actions"><button onClick={()=>setPage('passport')}>Open Health Passport</button><button className="secondary" onClick={()=>setPage('coach')}>Talk to Wellness Coach</button></div></div><Card><ShieldCheck className="big"/><h3>Patient-controlled by design</h3><p>No provider can freely browse records. Every access session is consented, scoped, audited, and temporary.</p></Card></div>;
}

function Passport({ selected, setSelected, token }: { selected: string[]; setSelected: (v:string[])=>void; token:string }) {
  const toggle = (r: string) => setSelected(selected.includes(r) ? selected.filter(x=>x!==r) : [...selected, r]);
  return <div className="grid two"><Card><div className="split"><div><Badge tone="blue">HerPulse Health Passport</Badge><h2>Passport ID: HP-4829-2026</h2><p className="muted">Emergency QR reveals only lifesaving essentials unless you approve more.</p></div><QRCodeSVG value="HP-4829-2026 emergency: blood O+, allergies penicillin" size={132}/></div><div className="facts"><span>Blood Group <b>O+</b></span><span>Emergency Contact <b>Maya Patel</b></span><span>Primary Hospital <b>City Women's Hospital</b></span></div></Card>
  <Card><h3><BadgeCheck/> Verified Clinical Data</h3><p className="muted">Uploaded and verified by hospitals. Patients decide what doctors can see.</p>{clinicalRecords.map(r=><label className="row" key={r}><input type="checkbox" checked={selected.includes(r)} onChange={()=>toggle(r)}/><span>{r}</span><Badge>Hospital Verified</Badge><Badge tone={selected.includes(r)?'blue':'gray'}>{selected.includes(r)?'Shared':'Private'}</Badge></label>)}</Card>
  <Card><h3><Activity/> Personal Wellness Data</h3><p className="muted">Self-reported logs and future wearable syncs. Hospitals cannot edit these entries.</p>{wellnessLogs.map(l=><div className="row" key={l}><span>{l}</span><Badge tone="gray">Patient Generated</Badge><Badge tone="pink">Private</Badge></div>)}</Card>
  <Card><h3><Lock/> Consent before sharing</h3><div className="consent"><p><b>Share with:</b> Dr. Sarah Johnson</p><p><b>Duration:</b> Current consultation only</p><p><b>Records selected:</b> {selected.join(', ') || 'None selected'}</p><button>Approve Access</button><p className="token">Temporary token: {token}</p></div></Card></div>;
}

function Sharing(){ const logs=['Dr. Sarah Johnson viewed Allergies · 10:42 UTC','City Women’s Hospital uploaded lab report · Yesterday','Revoked access for Midtown Clinic · Jul 18']; return <div className="grid two"><Card><h2>Manage Data Sharing</h2><p className="muted">Approve requests, revoke active sessions instantly, and review every timestamp.</p><div className="session"><Badge tone="green">Access Granted</Badge><b>Dr. Sarah Johnson</b><span>Allergies, Medications, Pregnancy History</span><span>Expires in 27 minutes</span><button>Revoke Access</button></div><div className="session"><Badge tone="amber">Pending Request</Badge><b>Northside Clinic</b><span>Requests recent laboratory results</span><button>Approve Request</button></div></Card><Card><h3>Audit Log</h3>{logs.map(l=><div className="row" key={l}><Clock size={16}/><span>{l}</span></div>)}</Card></div> }
function Doctor({ selected }: { selected:string[] }){ return <div className="grid two"><Card><h2>Doctor Portal</h2><p>Enter Passport ID or scan QR to request consent-based access.</p><input placeholder="HP-4829-2026"/><button>Request Patient Approval</button><Badge tone="green">Access Granted</Badge><p className="muted">Access expires in 27 minutes and is limited to approved records only.</p></Card><Card><h3>Approved Records</h3>{selected.map(r=><div className="row" key={r}><FileHeart size={16}/>{r}<Badge tone="blue">Approved</Badge></div>)}</Card></div>}
function HospitalPage(){ return <div className="grid two"><Card><h2>Hospital Portal</h2><p>Hospitals upload verified clinical data only; patient wellness logs remain read-only and patient-owned.</p>{['Verified diagnoses','Clinical notes','Laboratory reports','Prescriptions','Vaccinations','Pregnancy records','Delivery summaries'].map(x=><div className="row" key={x}><Hospital size={16}/>{x}<Badge>Upload Enabled</Badge></div>)}</Card><Card><h3>Restricted</h3><p><Lock/> Hospitals cannot edit self-reported mood, sleep, hydration, activity, or recovery logs.</p></Card></div>}
function Coach(){ return <div className="grid two"><Card><h2>AI Wellness Coach</h2><p className="muted">Supportive education, habits, nutrition, postpartum and menstrual guidance — never diagnosis or disease prediction.</p><div className="chat"><b>You:</b> I am 6 weeks postpartum, tired, stressed, and sleeping poorly.<br/><b>Coach:</b> Thanks for sharing your stage and symptoms. Before suggestions: are you having heavy bleeding, fever, chest pain, or thoughts of self-harm? If yes, contact urgent care now. If not, we can plan gentle recovery: hydration reminders, iron-rich meals, short walks, pelvic-floor basics, and a sleep handoff routine with support.</div></Card><Card><h3>Context used</h3>{['Life stage','Symptoms','Mood','Recovery progress','Sleep','Hydration','Stress','Nutrition'].map(x=><Badge key={x} tone="pink">{x}</Badge>)}</Card></div>}
function Integrations(){ return <div><h2>Integrations</h2><p className="muted">Future versions will reduce manual logging by importing steps, sleep, heart rate, activity, weight, and hydration.</p><div className="grid three">{integrations.map((name,i)=><Card key={name}><Apple/><h3>{name}</h3><Badge tone={i<2?'green':'gray'}>{i<2?'Connected':'Not Connected'}</Badge><p>Last synced: {i<2?'Today 09:15 UTC':'Not yet synced'}</p><button>{i<2?'Sync Data':'Connect'}</button></Card>)}</div></div>}
function Placeholder({page}:{page:Page}){ return <Card><Users className="big"/><h2>{page[0].toUpperCase()+page.slice(1)}</h2><p>Existing HerPulse experience preserved with privacy-first messaging and improved empty states.</p></Card>}

createRoot(document.getElementById('root')!).render(<App />);
