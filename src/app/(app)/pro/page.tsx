'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate } from '@/components/api';
import { useMe } from '@/components/Shell';
import { PriorityFlag } from '@/components/ProShared';

/** PRO officer on the phone: their own open work as big cards. */
function MyWork() {
  const [done, setDone] = useState(false);
  const [data, setData] = useState<any>(null);
  useEffect(() => { setData(null); api(`/api/pro?mine=1&${done ? 'view=completed' : 'view=open'}&page_size=100`).then(setData); }, [done]);
  return (
    <div className="app-page">
      <div className="app-tabs">
        <button className={done ? '' : 'on'} onClick={() => setDone(false)}>To do</button>
        <button className={done ? 'on' : ''} onClick={() => setDone(true)}>Completed</button>
      </div>
      {!data && <p className="muted">Loading…</p>}
      {data?.rows.length === 0 && <div className="panel"><p style={{ margin: 0 }}>{done ? 'Nothing completed yet.' : 'No PRO work for you right now.'}</p></div>}
      {data?.rows.map((r: any) => (
        <Link key={r.id} href={`/pro/${r.id}`} className="app-card">
          <div className="app-card-head"><b>{r.job_no}</b><span className="badge" style={{ background: r.status_color }}>{r.status_name}</span>
            <PriorityFlag p={r.priority} />{r.overdue && <span className="flag">Overdue</span>}</div>
          <div className="app-when">{r.request_no} · deadline {fmtDate(r.deadline)}</div>
          <div className="app-route"><span>Where</span><b>{r.uae_location}</b></div>
          <div className="app-route"><span>Boxes</span><b>{r.container_list ?? '—'}</b></div>
          {r.pending_authorities && <div className="app-next">Pending: {r.pending_authorities} ›</div>}
        </Link>
      ))}
    </div>
  );
}

function Pro() {
  const { me, can, lk } = useMe();
  const sp = useSearchParams();
  const [f, setF] = useState<Record<string, string>>(() => ({ view: sp.get('view') ?? 'open', page: '1' }));
  const [tiles, setTiles] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [err, setErr] = useState('');
  const officerOnly = me.app_only;
  useEffect(() => { if (!officerOnly) api('/api/pro/config').then(setCfg).catch(() => {}); }, []);
  useEffect(() => {
    if (officerOnly) return;
    const { view, page, ...rest } = f;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const t = setTimeout(() => {
      api(`/api/pro?${qs}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
      api(`/api/pro?dashboard=1&${new URLSearchParams(Object.entries(rest).filter(([, v]) => v))}`).then((d) => setTiles(d.tiles)).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [f]);
  if (officerOnly) return <MyWork />;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div className="page">
      <div className="page-head"><h1>PRO clearance</h1><span className="spacer" />
        <Link className="btn" href="/pro/containers">Containers</Link>
        {(can('pro.configure') || me.role_code === 'super_admin') && <Link className="btn" href="/pro/settings">Settings</Link>}
        {can('pro.create') && <Link className="btn primary" href="/pro/new">New PRO request</Link>}</div>
      <p className="muted small" style={{ marginTop: -6 }}>Clearance with Customs, ports, municipalities and free zones. Messenger runs (carrying documents) are separate.
        No government system is connected — PRO updates are entered by hand with the official proof attached.</p>
      <div className="kpis pro-tiles">
        {tiles.map((t) => <button key={t.key} className={`kpi${f.view === t.key ? ' on' : ''}`} onClick={() => setF({ ...f, view: f.view === t.key ? '' : t.key, page: '1' })}>
          <span className="kpi-n">{t.count}</span><span className="kpi-l">{t.label}{t.unit === 'containers' ? ' (containers)' : ''}</span></button>)}
      </div>
      <div className="panel" style={{ margin: '12px 0' }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Job No., PRO no., BL, container, vessel…" /></label>
        <label className="f"><span>Job No.</span><input value={f.job_no ?? ''} onChange={set('job_no')} /></label>
        <label className="f"><span>Container</span><input value={f.container ?? ''} onChange={set('container')} placeholder="e.g. MSCU1234566" /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Authority</span><select value={f.authority_id ?? ''} onChange={set('authority_id')}><option value="">All</option>
          {cfg?.authorities.filter((a: any) => a.is_active).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="f"><span>PRO officer</span><select value={f.assigned_to ?? ''} onChange={set('assigned_to')}><option value="">All</option>
          {lk.users.filter((u: any) => u.department === 'pro').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="f"><span>Port / terminal / free zone</span><input value={f.port ?? ''} onChange={set('port')} /></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
          {cfg?.statuses.filter((s: any) => s.is_active).map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
        <label className="f"><span>Priority</span><select value={f.priority ?? ''} onChange={set('priority')}><option value="">All</option>
          <option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option></select></label>
        <label className="f"><span>Requested from</span><input type="date" value={f.date_from ?? ''} onChange={set('date_from')} /></label>
        <label className="f"><span>Requested to</span><input type="date" value={f.date_to ?? ''} onChange={set('date_to')} /></label>
      </div>
        <div style={{ marginTop: 10 }}><button className="btn small" onClick={() => setF({ view: '', page: '1' })}>Clear filters</button>
          {f.view && <span className="muted small" style={{ marginLeft: 10 }}>Showing: <b>{tiles.find((t) => t.key === f.view)?.label}</b></span>}</div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Job No.</th><th>PRO no.</th><th>Customer</th><th>Containers</th><th>BL</th><th>Port / zone</th><th>Pending authority</th><th>PRO officer</th><th>Deadline</th><th>Status</th></tr></thead>
        <tbody>
          {data?.rows.map((r: any) => <tr key={r.id}>
            <td><Link href={`/pro/${r.id}`}><b>{r.job_no}</b></Link> <PriorityFlag p={r.priority} /></td>
            <td>{r.request_no}{r.department_name && <div className="muted small">{r.department_name}</div>}</td>
            <td>{r.customer_name}</td>
            <td className="small">{r.container_list ?? '—'}{r.containers > 0 && <div className="muted">{r.containers_released}/{r.containers} released</div>}</td>
            <td>{r.bl_number}</td><td>{r.uae_location}</td>
            <td className="small">{r.pending_authorities ?? '—'}</td>
            <td>{r.assigned_to_name ?? <span className="flag">Not assigned</span>}</td>
            <td>{fmtDate(r.deadline)}{r.overdue && <div className="flag">Overdue</div>}</td>
            <td><span className="badge" style={{ background: r.status_color }}>{r.status_name}</span></td>
          </tr>)}
          {data && data.rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ padding: 24, textAlign: 'center' }}>No PRO requests here.</td></tr>}
        </tbody></table></div>
        <div className="pager"><span>{data ? `${data.total} request${data.total === 1 ? '' : 's'}` : 'Loading…'}</span><span className="spacer" />
          <button className="btn small" disabled={f.page === '1'} onClick={() => setF({ ...f, page: String(Number(f.page) - 1) })}>Previous</button>
          <span>Page {f.page} of {pages}</span>
          <button className="btn small" disabled={Number(f.page) >= pages} onClick={() => setF({ ...f, page: String(Number(f.page) + 1) })}>Next</button></div>
      </div>
    </div>
  );
}
export default function ProPage() { return <Suspense><Pro /></Suspense>; }
