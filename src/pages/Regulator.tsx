import { AlertTriangle } from 'lucide-react';
import type { AuditEntry, RegulatorSummary } from '../api/types';
import { HMOS, PROVIDERS, providerById } from '../domain/catalog';
import type { Complaint } from '../domain/types';
import { compactNaira, naira, prettyDate } from '../domain/util';
import { useApiQuery, useMeta } from '../state/session';
import { Badge, BarList, COMPLAINT_LABELS, Card, Empty, Loadable, Stat, pct } from '../ui/kit';

export function Regulator() {
  const meta = useMeta();
  const q = useApiQuery<RegulatorSummary>(['regulator', 'summary'], '/regulator/summary', { refetchInterval: 60_000 });
  const escalated = useApiQuery<Complaint[]>(['regulator', 'escalated'], '/regulator/complaints?status=escalated');
  const audit = useApiQuery<AuditEntry[]>(['regulator', 'audit'], '/regulator/audit?limit=12', { refetchInterval: 30_000 });

  return (
    <Loadable q={q} label="Loading scheme data…">
      {({ summary: s, hmos, fraudFlags }) => {
        const gapStates = s.byState.filter(([state, n]) => n === 0 || !PROVIDERS.some((p) => p.state === state && p.level === 'primary' && p.accredited));
        const esc = escalated.data ?? [];
        return (
          <div className="stack">
            <div className="page-head">
              <div>
                <h1>Regulator dashboard</h1>
                <p className="muted">Live view of the scheme{meta.data ? ` · ${prettyDate(meta.data.today)}` : ''}</p>
              </div>
            </div>

            <div className="grid four tight">
              <Stat label="Lives covered" value={s.livesCovered.toLocaleString()} hint={`${s.enrollees} principals + dependants`} />
              <Stat label="Active cover" value={pct(s.active / Math.max(1, s.enrollees))} hint={`${s.enrollees - s.active} lapsed or unpaid — target for renewal nudges`} />
              <Stat label="Informal-sector members" value={pct(s.bySector.informal / Math.max(1, s.enrollees))} hint="Paying daily/weekly via USSD & agents" />
              <Stat label="Sponsored (vulnerable)" value={s.sponsoredLives} hint="Funded by BHCPF, state equity funds & donors" />
              <Stat label="Claims decided automatically" value={pct(s.autoAdjudicated)} hint={`${s.claims} claims in total`} tone="green" />
              <Stat label="Avg days to pay providers" value={s.avgDaysToPay.toFixed(1)} hint={`${s.overdueClaims} claims past target now`} tone={s.overdueClaims ? 'amber' : undefined} />
              <Stat label="Saved by tariff caps & limits" value={compactNaira(s.tariffSavings)} hint={`Fraud blocked on review: ${compactNaira(s.blockedFraud)}`} />
              <Stat label="Open complaints" value={s.openComplaints} hint={`${esc.length} escalated to you`} tone={esc.length ? 'red' : undefined} />
            </div>

            <Card title="HMO league table">
              <p className="muted small">Published to people choosing an HMO, so HMOs compete on paying hospitals and treating members well. Financial ratios cover the last 90 days.</p>
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
                    {[...hmos]
                      .sort((a, b) => a.avgDaysToPay - b.avgDaysToPay)
                      .map((h) => {
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
                {fraudFlags.length === 0 ? <Empty>No flags raised.</Empty> : <BarList rows={fraudFlags.map((f) => ({ label: f.rule.replace(/_/g, ' ').toLowerCase(), value: f.count }))} format={(n) => `${n}`} />}
              </Card>
              <Card title="Escalated complaints">
                <Loadable q={escalated}>
                  {(rows) =>
                    rows.length === 0 ? (
                      <Empty>Nothing escalated.</Empty>
                    ) : (
                      <ul className="list">
                        {rows.slice(0, 8).map((c) => (
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
                    )
                  }
                </Loadable>
              </Card>
            </div>

            <Card title="Recent activity (audit log)">
              <Loadable q={audit}>
                {(rows) => (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Who</th>
                          <th>Action</th>
                          <th>Record</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((a) => (
                          <tr key={a.id}>
                            <td className="small">{new Date(a.at).toLocaleString('en-GB')}</td>
                            <td className="small">{a.actorRole}</td>
                            <td className="mono">{a.action}</td>
                            <td className="mono">{a.entityId}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Loadable>
            </Card>
          </div>
        );
      }}
    </Loadable>
  );
}
