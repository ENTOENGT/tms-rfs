'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { period, PERIODS } from '@/lib/period';

export default function Dashboard() {
  const { me, lk } = useMe();
  const [key, setKey] = useState('this_month');
  const [custom, setCustom] = useState<[string, string]>(['', '']);
  const [k, setK] = useState<any>(null);
  const [from, to] = key === 'custom' ? custom : period(key, lk.timezone);
  useEffect(() => { if (from && to) api(`/api/dashboard?from=${from}&to=${to}`).then(setK); }, [from, to]);
  const f = k?.financials ?? {};
  const cur = lk.currency;
  const Kpi = ({ n, label, href, attn }: { n: any; label: string; href?: string; attn?: boolean }) =>
    href ? <Link className={`kpi${attn && n > 0 ? ' attn' : ''}`} href={href}><b>{n ?? '–'}</b><span>{label}</span></Link>
         : <div className="kpi"><b>{n ?? '–'}</b><span>{label}</span></div>;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}, {me.full_name.split(' ')[0]}</h1>
        <span className="spacer" />
        <select value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 170 }} aria-label="Period">
          <option value="today">Today</option><option value="yesterday">Yesterday</option>
          <option value="this_week">This week</option><option value="last_week">Last week</option>
          <option value="this_month">This month</option><option value="last_month">Last month</option>
          <option value="this_year">This year</option><option value="custom">Custom range</option>
        </select>
        {key === 'custom' && <>
          <input type="date" style={{ width: 150 }} value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="From" />
          <input type="date" style={{ width: 150 }} value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="To" />
        </>}
      </div>
      <div className="kpis">
        <Kpi n={k?.today_jobs} label="Today's jobs" href="/jobs" />
        <Kpi n={k?.pending} label="Pending assignment" href="/requests" attn />
        <Kpi n={k?.assigned} label="Assigned" href="/jobs?status=assigned" />
        <Kpi n={k?.in_transit} label="In transit" href="/jobs?status=in_transit" />
        <Kpi n={k?.delivered} label="Delivered" />
        <Kpi n={k?.pod_pending} label="Delivered, POD missing" href="/jobs?action_required=pod" attn />
        <Kpi n={k?.completed} label="Completed" href="/jobs?status=completed" />
      </div>
      {k?.financials && (
        <div className="kpis" style={{ marginTop: 12 }}>
          {'net_revenue' in f && <div className="kpi money"><b>{fmtMoney(f.net_revenue, cur)}</b><span>Revenue before VAT</span></div>}
          {'total_cost' in f && <div className="kpi money"><b>{fmtMoney(f.total_cost, cur)}</b><span>Transport cost</span></div>}
          {f.profit && <div className="kpi money"><b>{fmtMoney(f.profit.gross_profit, cur)}</b><span>Gross profit</span></div>}
          {f.profit && <div className="kpi money"><b>{f.profit.margin_pct ?? '–'}%</b><span>Margin</span></div>}
        </div>
      )}
      <p className="muted small">Counts cover jobs with a required date from {from} to {to}. Charts and the live operations table arrive in Phase 8.</p>
    </div>
  );
}
