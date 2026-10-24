'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate } from '@/components/api';
import { useMe } from '@/components/Shell';
import { RUN_COLOR } from '@/components/RunForm';

const STATUSES: [string, string][] = [['pending', 'Waiting for a messenger'], ['assigned', 'Assigned'], ['collected', 'Collected'],
  ['delivered', 'Delivered'], ['failed', 'Could not complete'], ['cancelled', 'Cancelled']];
const slot = (a?: string | null, b?: string | null) => (a ? `${a.slice(0, 5)}${b ? '–' + b.slice(0, 5) : ''}` : '');

/** A messenger's own list: big, simple cards that work on a phone. */
function MyRuns() {
  const [data, setData] = useState<any>(null);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => { api(`/api/runs?mine=1${showDone ? '' : '&open=1'}&page_size=100`).then(setData); }, [showDone]);
  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="page-head"><h1>My runs</h1><span className="spacer" />
        <button className="btn small" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide finished' : 'Show finished'}</button></div>
      {!data && <p className="muted">Loading…</p>}
      {data?.rows.length === 0 && <div className="panel"><p style={{ margin: 0 }}>Nothing assigned to you right now.</p></div>}
      {data?.rows.map((r: any) => (
        <Link key={r.id} href={`/runs/${r.id}`} className="panel" style={{ display: 'block', color: 'inherit', textDecoration: 'none', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b style={{ fontSize: 16 }}>{r.run_number}</b>
            <span className="badge" style={{ background: RUN_COLOR[r.status] }}>{r.status_name}</span>
            {r.priority === 'urgent' && <span className="flag">Urgent</span>}
            <span style={{ marginLeft: 'auto' }} className="muted small">{fmtDate(r.required_date)} {slot(r.slot_from, r.slot_to)}</span>
          </div>
          <div style={{ marginTop: 8 }}><b>{r.task_name}:</b> {r.documents}</div>
          <div className="small" style={{ marginTop: 4 }}>From <b>{r.from_name}</b>{r.to_name && <> → to <b>{r.to_name}</b></>}</div>
        </Link>
      ))}
    </div>
  );
}

export default function Runs() {
  const { can, lk } = useMe();
  const messengerOnly = !can('runs.view_all') && !can('runs.view_department') && can('runs.update_status');
  const [f, setF] = useState<Record<string, string>>({ open: '1', page: '1' });
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [messengers, setMessengers] = useState<any[]>([]);
  useEffect(() => { if (can('runs.assign')) api('/api/messengers').then(setMessengers).catch(() => {}); }, []);
  useEffect(() => {
    if (messengerOnly) return;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const t = setTimeout(() => api(`/api/runs?${qs}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);
  if (messengerOnly) return <MyRuns />;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div className="page">
      <div className="page-head"><h1>Messenger runs</h1><span className="spacer" />
        {can('runs.create') && <Link className="btn primary" href="/runs/new">Request a messenger</Link>}</div>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Run no., BL/BOE, documents, place, messenger…" /></label>
        <label className="f"><span>Status</span><select value={f.open ? 'open' : f.status ?? ''} onChange={(e) => setF({ ...f, open: e.target.value === 'open' ? '1' : '',
          status: e.target.value === 'open' ? '' : e.target.value, page: '1' })}>
          <option value="open">Open runs</option><option value="">All</option>
          {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="f"><span>Date from</span><input type="date" value={f.date_from ?? ''} onChange={set('date_from')} /></label>
        <label className="f"><span>Date to</span><input type="date" value={f.date_to ?? ''} onChange={set('date_to')} /></label>
        {can('runs.view_all') && <label className="f"><span>Department</span><select value={f.department_id ?? ''} onChange={set('department_id')}>
          <option value="">All</option>{lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
        {messengers.length > 0 && <label className="f"><span>Messenger</span><select value={f.messenger_id ?? ''} onChange={set('messenger_id')}>
          <option value="">All</option>{messengers.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>}
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Run</th>{can('runs.view_all') && <th>Department</th>}<th>Date</th><th>Task</th><th>Documents</th><th>From</th><th>To</th><th>Messenger</th><th>Status</th></tr></thead>
        <tbody>
          {data?.rows.map((r: any) => <tr key={r.id}>
            <td><Link href={`/runs/${r.id}`}><b>{r.run_number}</b></Link>{r.priority === 'urgent' && <div className="flag">Urgent</div>}</td>
            {can('runs.view_all') && <td>{r.department_name ?? '—'}</td>}
            <td>{fmtDate(r.required_date)}<div className="muted small">{slot(r.slot_from, r.slot_to)}</div></td>
            <td>{r.task_name}</td><td>{r.documents}{r.reference && <div className="muted small">{r.reference}</div>}</td>
            <td>{r.from_name}</td><td>{r.to_name ?? '—'}</td>
            <td>{r.messenger_name ?? <span className="muted">Not assigned</span>}</td>
            <td><span className="badge" style={{ background: RUN_COLOR[r.status] }}>{r.status_name}</span></td>
          </tr>)}
          {data && data.rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 24, textAlign: 'center' }}>
            No runs here. {can('runs.create') && <Link href="/runs/new">Request a messenger</Link>}</td></tr>}
        </tbody></table></div>
        <div className="pager"><span>{data ? `${data.total} run${data.total === 1 ? '' : 's'}` : 'Loading…'}</span><span className="spacer" />
          <button className="btn small" disabled={f.page === '1'} onClick={() => setF({ ...f, page: String(Number(f.page) - 1) })}>Previous</button>
          <span>Page {f.page} of {pages}</span>
          <button className="btn small" disabled={Number(f.page) >= pages} onClick={() => setF({ ...f, page: String(Number(f.page) + 1) })}>Next</button></div>
      </div>
    </div>
  );
}
