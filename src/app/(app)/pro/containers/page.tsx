'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';

/** Every container on its own line: where it stands with Customs, inspection and release. Updated by PRO by hand. */
export default function Containers() {
  const { can, lk } = useMe();
  const [f, setF] = useState<Record<string, string>>({ view: 'open' });
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const t = setTimeout(() => api(`/api/pro?containers=1&${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`)
      .then((d) => { setRows(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const seePay = can('pro.charges.view');
  return (
    <div className="page">
      <div className="page-head"><h1>Containers — clearance and release</h1><span className="spacer" /><Link className="btn" href="/pro">Back to PRO</Link></div>
      <p className="muted small" style={{ marginTop: -6 }}>Manual updates by PRO with official proof attached — there is no live link to Customs or port systems.</p>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Show</span><select value={f.view} onChange={set('view')}><option value="open">Open requests</option><option value="">All</option>
          <option value="cleared_awaiting_release">Customs cleared, awaiting release</option><option value="released">Released</option><option value="overdue">Overdue</option></select></label>
        <label className="f"><span>Container</span><input value={f.container ?? ''} onChange={set('container')} /></label>
        <label className="f"><span>Job No.</span><input value={f.job_no ?? ''} onChange={set('job_no')} /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Container</th><th>Job No.</th><th>PRO no.</th><th>BL</th><th>Customer</th><th>Port / zone</th><th>PRO officer</th><th>Stage</th>
          <th>Pending authority</th><th>Pending documents</th><th>Inspection</th><th>Outstanding actions</th>{seePay && <th>Payment</th>}
          <th>Customs cleared</th><th>Released</th><th>Overall</th><th>Delay</th></tr></thead>
        <tbody>{rows?.map((k) => <tr key={k.id}>
          <td><b>{k.container_no}</b><div className="muted small">{k.size_type}</div></td>
          <td><Link href={`/pro/${k.request_id}`}><b>{k.job_no}</b></Link></td><td>{k.request_no}</td><td>{k.bl_number}</td><td>{k.customer_name}</td>
          <td>{k.uae_location}</td><td>{k.assigned_to_name ?? '—'}</td><td>{k.stage}</td>
          <td className="small">{k.pending_authority ?? '—'}</td><td className="small">{k.pending_documents ?? '—'}</td><td>{k.inspection_label}</td>
          <td className="small">{k.outstanding_actions ?? '—'}</td>{seePay && <td>{k.payment_status ?? '—'}</td>}
          <td>{k.customs_cleared_at ? fmtDateTime(k.customs_cleared_at) : '—'}</td><td>{k.released_at ? fmtDateTime(k.released_at) : '—'}</td>
          <td>{k.overall}</td>
          <td>{k.delayed ? <span className="flag">Late (deadline {fmtDate(k.deadline)})</span> : '—'}{k.delay_reason && <div className="small">{k.delay_reason}</div>}</td>
        </tr>)}
          {rows && rows.length === 0 && <tr><td colSpan={17} className="muted" style={{ padding: 24, textAlign: 'center' }}>No containers here.</td></tr>}
        </tbody></table></div>
        <div className="pager"><span>{rows ? `${rows.length} container${rows.length === 1 ? '' : 's'}` : 'Loading…'}</span></div></div>
    </div>
  );
}
