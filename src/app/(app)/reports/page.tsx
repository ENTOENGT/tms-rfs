'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { period, PERIODS } from '@/lib/period';

function Reports() {
  const { me, can, lk } = useMe();
  const sp = useSearchParams();
  const [list, setList] = useState<any[]>([]);
  const [key, setKey] = useState(sp.get('r') ?? '');
  const [pkey, setPkey] = useState('this_month');
  const [custom, setCustom] = useState<[string, string]>(['', '']);
  const [f, setF] = useState<Record<string, string>>({ page: '1' });
  const [data, setData] = useState<any>(null);
  const [printing, setPrinting] = useState<any>(null);
  const [err, setErr] = useState('');
  const [proCfg, setProCfg] = useState<any>(null);
  const [from, to] = pkey === 'custom' ? custom : period(pkey, lk.timezone);
  const isPod = key === 'pod_pending';
  const def = list.find((r) => r.key === key);

  useEffect(() => { if (def?.kind === 'pro' && !proCfg) api('/api/pro/config').then(setProCfg).catch(() => {}); }, [def?.kind]);
  useEffect(() => { api('/api/reports').then((l) => { setList(l); if (!key && l[0]) setKey(l[0].key); }).catch((e) => setErr(e.message)); }, []);
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams(Object.entries({
    ...(isPod ? {} : { from, to }), ...f, ...extra }).filter(([, v]) => v)).toString();
  useEffect(() => {
    if (!key || (!isPod && (!from || !to))) return;
    setData(null);
    const t = setTimeout(() => api(`/api/reports/${key}?${qs()}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [key, from, to, f]);

  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const sortBy = (k: string) => setF({ ...f, sort: k, dir: f.sort === k && f.dir === 'desc' ? 'asc' : 'desc', page: '1' });
  const cur = lk.currency;
  const fmt = (c: any, v: any) => {
    if (v == null || v === '') return '—';
    switch (c.type) {
      case 'money': return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'pct': return `${v}%`;
      case 'date': return fmtDate(v);
      case 'datetime': return fmtDateTime(v);
      default: return String(v);
    }
  };
  const print = async () => {
    try {
      const all = await api(`/api/reports/${key}?${qs({ all: '1', page: '' })}`);
      setPrinting(all);
      setTimeout(() => { window.print(); setPrinting(null); }, 300);
    } catch (e: any) { setErr(e.message); }
  };
  const shown = printing ?? data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const numeric = (c: any) => ['money', 'pct', 'int'].includes(c.type);

  if (!can('reports.view')) return <div className="page"><div className="msg err">You don't have access to reports.</div></div>;
  return (
    <div className="page">
      <div className="print-only print-head">
        <img src="/brand/logo.png" alt="Reliance Freight Systems LLC" width={220} height={53} />
        <div><b>{def?.title}</b><br />{isPod ? 'All outstanding PODs' : `Period: ${fmtDate(from)} – ${fmtDate(to)}`}<br />
          <span className="muted">Generated {new Date().toLocaleString('en-GB')} by {me.full_name}</span></div>
      </div>

      <div className="page-head no-print"><h1>Reports</h1></div>
      <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {list.map((r) => <button key={r.key} className={`btn${r.key === key ? ' primary' : ''}`} title={r.description}
          onClick={() => { setKey(r.key); setF({ page: '1' }); }}>{r.title.replace(' report', '').replace(' Report', '')}</button>)}
      </div>
      {def && <p className="muted small no-print" style={{ marginTop: 0 }}>{def.description}</p>}

      <div className="panel no-print" style={{ marginBottom: 12 }}>
        <div className="grid g4">
          {!isPod && <label className="f"><span>Period</span>
            <select value={pkey} onChange={(e) => setPkey(e.target.value)}>{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
          {!isPod && pkey === 'custom' && <>
            <label className="f"><span>From</span><input type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} /></label>
            <label className="f"><span>To</span><input type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} /></label>
          </>}
          <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder={def?.kind === 'group' ? 'Name…' : 'Job No., BOE, driver, vehicle, customer…'} /></label>
          {def?.kind === 'pro' && <>
            <label className="f"><span>Job No.</span><input value={f.job_no ?? ''} onChange={set('job_no')} /></label>
            <label className="f"><span>Container</span><input value={f.container ?? ''} onChange={set('container')} /></label>
            <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
              {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="f"><span>Authority</span><select value={f.authority_id ?? ''} onChange={set('authority_id')}><option value="">All</option>
              {proCfg?.authorities.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <label className="f"><span>PRO officer</span><select value={f.assigned_to ?? ''} onChange={set('assigned_to')}><option value="">All</option>
              {lk.users.filter((u: any) => u.department === 'pro').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <label className="f"><span>Port / terminal / free zone</span><input value={f.port ?? ''} onChange={set('port')} /></label>
            <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
              {proCfg?.statuses.map((x: any) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></label>
            <label className="f"><span>Priority</span><select value={f.priority ?? ''} onChange={set('priority')}><option value="">All</option>
              <option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option></select></label>
            {key === 'pro_charges' && <label className="f"><span>Payment</span><select value={f.payment_status ?? ''} onChange={set('payment_status')}><option value="">All</option>
              <option value="unpaid">Unpaid</option><option value="paid">Paid</option><option value="waived">Waived</option></select></label>}
          </>}
          {def?.kind === 'messenger' && <>
            <label className="f"><span>Type</span><select value={f.type ?? ''} onChange={set('type')}><option value="">Truck jobs and messenger runs</option>
              <option value="jobs">Truck jobs only</option><option value="runs">Messenger runs only</option></select></label>
            <label className="f"><span>Job No.</span><input value={f.job_no ?? ''} onChange={set('job_no')} /></label>
            <label className="f"><span>Request / Run No.</span><input value={f.request_no ?? ''} onChange={set('request_no')} placeholder="TR-… or MR-…" /></label>
            <label className="f"><span>Requester</span><select value={f.requested_by ?? ''} onChange={set('requested_by')}><option value="">All</option>
              {lk.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            {lk.departments.filter((d: any) => d.side === 'operations').length > 1 && (can('jobs.view_all') || can('runs.view_all')) &&
              <label className="f"><span>Department</span><select value={f.department_id ?? ''} onChange={set('department_id')}><option value="">All</option>
                {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
            <label className="f"><span>Assigned by (Transport)</span><select value={f.assigned_by ?? ''} onChange={set('assigned_by')}><option value="">All</option>
              {lk.users.filter((u: any) => ['transport', 'messengers'].includes(u.department)).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <label className="f"><span>Vehicle</span><select value={f.vehicle_id ?? ''} onChange={set('vehicle_id')}><option value="">All</option>
              {lk.vehicles.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
            <label className="f"><span>Driver</span><select value={f.driver_id ?? ''} onChange={set('driver_id')}><option value="">All</option>
              {lk.drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label className="f"><span>Messenger</span><select value={f.messenger_id ?? ''} onChange={set('messenger_id')}><option value="">All</option>
              {lk.users.filter((u: any) => u.department === 'messengers').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <label className="f"><span>Delivery location</span><input value={f.delivery ?? ''} onChange={set('delivery')} placeholder="Place or address" /></label>
            <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
              <option value="open">Not delivered yet</option><option value="delivered">Delivered</option>
              <option value="failed">Could not complete (runs)</option><option value="cancelled">Cancelled</option></select></label>
          </>}
          {def?.kind === 'jobs' && <>
            {can('jobs.view_all') && <label className="f"><span>Department</span><select value={f.department_id ?? ''} onChange={set('department_id')}><option value="">All</option>
              {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
            <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
              {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="f"><span>Driver</span><select value={f.driver_id ?? ''} onChange={set('driver_id')}><option value="">All</option>
              {lk.drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            <label className="f"><span>Vehicle</span><select value={f.vehicle_id ?? ''} onChange={set('vehicle_id')}><option value="">All</option>
              {lk.vehicles.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
            {!isPod && <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
              {lk.job_statuses.map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>}
          </>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn small" onClick={() => setF({ page: '1' })}>Clear filters</button>
          <span style={{ flex: 1 }} />
          {can('reports.export') && data && <>
            <a className="btn" href={`/api/reports/${key}?${qs({ format: 'xlsx', page: '' })}`}>Export Excel</a>
            <a className="btn" href={`/api/reports/${key}?${qs({ format: 'csv', page: '' })}`}>Export CSV</a>
          </>}
          {data && <button className="btn" onClick={print}>Print / PDF</button>}
        </div>
      </div>

      {err && <div className="msg err">{err}</div>}
      {!shown && !err && key && <p className="muted">Loading…</p>}
      {shown && <div className="panel flush report">
        <div className="table-wrap"><table className="t">
          <thead><tr>{shown.columns.map((c: any) => <th key={c.key} className={numeric(c) ? 'num' : ''}>
            {c.sortable ? <button onClick={() => sortBy(c.key)}>{c.label}{f.sort === c.key ? (f.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button> : c.label}
            {c.type === 'money' && <span className="muted small"> {cur}</span>}</th>)}</tr></thead>
          <tbody>
            {shown.rows.map((r: any, i: number) => <tr key={i}>{shown.columns.map((c: any, k: number) => <td key={c.key} className={numeric(c) ? 'num' : ''}
              style={c.key === 'gross_profit' && Number(r[c.key]) < 0 ? { color: 'var(--danger)' } : undefined}>
              {(k === 0 && shown.report.kind === 'jobs') || (c.key === 'job_no' && shown.report.kind === 'messenger') ? <b>{r[c.key] ?? '—'}</b> : fmt(c, r[c.key])}</td>)}</tr>)}
            {shown.rows.length === 0 && <tr><td colSpan={shown.columns.length} className="muted" style={{ padding: 24, textAlign: 'center' }}>
              {isPod ? 'No PODs outstanding. 🎉' : 'Nothing matches these filters.'}</td></tr>}
          </tbody>
          {shown.totals && shown.rows.length > 0 && <tfoot><tr>{shown.columns.map((c: any, k: number) => <td key={c.key} className={numeric(c) ? 'num' : ''}
            style={{ fontWeight: 600, borderTop: '2px solid var(--line)' }}>{k === 0 ? 'Total' : shown.totals[c.key] == null ? '' : fmt(c, shown.totals[c.key])}</td>)}</tr></tfoot>}
        </table></div>
        {!printing && shown.report.kind !== 'group' && <div className="pager no-print">
          <span>{data.total} row{data.total === 1 ? '' : 's'}{data.totals ? ' · totals cover all rows' : ''}
            {data.summary && <> · {data.summary.truck_jobs} truck job{data.summary.truck_jobs === 1 ? '' : 's'}, {data.summary.messenger_runs} messenger run{data.summary.messenger_runs === 1 ? '' : 's'} · {data.summary.delivered} delivered, {data.summary.open} not delivered yet</>}</span><span className="spacer" />
          <button className="btn small" disabled={f.page === '1'} onClick={() => setF({ ...f, page: String(Number(f.page) - 1) })}>Previous</button>
          <span>Page {f.page} of {pages}</span>
          <button className="btn small" disabled={Number(f.page) >= pages} onClick={() => setF({ ...f, page: String(Number(f.page) + 1) })}>Next</button>
        </div>}
      </div>}
      {isPod && shown && shown.rows.length > 0 && <p className="muted small no-print">Open a job from the <Link href="/jobs?action_required=pod">Jobs list</Link> to upload its POD.</p>}
    </div>
  );
}
export default function ReportsPage() { return <Suspense><Reports /></Suspense>; }
