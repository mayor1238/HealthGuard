import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { hmoScorecard, systemSummary } from '../domain/analytics';
import { HMOS, PROVIDERS, providerById } from '../domain/catalog';
import { compactNaira, naira, prettyDate } from '../domain/util';
import { useStore } from '../state/store';
import { Badge, BarList, COMPLAINT_LABELS, Card, Empty, Stat, pct } from '../ui/kit';

export function Regulator() {
  const { db, today } = useStore();
  const s = useMemo(() => systemSummary(db, today), [db, today]);
  const scores = useMemo(() => hmoScorecard(db, today), [db, today]);
  const escalated = db.complaints.filter((c) => c.status === 'escalated').sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const flagCounts = useMemo(() => {
    const m: Record<string, number> = {};
    db.claims.forEach((c) => c.fraudFlags.forEach((f) => (m[f.rule] = (m[f.rule] ?? 0) + 1)));
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [db]);

  const gapStates = s.byState.filter(([state, n]) => n === 0 || !PROVIDERS.some((p) => p.state === state && p.level === 'primary' && p.accredited));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Regulator dashboard</h1>
          <p className="muted">Live view of the scheme · {prettyDate(today)}</p>
        </div>
      </div>

      <div className="grid four tight">
        <Stat label="Lives covered" value={s.livesCovered.toLocaleString()} hint={`${s.enrollees} principals + dependants`} />
        <Stat label="Active cover" value={pct(s.active / s.enrollees)} hint={`${s.enrollees - s.active} lapsed — target for renewal nudges`} />
        <Stat label="Informal-sector members" value={pct(s.bySector.informal / s.enrollees)} hint="Paying daily/weekly via USSD & agents" />
        <Stat label="Sponsored (vulnerable)" value={s.sponsoredLives} hint="Funded by BHCPF, state equity funds & donors" />
        <Stat label="Claims decided automatically" value={pct(s.autoAdjudicated)} hint={`${s.claims} claims in total`} tone="green" />
        <Stat label="Avg days to pay providers" value={s.avgDaysToPay.toFixed(1)} hint={`${s.overdueClaims} claims past target now`} tone={s.overdueClaims ? 'amber' : undefined} />
        <Stat label="Saved by tariff caps & limits" value={compactNaira(s.tariffSavings)} hint={`Fraud blocked on review: ${compactNaira(s.blockedFraud)}`} />
        <Stat label="Open complaints" value={s.openComplaints} hint={`${escalated.length} escalated to you`} tone={escalated.length ? 'red' : undefined} />
      </div>

      <Card title="HMO league table">
        <p className="muted small">Published to members at enrolment, so HMOs compete on paying hospitals and treating members well. Financial ratios cover the last 90 days.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>HMO</th>
                <th>Members</th>
                <th>Avg days to pay</th>
                <th>Paid within target</th>
                <th>Overdue claims</th>
                <th>Loss ratio</th>
                <th>Complaints / 1k</th>
                <th>Resolved</th>
              </tr>
            </thead>
            <tbody>
              {[...scores].sort((a, b) => a.avgDaysToPay - b.avgDaysToPay).map((h) => {
                const sla = HMOS.find((x) => x.id === h.hmoId)!.claimsSlaDays;
                return (
                  <tr key={h.hmoId}>
                    <td>
                      <strong>{h.name}</strong>
                    </td>
                    <td>{h.enrollees}</td>
                    <td>
                      {h.avgDaysToPay.toFixed(1)} {h.avgDaysToPay > sla ? <Badge tone="red">Above target</Badge> : <Badge tone="green">OK</Badge>}
                    </td>
                    <td>{pct(h.paidWithinSla)}</td>
                    <td>{h.overdueClaims ? <Badge tone="red">{h.overdueClaims}</Badge> : 0}</td>
                    <td title="Claims + capitation paid ÷ premiums collected">{pct(h.medicalLossRatio)}</td>
                    <td>{h.complaintsPer1000.toFixed(0)}</td>
                    <td>{h.complaintResolution < 0.6 ? <Badge tone="amber">{pct(h.complaintResolution)}</Badge> : pct(h.complaintResolution)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid two">
        <Card title="Members by state">
          <BarList rows={s.byState.map(([label, value]) => ({ label, value }))} format={(n) => n.toLocaleString()} />
          {gapStates.length > 0 && (
            <p className="small">
              <AlertTriangle size={14} aria-hidden /> Coverage gap: {gapStates.map(([st]) => st).join(', ')} — no accredited primary clinic. Prioritise provider accreditation there.
            </p>
          )}
        </Card>
        <Card title="Members by sector">
          <BarList
            rows={[
              { label: 'Informal', value: s.bySector.informal },
              { label: 'Formal', value: s.bySector.formal },
              { label: 'Vulnerable', value: s.bySector.vulnerable },
            ]}
            format={(n) => n.toLocaleString()}
          />
          <p className="muted small">Premiums collected (all time): {naira(s.premiums)}</p>
        </Card>
        <Card title="What the fraud engine catches">
          {flagCounts.length === 0 ? (
            <Empty>No flags raised.</Empty>
          ) : (
            <BarList rows={flagCounts.map(([rule, value]) => ({ label: rule.replace(/_/g, ' ').toLowerCase(), value }))} format={(n) => `${n}`} />
          )}
        </Card>
        <Card title="Escalated complaints">
          {escalated.length === 0 ? (
            <Empty>Nothing escalated.</Empty>
          ) : (
            <ul className="list">
              {escalated.slice(0, 8).map((c) => (
                <li key={c.id}>
                  <div className="list-row">
                    <strong>{COMPLAINT_LABELS[c.category]}</strong>
                    <span className="muted small">{prettyDate(c.createdAt)}</span>
                  </div>
                  <span className="muted small">
                    {HMOS.find((h) => h.id === c.hmoId)?.name} · {providerById(c.providerId ?? '')?.name}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
