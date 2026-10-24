'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { fmtSize } from '@/components/JobFiles';
import { useMe } from '@/components/Shell';

export default function Documents() {
  const [f, setF] = useState<Record<string, string>>({ q: '', type: '', date_from: '', date_to: '', page: '1' });
  const { lk } = useMe();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const t = setTimeout(() => api(`/api/documents?${qs}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div className="page">
      <div className="page-head"><h1>Documents</h1></div>
      <p className="muted small" style={{ marginTop: -6 }}>Every file uploaded to a job. To add a document, open the job and use its Documents tab.</p>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q} onChange={set('q')} placeholder="File name, job, BOE, customer" /></label>
        <label className="f"><span>Type</span><select value={f.type} onChange={set('type')}><option value="">All types</option>
          {lk.document_types.map((t: any) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></label>
        <label className="f"><span>Uploaded from</span><input type="date" value={f.date_from} onChange={set('date_from')} /></label>
        <label className="f"><span>Uploaded to</span><input type="date" value={f.date_to} onChange={set('date_to')} /></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>File</th><th>Type</th><th>Job</th><th>Customer</th><th>BOE</th><th>Size</th><th>Uploaded</th></tr></thead>
        <tbody>
          {data?.rows.map((d: any) => <tr key={d.id}>
            <td><a href={`/api/documents/${d.id}/download`} target="_blank" rel="noopener">{d.file_name}</a></td>
            <td>{d.document_type}</td><td><Link href={`/jobs/${d.job_id}`}><b>{d.job_number}</b></Link></td>
            <td>{d.customer_name}</td><td>{d.boe_number ?? '—'}</td><td>{fmtSize(d.size_bytes)}</td>
            <td>{d.uploaded_by_name ?? '—'} <span className="muted small">· {fmtDateTime(d.created_at)}</span></td>
          </tr>)}
          {data && data.rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 24, textAlign: 'center' }}>No documents found.</td></tr>}
        </tbody>
      </table></div>
        <div className="pager"><span>{data ? `${data.total} document${data.total === 1 ? '' : 's'}` : 'Loading…'}</span><span className="spacer" />
          <button className="btn small" disabled={f.page === '1'} onClick={() => setF({ ...f, page: String(Number(f.page) - 1) })}>Previous</button>
          <span>Page {f.page} of {pages}</span>
          <button className="btn small" disabled={Number(f.page) >= pages} onClick={() => setF({ ...f, page: String(Number(f.page) + 1) })}>Next</button></div>
      </div>
    </div>
  );
}
