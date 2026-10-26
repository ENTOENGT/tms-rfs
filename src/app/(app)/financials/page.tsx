'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { BarList, COLORS, MonthChart } from '@/components/Charts';
import { period, PERIODS } from '@/lib/period';

const ALL_TABS: [string, string][] = [['by_department', 'Department'], ['by_customer', 'Customer'], ['by_driver', 'Driver'], ['by_vehicle', 'Vehicle'], ['by_vehicle_type', 'Vehicle type']];

export default function Financials() {
  const { me, lk, can } = useMe();
  const TABS = ALL_TABS.filter(([k]) => k !== 'by_department' || can('jobs.view_all'));
  const fa = me.financial_access;
  const [key, setKey] = useState('this_month');
  const [custom, setCustom] = useState<[string, string]>(['', '']);
  const [f, setF] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState(can('jobs.view_all') ? 'by_department' : 'by_customer');
  const [from, to] = key === 'custom' ? custom : period(key, lk.timezone);
  const cur = lk.currency;

  useEffect(() => {
    if (!from || !to) return;
    const qs = new URLSearchParams({ from, to, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
    const t = setTimeout(() => api(`/api/financials?${qs}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [from, to, f]);

  const money = (v: any) => (v == null ? '—' : `${cur} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const compact = (v: number) => `${cur} ${Math.round(v).toLocaleString('en-US')}`;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target.checked ? '1' : '') : e.target.value });
  const activeFilters = Object.values(f).filter(Boolean).length;
  const acc = data?.access ?? { cost: fa.buyingView, revenue: fa.sellingView, profit: fa.profitView };
  const t = data?.totals ?? {};
  const series = useMemo(() => [
    ...(acc.revenue ? [{ key: 'net_revenue', label: 'Revenue', color: COLORS.revenue }] : []),
    ...(acc.cost ? [{ key: 'total_cost', label: 'Cost', color: COLORS.cost }] : []),
    ...(acc.profit ? [{ key: 'gross_profit', label: 'Profit', color: COLORS.profit }] : []),
  ], [acc.revenue, acc.cost, acc.profit]);

  const exportCsv = () => {
    const rows = data[tab] as any[];
    const cols: [string, string][] = [['label', TABS.find((x) => x[0] === tab)![1]], ['jobs', 'Jobs'], ['completed', 'Completed'],
      ...(acc.revenue ? [['net_revenue', 'Revenue before VAT'], ['vat', 'VAT']] as [string, string][] : []),
      ...(acc.cost ? [['base_cost', 'Base cost'], ['other_expenses', 'Other expenses'], ['total_cost', 'Total cost']] as [string, string][] : []),
      ...(acc.profit ? [['gross_profit', 'Gross profit'], ['margin_pct', 'Margin %']] as [string, string][] : [])];
    const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map((c) => c[1]).join(','), ...rows.map((r) => cols.map((c) => esc(r[c[0]])).join(','))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
    a.download = `financials-${TABS.find((x) => x[0] === tab)![1].toLowerCase().replace(' ', '-')}-${from}-to-${to}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  if (!fa.buyingView && !fa.sellingView) return <div className="page"><div className="msg err">You don't have access to financial information.</div></div>;
  const Kpi = ({ v, label, tone }: { v: any; label: string; tone?: string }) =>
    <div className="kpi money"><b style={tone ? { color: tone } : undefined}>{v}</b><span>{label}</span></div>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Financials</h1>
        {!acc.revenue && <span className="badge outline">Transport cost view</span>}
        <span className="spacer" />
        <select value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 160 }} aria-label="Period">
          {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {key === 'custom' && <>
          <input type="date" style={{ width: 150 }} value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="From" />
          <input type="date" style={{ width: 150 }} value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="To" />
        </>}
        <button className="btn" onClick={() => setShowFilters(!showFilters)}>Filters{activeFilters ? ` (${activeFilters})` : ''}</button>
      </div>

      {showFilters && <div className="panel" style={{ marginBottom: 12 }}>
        <div className="grid g4">
          {can('jobs.view_all') && <label className="f"><span>Department</span><select value={f.department_id ?? ''} onChange={set('department_id')}><option value="">All</option>
            {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
          <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
            {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="f"><span>Driver</span><select value={f.driver_id ?? ''} onChange={set('driver_id')}><option value="">All</option>
            {lk.drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label className="f"><span>Vehicle</span><select value={f.vehicle_id ?? ''} onChange={set('vehicle_id')}><option value="">All</option>
            {lk.vehicles.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label className="f"><span>Vehicle type</span><select value={f.vehicle_type_id ?? ''} onChange={set('vehicle_type_id')}><option value="">All</option>
            {lk.vehicle_types.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All (except drafts & cancelled)</option>
            {lk.job_statuses.filter((s: any) => !['draft', 'cancelled'].includes(s.code)).map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
          <label className="f"><span>Requested by (Operations)</span><select value={f.requested_by ?? ''} onChange={set('requested_by')}><option value="">Anyone</option>
            {lk.users.filter((u: any) => u.department !== 'transport').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="f"><span>Assigned by (Transport)</span><select value={f.assigned_by ?? ''} onChange={set('assigned_by')}><option value="">Anyone</option>
            {lk.users.filter((u: any) => u.department !== 'operations').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="f"><span>Job number / BOE</span>
            <div style={{ display: 'flex', gap: 6 }}><input placeholder="Job No." value={f.job_no ?? ''} onChange={set('job_no')} /><input placeholder="BOE" value={f.boe ?? ''} onChange={set('boe')} /></div></label>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 10 }}>
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={f.completed_only === '1'} onChange={set('completed_only')} /> Completed jobs only</label>
          <button className="btn small" onClick={() => setF({})}>Clear filters</button>
        </div>
      </div>}

      {err && <div className="msg err">{err}</div>}

      <div className="kpis">
        <Kpi v={t.jobs ?? '–'} label="Jobs" />
        <Kpi v={t.completed ?? '–'} label="Completed" />
        {acc.revenue && <Kpi v={money(t.net_revenue)} label="Revenue before VAT" />}
        {acc.revenue && <Kpi v={money(t.vat)} label="VAT (not in profit)" />}
        {acc.cost && <Kpi v={money(t.base_cost)} label="Base transport cost" />}
        {acc.cost && <Kpi v={money(t.other_expenses)} label="Other expenses" />}
        {acc.cost && <Kpi v={money(t.total_cost)} label="Total cost" />}
        {acc.profit && <Kpi v={money(t.gross_profit)} label="Gross profit" tone={Number(t.gross_profit) < 0 ? COLORS.loss : COLORS.profit} />}
        {acc.profit && <Kpi v={t.margin_pct == null ? '—' : `${t.margin_pct}%`} label="Profit margin" />}
      </div>
      <div className="kpis" style={{ marginTop: 8 }}>
        {acc.revenue && <Kpi v={money(t.avg_revenue)} label="Average revenue per job" />}
        {acc.cost && <Kpi v={money(t.avg_cost)} label="Average cost per job" />}
        {acc.profit && <Kpi v={money(t.avg_profit)} label="Average profit per job" />}
      </div>

      {data && <>
        <div className="panel" style={{ marginTop: 16 }}>
          <h2>{series.map((s) => s.label).join(', ')} by month</h2>
          <MonthChart rows={data.by_month} series={series} currency={cur} />
        </div>

        <div className="grid g2" style={{ marginTop: 16, alignItems: 'start' }}>
          <div className="panel"><h2>{acc.revenue ? 'Revenue' : 'Cost'} by customer</h2>
            <BarList rows={data.by_customer} metric={acc.revenue ? 'net_revenue' : 'total_cost'} color={acc.revenue ? COLORS.revenue : COLORS.cost} format={compact} /></div>
          {acc.profit
            ? <div className="panel"><h2>Profit by customer</h2><BarList rows={data.by_customer} metric="gross_profit" color={COLORS.profit} format={compact} /></div>
            : <div className="panel"><h2>Cost by driver</h2><BarList rows={data.by_driver} metric="total_cost" color={COLORS.cost} format={compact} /></div>}
          <div className="panel"><h2>Jobs by vehicle type</h2><BarList rows={data.by_vehicle_type} metric="jobs" color="#B77B32" format={(v) => String(v)} /></div>
          <div className="panel"><h2>Jobs by driver</h2><BarList rows={data.by_driver} metric="jobs" color="#B77B32" format={(v) => String(v)} /></div>
          <div className="panel"><h2>Jobs by status</h2><BarList rows={data.by_status} metric="jobs" color={(r) => r.color ?? '#6B7280'} format={(v) => String(v)} top={20} /></div>
          <div className="panel"><h2>{acc.revenue ? 'Revenue' : 'Cost'} by vehicle</h2>
            <BarList rows={data.by_vehicle} metric={acc.revenue ? 'net_revenue' : 'total_cost'} color={acc.revenue ? COLORS.revenue : COLORS.cost} format={compact} /></div>
        </div>

        <div className="panel flush" style={{ marginTop: 16 }}>
          <div className="page-head" style={{ padding: '12px 16px 0', marginBottom: 0 }}>
            <div className="tabs" role="tablist" style={{ marginBottom: 0, borderBottom: 0 }}>
              {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>By {l.toLowerCase()}</button>)}
            </div>
            <span className="spacer" />
            <button className="btn small" onClick={exportCsv} disabled={!data[tab].length}>Export CSV</button>
          </div>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>{TABS.find((x) => x[0] === tab)![1]}</th><th className="num">Jobs</th><th className="num">Completed</th>
              {acc.revenue && <><th className="num">Revenue</th><th className="num">VAT</th></>}
              {acc.cost && <><th className="num">Base cost</th><th className="num">Other exp.</th><th className="num">Total cost</th></>}
              {acc.profit && <><th className="num">Profit</th><th className="num">Margin</th></>}</tr></thead>
            <tbody>
              {data[tab].map((r: any) => <tr key={r.key}>
                <td><b>{r.label}</b></td><td className="num">{r.jobs}</td><td className="num">{r.completed}</td>
                {acc.revenue && <><td className="num">{money(r.net_revenue)}</td><td className="num">{money(r.vat)}</td></>}
                {acc.cost && <><td className="num">{money(r.base_cost)}</td><td className="num">{money(r.other_expenses)}</td><td className="num">{money(r.total_cost)}</td></>}
                {acc.profit && <><td className="num" style={{ color: Number(r.gross_profit) < 0 ? COLORS.loss : undefined }}>{money(r.gross_profit)}</td>
                  <td className="num">{r.margin_pct == null ? '—' : `${r.margin_pct}%`}</td></>}
              </tr>)}
              {data[tab].length === 0 && <tr><td colSpan={10} className="muted" style={{ padding: 24, textAlign: 'center' }}>No jobs in this period.</td></tr>}
            </tbody>
          </table></div>
        </div>
        <p className="muted small">Jobs counted by required date, {from} to {to}. Drafts and cancelled jobs are excluded. All amounts exclude VAT unless marked.</p>
      </>}
    </div>
  );
}
