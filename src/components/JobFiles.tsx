'use client';
import { useState } from 'react';
import { api, fmtDate, fmtDateTime } from './api';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.xlsx,.docx';
const POD_ACCEPT = '.pdf,.jpg,.jpeg,.png';
const MAX = 10 * 1024 * 1024;
export const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Phone photos are often 4–8 MB. Shrink big photos to max 2000px before upload (keeps them readable, saves storage). */
async function shrinkImage(file: File): Promise<File> {
  if (!/^image\/(jpeg|png)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.(png|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

export async function uploadOne(jobId: string, original: File, type: string, extra: Record<string, unknown> = {}) {
  const file = await shrinkImage(original);
  const mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
  if (file.size > MAX) throw new Error(`${file.name} is larger than 10 MB`);
  const r = await api(`/api/jobs/${jobId}/documents/upload-url`, { body: { file_name: file.name, mime_type: mime, size: file.size, document_type_code: type } });
  const put = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: file });
  if (!put.ok) throw new Error(`Upload of ${file.name} failed (${put.status}). Please try again.`);
  return api(`/api/jobs/${jobId}/documents`, { body: { ticket: r.ticket, ...extra } });
}

export function UploadDialog({ job, podOnly, onDone, onClose }: { job: any; podOnly?: boolean; onDone: (j: any) => void; onClose: () => void }) {
  const types = job.permissions.upload_types as { code: string; name: string }[];
  const [type, setType] = useState(podOnly ? 'pod' : types.find((t) => t.code !== 'pod')?.code ?? types[0]?.code ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [pod, setPod] = useState({ received_by: '', pod_date: job.actual_delivery_at ? job.actual_delivery_at.slice(0, 10) : '', remarks: '' });
  const [progress, setProgress] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isPod = type === 'pod';
  const go = async () => {
    setBusy(true); setErr(''); setProgress([]);
    let last: any = null;
    for (const [i, f] of files.entries()) {
      setProgress((p) => [...p, `Uploading ${f.name}…`]);
      try {
        const r = await uploadOne(job.id, f, type, isPod && i === 0 ? pod : {});
        last = r.job;
        setProgress((p) => p.map((x, n) => (n === i ? `✓ ${f.name}` : x)));
      } catch (e: any) {
        setErr(e.message); setBusy(false);
        if (last) onDone(last);
        return;
      }
    }
    onDone(last);
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-label={isPod ? 'Upload POD' : 'Upload document'}>
        <h2>{isPod ? `Upload POD — ${job.job_number}` : `Upload document — ${job.job_number}`}</h2>
        {err && <div className="msg err">{err}</div>}
        <div className="grid g2">
          {!podOnly && <label className="f span2"><span>Document type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>{types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></label>}
          <label className="f span2"><span>File{isPod ? 's (several pages or photos are fine)' : 's'}</span>
            <input type="file" multiple accept={isPod ? POD_ACCEPT : ACCEPT} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            <span className="muted small" style={{ fontWeight: 400, marginTop: 4 }}>
              {isPod ? 'PDF, JPG or PNG' : 'PDF, JPG, PNG, Excel or Word'} · up to 10 MB each · large photos are shrunk automatically</span></label>
          {isPod && <>
            <label className="f"><span>Received by</span><input value={pod.received_by} onChange={(e) => setPod({ ...pod, received_by: e.target.value })} placeholder="Name on the POD" /></label>
            <label className="f"><span>POD date</span><input type="date" value={pod.pod_date} onChange={(e) => setPod({ ...pod, pod_date: e.target.value })} /></label>
            <label className="f span2"><span>Remarks</span><input value={pod.remarks} onChange={(e) => setPod({ ...pod, remarks: e.target.value })} placeholder="e.g. 2 cartons damaged, noted on POD" /></label>
          </>}
        </div>
        {progress.length > 0 && <ul className="small" style={{ paddingLeft: 18 }}>{progress.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        <div className="actions"><button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !files.length || !type} onClick={go}>
            {busy ? 'Uploading…' : `Upload${files.length > 1 ? ` ${files.length} files` : ''}`}</button></div>
      </div>
    </div>
  );
}

const POD_LABEL: Record<string, [string, string]> = {
  not_required: ['Not required', '#6B7280'], pending: ['Waiting for POD', '#B7791F'], uploaded: ['Uploaded — awaiting check', '#2B6CB0'],
  verified: ['Verified', '#276749'], rejected: ['Rejected — re-upload needed', '#9B2C2C'],
};

export function PodCard({ job, onChange }: { job: any; onChange: (j: any) => void }) {
  const [dialog, setDialog] = useState<'upload' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const delivered = ['delivered', 'closed'].includes(job.status_stage) || job.actual_delivery_at;
  if (!delivered && job.pod_status === 'pending' && !job.pod) return null;
  const [label, color] = POD_LABEL[job.pod_status] ?? [job.pod_status, '#6B7280'];
  const pods = job.documents.filter((d: any) => d.document_type_code === 'pod');
  const canUpload = job.permissions.upload_types.some((t: any) => t.code === 'pod') && job.permissions.upload_documents && job.pod_status !== 'verified';
  const review = async (action: 'verify' | 'reject') => {
    try { onChange(await api(`/api/jobs/${job.id}/pod`, { body: { action, reason } })); setDialog(null); setReason(''); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><h2 style={{ flex: 1, margin: 0 }}>Proof of delivery</h2>
        <span className="badge" style={{ background: color }}>{label}</span></div>
      {err && <div className="msg err" style={{ marginTop: 10 }}>{err}</div>}
      {job.pod?.rejection_reason && job.pod_status === 'rejected' && <div className="msg err" style={{ marginTop: 10 }}>Rejected: {job.pod.rejection_reason}</div>}
      {job.pod && job.pod_status !== 'pending' && (
        <dl className="kv" style={{ marginTop: 12, gridTemplateColumns: '110px 1fr' }}>
          <dt>Received by</dt><dd>{job.pod.received_by || '—'}</dd>
          <dt>POD date</dt><dd>{fmtDate(job.pod.pod_date)}</dd>
          {job.pod.remarks && <><dt>Remarks</dt><dd>{job.pod.remarks}</dd></>}
          {job.pod.verified_by_name && <><dt>Verified</dt><dd>{job.pod.verified_by_name}, {fmtDateTime(job.pod.verified_at)}</dd></>}
        </dl>
      )}
      {pods.length > 0 && <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', fontSize: 13 }}>
        {pods.map((d: any) => <li key={d.id} style={{ padding: '3px 0' }}>
          <a href={`/api/documents/${d.id}/download`} target="_blank" rel="noopener">{d.file_name}</a> <span className="muted small">{fmtSize(d.size_bytes)}</span></li>)}
      </ul>}
      {job.pod_status === 'pending' && pods.length === 0 && <p className="muted small" style={{ margin: '10px 0 0' }}>No POD uploaded yet.</p>}
      {(canUpload || job.permissions.verify_pod) && <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {canUpload && <button className={`btn${['pending', 'rejected'].includes(job.pod_status) ? ' primary' : ''}`} onClick={() => setDialog('upload')}>
          {pods.length ? 'Add POD page' : 'Upload POD'}</button>}
        {job.permissions.verify_pod && job.pod_status === 'uploaded' && <button className="btn primary" onClick={() => review('verify')}>Verify POD</button>}
        {job.permissions.verify_pod && <button className="btn danger" onClick={() => setDialog('reject')}>Reject</button>}
      </div>}
      {dialog === 'upload' && <UploadDialog job={job} podOnly onClose={() => setDialog(null)} onDone={(j) => { setDialog(null); if (j) onChange(j); }} />}
      {dialog === 'reject' && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setDialog(null)}>
          <div className="modal" role="dialog" aria-label="Reject POD">
            <h2>Reject POD — {job.job_number}</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Transport is notified and asked to upload a corrected POD.</p>
            <label className="f"><span>What is wrong? <em>*</em></span><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. No stamp / signature, wrong job" /></label>
            <div className="actions"><button className="btn" onClick={() => setDialog(null)}>Back</button>
              <button className="btn danger" onClick={() => review('reject')}>Reject POD</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

export function DocumentsTab({ job, onChange }: { job: any; onChange: (j: any) => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const remove = async (d: any) => {
    if (!confirm(`Remove ${d.file_name}? It stays in the job history.`)) return;
    try { await api(`/api/documents/${d.id}`, { method: 'DELETE' }); onChange(await api(`/api/jobs/${job.id}`)); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="panel flush">
      <div className="page-head" style={{ padding: '12px 16px 0', marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Documents</h2><span className="spacer" />
        {job.permissions.upload_documents && job.permissions.upload_types.length > 0 && <button className="btn primary" onClick={() => setOpen(true)}>Upload document</button>}
      </div>
      {err && <div className="msg err" style={{ margin: '0 16px 8px' }}>{err}</div>}
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Type</th><th>File</th><th>Size</th><th>Uploaded</th><th /></tr></thead>
        <tbody>
          {job.documents.map((d: any) => <tr key={d.id}>
            <td>{d.document_type}</td>
            <td><a href={`/api/documents/${d.id}/download`} target="_blank" rel="noopener">{d.file_name}</a></td>
            <td>{fmtSize(d.size_bytes)}</td>
            <td>{d.uploaded_by_name ?? '—'} <span className="muted small">· {fmtDateTime(d.created_at)}</span></td>
            <td style={{ textAlign: 'right' }}>{d.can_delete && <button className="btn small danger" onClick={() => remove(d)}>Remove</button>}</td>
          </tr>)}
          {job.documents.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 20, textAlign: 'center' }}>No documents yet.</td></tr>}
        </tbody>
      </table></div>
      {open && <UploadDialog job={job} onClose={() => setOpen(false)} onDone={(j) => { setOpen(false); if (j) onChange(j); }} />}
    </div>
  );
}

export function NotesTab({ job, onChange }: { job: any; onChange: (j: any) => void }) {
  const [body, setBody] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true); setErr('');
    try { onChange(await api(`/api/jobs/${job.id}/notes`, { body: { body, visibility: restricted ? 'commercial' : 'all' } })); setBody(''); setRestricted(false); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const remove = async (id: string) => { try { onChange(await api(`/api/notes/${id}`, { method: 'DELETE' })); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="panel">
      <h2>Notes</h2>
      {err && <div className="msg err">{err}</div>}
      <ul className="timeline" style={{ marginBottom: 12 }}>
        {job.notes.map((n: any) => <li key={n.id} style={{ gridTemplateColumns: '150px 1fr auto' }}>
          <span className="muted">{fmtDateTime(n.created_at)}<br />{n.author}</span>
          <span style={{ whiteSpace: 'pre-wrap' }}>{n.visibility === 'commercial' && <span className="flag" style={{ marginRight: 6 }}>Commercial — hidden from Transport</span>}{n.body}</span>
          <span>{n.can_delete && <button className="btn small" onClick={() => remove(n.id)}>Remove</button>}</span>
        </li>)}
        {job.notes.length === 0 && <li style={{ display: 'block' }} className="muted">No notes yet.</li>}
      </ul>
      {job.permissions.add_note && <>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note for the team — e.g. gate pass details, customer instructions" maxLength={2000} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          {job.permissions.add_commercial_note && <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
            Commercial note (hidden from Transport)</label>}
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || !body.trim()} onClick={add}>Add note</button>
        </div>
      </>}
    </div>
  );
}
