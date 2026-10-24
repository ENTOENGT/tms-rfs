'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney, slot } from './api';
import { useMe } from './Shell';

const OPEN = 'draft,requested,pending_assignment';
type Filters = Record<string, string>;

export default function JobList({ mode }: { mode: 'requests' | 'jobs' }) {
  const { me, can, lk } = useMe();
  const fin = me.financial_access;
  const manyDepts = can('jobs.view_all');           // sees every department → show which one each job is from
  const sp = useSearchParams();
  const initial: Filters = { q: sp.get('q') ?? '', status: sp.get('status') ?? (mode === 'requests' ? OPEN : ''),
    action_required: sp.get('action_required') ?? '', sort: 'required_date', dir: 'desc', page: '1' };
  const [f, setF] = useState<Filters>(initial);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setF((x) => ({ ...x, q: sp.get('q') ?? '', page: '1' })); }, [sp]);
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
    const t = setTimeout(() => api(`/api/jobs?${qs}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value, page: '1' });
  const sortBy = (k: string) => setF({ ...f, sort: k, dir: f.sort === k && f.dir === 'desc' ? 'asc' : 'desc' });
  const Th = ({ k, children, num }: { k?: string; children: React.ReactNode; num?: boolean }) => (
    <th className={num ? 'num' : ''}>{k ? <button onClick={() => sortBy(k)}>{children}{f.sort === k ? (f.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button> : children}</th>
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const clear = () => setF({ ...initial, q: '', status: mode === 'requests' ? OPEN : '', action_required: '' });

  return (
    <div className="page">
      <div className="page-head">
        <h1>{mode === 'requests' ? 'Transport requests' : 'Jobs'}</h1>
        <span className="spacer" />
        {can('jobs.create') && <Link className="btn primary" href="/requests/new">New transport request</Link>}
      </div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="grid g4">
          <label className="f"><span>Search</span><input value={f.q} onChange={set('q')} placeholder="Job, BOE, driver, vehicle, customer…" /></label>
          <label className="f"><span>Status</span>
            <select value={f.status} onChange={set('status')}>
              <option value="">All statuses</option>
              {mode === 'requests' && <option value={OPEN}>Open requests</option>}
              {lk.job_statuses.map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select></label>
          {manyDepts && <label className="f"><span>Department</span>
            <select value={f.department_id ?? ''} onChange={set('department_id')}>
              <option value="">All departments</option>
              {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>}
          <label className="f"><span>Customer</span>
            <select value={f.customer_id ?? ''} onChange={set('customer_id')}>
              <option value="">All customers</option>
              {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          <label className="f"><span>Vehicle type</span>
            <select value={f.vehicle_type_id ?? ''} onChange={set('vehicle_type_id')}>
              <option value="">All types</option>
              {lk.vehicle_types.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></label>
          <label className="f"><span>Driver</span>
            <select value={f.driver_id ?? ''} onChange={set('driver_id')}>
              <option value="">All drivers</option>
              {lk.drivers.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
          <label className="f"><span>Vehicle</span>
            <select value={f.vehicle_id ?? ''} onChange={set('vehicle_id')}>
              <option value="">All vehicles</option>
              {lk.vehicles.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></label>
          <label className="f"><span>Required from</span><input type="date" value={f.date_from ?? ''} onChange={set('date_from')} /></label>
          <label className="f"><span>Required to</span><input type="date" value={f.date_to ?? ''} onChange={set('date_to')} /></label>
          <label className="f"><span>BOE number</span><input value={f.boe ?? ''} onChange={set('boe')} /></label>
          <label className="f"><span>POD</span>
            <select value={f.action_required} onChange={set('action_required')}>
              <option value="">Any</option><option value="pod">Delivered, POD missing</option>
            </select></label>
          {fin.sellingView && <>
            <label className="f"><span>Revenue from</span><input type="number" min="0" value={f.revenue_min ?? ''} onChange={set('revenue_min')} /></label>
            <label className="f"><span>Revenue to</span><input type="number" min="0" value={f.revenue_max ?? ''} onChange={set('revenue_max')} /></label>
          </>}
          {fin.profitView && <>
            <label className="f"><span>Profit from</span><input type="number" value={f.profit_min ?? ''} onChange={set('profit_min')} /></label>
            <label className="f"><span>Profit to</span><input type="number" value={f.profit_max ?? ''} onChange={set('profit_max')} /></label>
          </>}
        </div>
        <div style={{ marginTop: 10 }}><button className="btn small" onClick={clear}>Clear filters</button></div>
      </div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush">
        <div className="table-wrap">
          <table className="t">
            <thead><tr>
              <Th k="job_number">Job</Th>{manyDepts && <Th>Department</Th>}<Th k="required_date">Required</Th><Th>Slot</Th><Th k="customer">Customer</Th>
              <Th>BOE</Th><Th>Pickup</Th><Th>Delivery</Th><Th>Vehicle</Th><Th k="driver">Driver</Th><Th k="status">Status</Th>
              {fin.sellingView && <Th k="net_revenue" num>Selling</Th>}
              {fin.buyingView && <Th k="total_cost" num>Cost</Th>}
              {fin.profitView && <Th k="profit" num>Profit</Th>}
              <Th>POD</Th>
            </tr></thead>
            <tbody>
              {data?.rows.map((j: any) => {
                const podMissing = j.status_stage === 'delivered' && ['pending', 'rejected'].includes(j.pod_status);
                return (
                  <tr key={j.id}>
                    <td><Link href={`/jobs/${j.id}`}><b>{j.job_number}</b></Link>{j.priority === 'urgent' && <div className="flag">Urgent</div>}</td>
                    {manyDepts && <td>{j.department_name ?? '—'}</td>}
                    <td>{fmtDate(j.required_date)}</td><td>{slot(j.slot_from, j.slot_to)}</td><td>{j.customer_name}</td>
                    <td>{j.boe_number ?? '—'}</td><td>{j.pickup_name}</td><td>{j.delivery_name}</td>
                    <td>{j.vehicle_number ?? <span className="muted">{j.requested_vehicle_type ?? '—'}</span>}</td>
                    <td>{j.driver_name ?? <span className="muted">Unassigned</span>}</td>
                    <td><span className="badge" style={{ background: j.status_color }}>{j.status_name}</span></td>
                    {fin.sellingView && <td className="num">{fmtMoney(j.financials.commercial?.net_revenue, lk.currency)}</td>}
                    {fin.buyingView && <td className="num">{fmtMoney(j.financials.cost?.total_cost, lk.currency)}</td>}
                    {fin.profitView && <td className="num">{fmtMoney(j.financials.profit?.gross_profit, lk.currency)}</td>}
                    <td>{podMissing ? <span className="flag">Action required</span> : j.pod_status_name}</td>
                  </tr>
                );
              })}
              {data && data.rows.length === 0 && <tr><td colSpan={14} className="muted" style={{ padding: 24, textAlign: 'center' }}>
                No jobs match these filters. {can('jobs.create') && <Link href="/requests/new">Create a transport request</Link>}
              </td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span>{data ? `${data.total} job${data.total === 1 ? '' : 's'}` : 'Loading…'}</span><span className="spacer" />
          <button className="btn small" disabled={f.page === '1'} onClick={() => setF({ ...f, page: String(Number(f.page) - 1) })}>Previous</button>
          <span>Page {f.page} of {pages}</span>
          <button className="btn small" disabled={Number(f.page) >= pages} onClick={() => setF({ ...f, page: String(Number(f.page) + 1) })}>Next</button>
        </div>
      </div>
    </div>
  );
}
