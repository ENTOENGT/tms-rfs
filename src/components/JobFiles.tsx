'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtDate, fmtDateTime } from './api';

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.xlsx,.docx';
const POD_ACCEPT = '.pdf,.jpg,.jpeg,.png';
const MAX = 10 * 1024 * 1024;
export const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Phone photos are often 4–8 MB. Shrink big photos to max 2000px before upload (keeps them readable, saves storage). */
export async function shrinkImage(file: File): Promise<File> {
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
        <h2>{isPod ? `Upload POD — Job No. ${job.job_no ?? job.job_number}` : `Upload document — Job No. ${job.job_no ?? job.job_number}`}</h2>
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
        {pods.map((d: any, i: number) => <li key={d.id} style={{ padding: '3px 0' }}>
          <FileLink files={pods} index={i} base={docUrl} /> <span className="muted small">{fmtSize(d.size_bytes)}</span></li>)}
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
            <h2>Reject POD — Job No. {job.job_no ?? job.job_number}</h2>
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
  const reqDocs = job.documents.filter((d: any) => d.is_request_doc), otherDocs = job.documents.filter((d: any) => !d.is_request_doc);
  const live = reqDocs.filter((d: any) => !d.expired);
  const [printing, setPrinting] = useState('');
  const viewable = job.documents.filter((d: any) => !d.expired);          // the viewer pages through files that still exist
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
      {[['Documents for the trip', reqDocs, true], ['Other files', otherDocs, false]].map(([title, list, isReq]: any) => (list.length > 0 || isReq) && (
        <div key={title}>
          <h3 className="docs-h">{title}{isReq && live.length > 0 && <span className="print-badge" style={{ marginLeft: 8 }}>🖨 {live.length} ready to print</span>}
            {isReq && live.length > 1 && <button className="btn small" style={{ marginLeft: 'auto' }} disabled={!!printing}
              onClick={() => printFiles(live.map((d: any) => `${docUrl(d.id)}?view=1`), setPrinting).catch((e) => { setPrinting(''); setErr(e.message); })}>
              {printing || `Print all ${live.length}`}</button>}</h3>
          {isReq && <p className="muted small" style={{ margin: '0 16px 6px' }}>Click a file to open it, then <b>Print</b>. These files are deleted automatically 30 days after upload.</p>}
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Type</th><th>File</th><th>Size</th><th>Uploaded</th><th /></tr></thead>
            <tbody>
              {list.map((d: any) => <tr key={d.id}>
                <td>{d.document_type}</td>
                <td>{d.expired ? <span className="expired-tag">{d.file_name} — expired, deleted after 30 days</span>
                  : <FileLink files={viewable} index={viewable.indexOf(d)} base={docUrl} />}
                  {!d.expired && d.expires_at && <div className="muted small">Deleted on {fmtDate(d.expires_at)}</div>}</td>
                <td>{d.expired ? '—' : fmtSize(d.size_bytes)}</td>
                <td>{d.uploaded_by_name ?? '—'} <span className="muted small">· {fmtDateTime(d.created_at)}</span></td>
                <td style={{ textAlign: 'right' }}>{d.can_delete && <button className="btn small danger" onClick={() => remove(d)}>Remove</button>}</td>
              </tr>)}
              {list.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 16, textAlign: 'center' }}>No documents for the trip yet.</td></tr>}
            </tbody>
          </table></div>
        </div>))}
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

/* ---------- file viewer: files open on the page first; downloading is a separate choice ---------- */
type ViewFile = { id: string; file_name: string; mime_type?: string | null; size_bytes?: number | null };
const kindOf = (f: ViewFile) => {
  const m = (f.mime_type ?? '').toLowerCase(), n = f.file_name.toLowerCase();
  if (m.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/.test(n)) return 'image';
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  return 'other';
};

export function FileViewer({ files, start, base, onClose }: { files: ViewFile[]; start: number; base: (id: string) => string; onClose: () => void }) {
  const [i, setI] = useState(start);
  const [printMsg, setPrintMsg] = useState('');
  const f = files[i];
  const url = base(f.id);
  const kind = kindOf(f);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((n) => Math.min(files.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [files.length, onClose]);
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal viewer" role="dialog" aria-label={`View ${f.file_name}`}>
        <div className="viewer-head">
          <b className="viewer-name" title={f.file_name}>{f.file_name}</b>
          {f.size_bytes ? <span className="muted small">{fmtSize(f.size_bytes)}</span> : null}
          {files.length > 1 && <span className="muted small">{i + 1} of {files.length}</span>}
          <span className="spacer" />
          {files.length > 1 && <>
            <button className="btn small" disabled={i === 0} onClick={() => setI(i - 1)}>‹ Previous</button>
            <button className="btn small" disabled={i === files.length - 1} onClick={() => setI(i + 1)}>Next ›</button></>}
          <a className="btn small" href={`${url}?view=1`} target="_blank" rel="noopener">Open in new tab</a>
          {kind !== 'other' && <button className="btn small" disabled={!!printMsg} onClick={() => {
            // phones print from the browser's own viewer
            if (isPhone()) { window.open(`${url}?view=1`, '_blank'); return; }
            printFiles([`${url}?view=1`], setPrintMsg).catch((e) => { setPrintMsg(''); alert(e.message); });
          }}>{printMsg || 'Print'}</button>}
          <a className="btn small primary" href={url}>Download</a>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        <div className="viewer-body">
          {kind === 'image' && <Photo key={f.id} url={`${url}?view=1`} name={f.file_name} />}
          {kind === 'pdf' && <SmartPreview key={f.id} url={`${url}?view=1`} name={f.file_name} />}
          {kind === 'other' && <div className="viewer-none">
            <p><b>{f.file_name}</b></p>
            <p className="muted">Excel and Word files can't be shown inside the page.<br />Use <b>Download</b> to open it on your computer.</p>
          </div>}
        </div>
      </div>
    </div>
  );
}

/** What a file really is, from its first bytes — labels saved at upload can be wrong (e.g. a photo named .pdf). */
function sniff(b: Uint8Array): 'pdf' | string | null {
  const t = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (t(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf';                       // %PDF
  if (t(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (t(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (t(0, 0x47, 0x49, 0x46)) return 'image/gif';
  if (t(0, 0x52, 0x49, 0x46, 0x46) && t(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  // a PDF can have a few junk bytes before %PDF
  const head = new TextDecoder('latin1').decode(b.slice(0, 1024));
  return head.includes('%PDF') ? 'pdf' : null;
}

async function loadPdf(bytes: Uint8Array) {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.js', import.meta.url).toString();
  return pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
}

/**
 * Print one or many files with ONE print dialog: photos as they are, every PDF page drawn as an image.
 * Works the same in every desktop browser and never downloads the file.
 */
export async function printFiles(urls: string[], onStep?: (msg: string) => void, coverHtml?: string) {
  const pages: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    onStep?.(`Preparing ${i + 1} of ${urls.length}…`);
    const res = await fetch(urls[i]);
    if (res.status === 410) continue;                                 // expired in the meantime
    if (!res.ok) throw new Error(`Could not open file ${i + 1} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const kind = sniff(bytes);
    if (kind === 'pdf') {
      const doc = await loadPdf(bytes);
      for (let n = 1; n <= Math.min(doc.numPages, 100); n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 2 });                    // ~150 dpi on A4: sharp on paper
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        pages.push(c.toDataURL('image/jpeg', 0.92));
      }
    } else if (kind) pages.push(URL.createObjectURL(new Blob([bytes], { type: kind })));
    else throw new Error('One of the files is not a PDF or photo — download it to print.');
  }
  if (!pages.length && !coverHtml) throw new Error('Nothing to print.');
  onStep?.('Opening the print window…');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(frame);
  const d = frame.contentDocument!;
  d.open();
  d.write(`<!doctype html><html><head><title>Print</title><style>@page{margin:8mm}html,body{margin:0}
    .p{page-break-after:always;break-after:page;display:flex;align-items:center;justify-content:center;height:100vh}
    .p:last-child{page-break-after:auto;break-after:auto}img{max-width:100%;max-height:100%;object-fit:contain}
    .sheet{font:13px/1.45 Arial,sans-serif;color:#111;${pages.length ? 'page-break-after:always;break-after:page;' : ''}}
    .sheet h1{font-size:22px;margin:0}.sheet table{width:100%;border-collapse:collapse;margin-top:10px}
    .sheet td{border:1px solid #999;padding:6px 8px;vertical-align:top}.sheet td.k{width:28%;background:#f1f1f1;font-weight:bold}
    .sheet .sig{display:flex;gap:30px;margin-top:40px}.sheet .sig div{flex:1;border-top:1px solid #333;padding-top:4px}</style></head><body>
    ${coverHtml ? `<div class="sheet">${coverHtml}</div>` : ''}
    ${pages.map((src) => `<div class="p"><img src="${src}"></div>`).join('')}</body></html>`);
  d.close();
  await Promise.all([...d.images].map((im) => (im.complete ? null : new Promise((ok) => { im.onload = ok; im.onerror = ok; }))));
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  onStep?.('');
  setTimeout(() => { frame.remove(); pages.forEach((u) => u.startsWith('blob:') && URL.revokeObjectURL(u)); }, 60_000);
}
const isPhone = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Shows a PDF page by page, or a photo — decided by the file's real contents. Phones never get a forced download. */
function SmartPreview({ url, name }: { url: string; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'pdf' | 'error'>('loading');
  const [img, setImg] = useState('');
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let stop = false, blobUrl = '';
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (stop) return;
        const kind = sniff(bytes);
        if (kind && kind !== 'pdf') { blobUrl = URL.createObjectURL(new Blob([bytes], { type: kind })); setImg(blobUrl); return; }
        if (!kind) throw new Error('unknown');
        const doc = await loadPdf(bytes);
        if (stop) return;
        setPages(doc.numPages); setState('pdf');
        const el = box.current; if (!el) return;
        el.innerHTML = '';
        const width = Math.min(el.clientWidth - 24, 1000);
        for (let n = 1; n <= Math.min(doc.numPages, 50) && !stop; n++) {
          const page = await doc.getPage(n);
          const scale = width / page.getViewport({ scale: 1 }).width, ratio = window.devicePixelRatio || 1;
          const vp = page.getViewport({ scale: scale * ratio });
          const c = document.createElement('canvas');
          c.width = vp.width; c.height = vp.height; c.style.width = `${width}px`; c.setAttribute('aria-label', `${name} page ${n}`);
          el.appendChild(c);
          await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        }
      } catch { if (!stop) setState('error'); }
    })();
    return () => { stop = true; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [url, name]);
  if (img) return <img src={img} alt={name} />;
  return <div className="viewer-pdf">
    {state === 'loading' && <p className="muted" style={{ textAlign: 'center' }}>Opening file…</p>}
    {state === 'error' && <div className="viewer-none"><p className="muted">This file could not be shown here. Try <b>Open in new tab</b> or <b>Download</b>.</p></div>}
    {state === 'pdf' && pages > 50 && <p className="muted small" style={{ textAlign: 'center' }}>Showing the first 50 of {pages} pages. Download to see all.</p>}
    <div ref={box} className="viewer-pdf-pages" />
  </div>;
}

/** A photo; if the browser can't draw it (wrong label, odd format) fall back to checking the real contents. */
function Photo({ url, name }: { url: string; name: string }) {
  const [bad, setBad] = useState(false);
  return bad ? <SmartPreview url={url} name={name} /> : <img src={url} alt={name} onError={() => setBad(true)} />;
}

/** A file name that opens the viewer when clicked. Pass the whole list so the viewer can page through it. */
export function FileLink({ files, index, base }: { files: ViewFile[]; index: number; base: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const f = files[index];
  return <>
    <a href={`${base(f.id)}?view=1`} onClick={(e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); setOpen(true); }}>{f.file_name}</a>
    {open && <FileViewer files={files} start={index} base={base} onClose={() => setOpen(false)} />}
  </>;
}
export const docUrl = (id: string) => `/api/documents/${id}/download`;
export const runFileUrl = (id: string) => `/api/run-files/${id}`;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** One-page trip sheet the transporter hands to the driver with the printed documents. No prices on it. */
export function tripSheetHtml(job: any, docs: any[], tz = 'Asia/Dubai') {
  const dt = (v?: string | null) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }) : '');
  const row = (k: string, v: unknown) => `<tr><td class="k">${esc(k)}</td><td>${esc(v) || '&nbsp;'}</td></tr>`;
  return `<div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #111;padding-bottom:6px">
      <div><h1>TRIP SHEET — Job No. ${esc(job.job_no ?? job.job_number)}</h1><div>Request No. ${esc(job.job_number)} · ${esc(job.department_name ?? '')}</div></div>
      <img src="${location.origin}/brand/logo.png" style="height:40px;max-width:none"></div>
    <table>
      ${row('Date required', job.required_date + (job.slot_from ? `, ${job.slot_from.slice(0, 5)}${job.slot_to ? '–' + job.slot_to.slice(0, 5) : ''}` : ''))}
      ${row('Driver', [job.driver_name, job.driver_mobile].filter(Boolean).join(' · '))}
      ${row('Vehicle', job.vehicle_number)}
      ${row('Planned pickup', dt(job.planned_pickup_at))}
      ${row('Pick up from', [job.pickup_name, job.pickup_address].filter(Boolean).join(', '))}
      ${row('Pickup contact', [job.pickup_contact_person, job.pickup_contact_number].filter(Boolean).join(' · '))}
      ${row('Deliver to', [job.delivery_name, job.delivery_address].filter(Boolean).join(', '))}
      ${row('Delivery contact', [job.delivery_contact_person, job.delivery_contact_number].filter(Boolean).join(' · '))}
      ${row('Customer', job.customer_name)}
      ${row('BOE', job.boe_number)}
      ${row('Goods', [job.cargo_description, job.packages != null ? job.packages + ' packages' : '', job.pallets != null ? job.pallets + ' pallets' : '',
        job.weight_kg ? job.weight_kg + ' kg' : ''].filter(Boolean).join(' · '))}
      ${row('Instructions', [job.special_instructions, job.special_handling, job.temperature_requirement].filter(Boolean).join(' · '))}
      ${row('Documents attached', docs.length ? docs.map((d) => `${d.document_type}: ${d.file_name}`).join('; ') : 'None')}
    </table>
    <div class="sig"><div>Driver signature</div><div>Received by (name, signature, stamp)</div><div>Date / time</div></div>`;
}
