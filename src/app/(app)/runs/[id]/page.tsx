'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { shrinkImage, fmtSize } from '@/components/JobFiles';
import { RUN_COLOR } from '@/components/RunForm';

const LANE: [string, string][] = [['pending', 'Requested'], ['assigned', 'Assigned'], ['collected', 'Collected'], ['delivered', 'Delivered']];

async function uploadProof(runId: string, original: File) {
  const file = await shrinkImage(original);
  const r = await api(`/api/runs/${runId}/files/upload-url`, { body: { file_name: file.name, mime_type: file.type, size: file.size, kind: 'proof' } });
  const put = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: file });
  if (!put.ok) throw new Error(`Upload failed (${put.status}). Please try again.`);
  return api(`/api/runs/${runId}/files`, { body: { ticket: r.ticket } });
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-label={title}><h2>{title}</h2>{children}</div></div>;
}

export default function RunDetail({ params }: { params: { id: string } }) {
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState('');
  const [dialog, setDialog] = useState<string | null>(null);
  const [form, setForm] = useState<any>({});
  const [messengers, setMessengers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const load = () => api(`/api/runs/${params.id}`).then(setRun).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);
  if (err && !run) return <div className="page"><div className="msg err">{err}</div><Link href="/runs">Back to runs</Link></div>;
  if (!run) return <div className="page muted">Loading…</div>;
  const can = run.can;

  const act = async (fn: () => Promise<any>) => {
    setBusy(true); setErr('');
    try { setRun(await fn()); setDialog(null); setForm({}); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const openAssign = async () => {
    setForm({ messenger_id: run.messenger_id ?? '', planned_at: run.slot_from ? `${run.required_date}T${run.slot_from.slice(0, 5)}` : '' });
    setDialog('assign');
    setMessengers(await api(`/api/messengers?date=${run.required_date}`));
  };
  const deliver = () => act(async () => {
    if (form.file) await uploadProof(run.id, form.file);
    return api(`/api/runs/${run.id}/status`, { body: { to: 'delivered', received_by: form.received_by } });
  });
  const pos = LANE.findIndex(([k]) => k === run.status);
  const big = { padding: '12px 18px', fontSize: 15 };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{run.run_number}</h1>
        <span className="badge" style={{ background: RUN_COLOR[run.status] }}>{run.status_name}</span>
        {run.priority !== 'normal' && <span className="flag">{run.priority[0].toUpperCase() + run.priority.slice(1)} priority</span>}
        <span className="spacer" />
        <span className="muted small">Requested by {run.requested_by_name} · {fmtDateTime(run.created_at)}</span>
      </div>
      {!['failed', 'cancelled'].includes(run.status) && <div className="lane">
        {LANE.map(([k, l], i) => <div key={k} className={i === pos ? 'now' : i < pos ? 'done' : ''} style={i === pos ? { background: RUN_COLOR[k] } : undefined}>{l}</div>)}
      </div>}
      {run.status === 'failed' && <div className="msg err">Could not complete: {run.fail_reason}</div>}
      {run.status === 'cancelled' && <div className="msg err">Cancelled: {run.cancel_reason}</div>}
      {err && <div className="msg err">{err}</div>}

      {(can.assign || can.collect || can.deliver || can.fail || can.cancel || can.edit) && (
        <div className="panel" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          {can.collect && <button className="btn primary" style={big} disabled={busy} onClick={() => act(() => api(`/api/runs/${run.id}/status`, { body: { to: 'collected' } }))}>I've collected the documents</button>}
          {can.deliver && <button className={`btn${can.collect ? '' : ' primary'}`} style={big} onClick={() => setDialog('deliver')}>{run.task_type === 'collect' ? 'Done — documents with me' : 'Delivered'}</button>}
          {can.assign && <button className={`btn${run.status === 'pending' || run.status === 'failed' ? ' primary' : ''}`} onClick={openAssign}>{run.messenger_id ? 'Change messenger' : 'Assign messenger'}</button>}
          {can.edit && <Link className="btn" href={`/runs/${run.id}/edit`}>Edit request</Link>}
          <span style={{ flex: 1 }} />
          {can.fail && <button className="btn danger" onClick={() => setDialog('fail')}>Could not complete</button>}
          {can.cancel && <button className="btn danger" onClick={() => setDialog('cancel')}>Cancel run</button>}
        </div>
      )}

      <div className="cols">
        <div>
          <div className="panel"><h2>{run.task_name}</h2>
            <dl className="kv">
              <dt>Documents</dt><dd><b>{run.documents}</b></dd>
              {run.reference && <><dt>Reference</dt><dd>{run.reference}</dd></>}
              <dt>When</dt><dd>{fmtDate(run.required_date)}{run.slot_from ? `, ${run.slot_from.slice(0, 5)}${run.slot_to ? '–' + run.slot_to.slice(0, 5) : ''}` : ''}</dd>
              <dt>Department</dt><dd>{run.department_name ?? '—'}</dd>
              {run.customer_name && <><dt>Customer</dt><dd>{run.customer_name}</dd></>}
              {run.job_number && <><dt>Related job</dt><dd><Link href={`/jobs/${run.job_id}`}>{run.job_number}</Link></dd></>}
              {run.instructions && <><dt>Instructions</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{run.instructions}</dd></>}
            </dl>
          </div>
          <div className="panel"><div className="grid g2">
            {(['from', 'to'] as const).filter((p) => run[`${p}_name`]).map((p) => <div key={p}>
              <h2>{p === 'from' ? 'Collect from' : run.task_type === 'submit' ? 'Submit to' : 'Deliver to'}</h2>
              <p style={{ margin: '0 0 4px' }}><b>{run[`${p}_name`]}</b></p>
              {run[`${p}_address`] && <p className="small" style={{ margin: '0 0 4px' }}>{run[`${p}_address`]}</p>}
              {run[`${p}_address`] && <a className="small" target="_blank" rel="noopener" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(run[`${p}_name`] + ' ' + run[`${p}_address`])}`}>Open in maps</a>}
              {(run[`${p}_contact_person`] || run[`${p}_contact_number`]) && <p className="small" style={{ margin: '6px 0 0' }}>{run[`${p}_contact_person`]}
                {run[`${p}_contact_number`] && <> · <a href={`tel:${run[`${p}_contact_number`].replace(/\s/g, '')}`}>{run[`${p}_contact_number`]}</a></>}</p>}
            </div>)}
          </div></div>
          <div className="panel"><h2>Notes</h2>
            <ul className="timeline" style={{ marginBottom: 10 }}>
              {run.notes.map((n: any) => <li key={n.id}><span className="muted">{fmtDateTime(n.created_at)}<br />{n.author}</span><span style={{ whiteSpace: 'pre-wrap' }}>{n.body}</span></li>)}
              {run.notes.length === 0 && <li style={{ display: 'block' }} className="muted">No notes yet.</li>}
            </ul>
            {can.note && <><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note — e.g. office closes at 1pm today" maxLength={2000} />
              <div className="form-actions" style={{ marginTop: 8 }}><button className="btn primary" disabled={busy || !note.trim()}
                onClick={() => act(async () => { const r = await api(`/api/runs/${run.id}/notes`, { body: { body: note } }); setNote(''); return r; })}>Add note</button></div></>}
          </div>
          <div className="panel"><h2>History</h2><ul className="timeline">
            {run.activity.map((a: any) => <li key={a.id}><span className="muted">{fmtDateTime(a.occurred_at)}</span>
              <span><b>{a.action}</b> · {a.user_name}{(a.old_value || a.new_value) && <div className="muted small">{a.field ? a.field + ': ' : ''}{a.old_value ?? '—'} → {a.new_value ?? '—'}</div>}</span></li>)}
          </ul></div>
        </div>
        <div>
          <div className="panel"><h2>Messenger</h2>
            {run.messenger_name ? <dl className="kv" style={{ gridTemplateColumns: '110px 1fr' }}>
              <dt>Name</dt><dd><b>{run.messenger_name}</b></dd>
              {run.messenger_mobile && <><dt>Mobile</dt><dd><a href={`tel:${run.messenger_mobile.replace(/\s/g, '')}`}>{run.messenger_mobile}</a></dd></>}
              {run.planned_at && <><dt>Planned</dt><dd>{fmtDateTime(run.planned_at)}</dd></>}
              {run.collected_at && <><dt>Collected</dt><dd>{fmtDateTime(run.collected_at)}</dd></>}
              {run.delivered_at && <><dt>Delivered</dt><dd>{fmtDateTime(run.delivered_at)}</dd></>}
              {run.received_by && <><dt>Received by</dt><dd>{run.received_by}</dd></>}
            </dl> : <p className="muted" style={{ margin: 0 }}>Waiting for the Messenger Manager to assign someone.</p>}
          </div>
          <div className="panel"><h2>Proof & files</h2>
            {run.files.length === 0 && <p className="muted small" style={{ marginTop: 0 }}>No photos yet.</p>}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
              {run.files.map((f: any) => <li key={f.id} style={{ padding: '4px 0' }}><a href={`/api/run-files/${f.id}`} target="_blank" rel="noopener">{f.file_name}</a>
                <span className="muted small"> {fmtSize(f.size_bytes)} · {f.uploaded_by_name}</span></li>)}
            </ul>
            {can.upload && <label className="btn small" style={{ marginTop: 10, display: 'inline-block' }}>Add photo
              <input type="file" accept="image/*,.pdf" capture="environment" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) act(() => uploadProof(run.id, f)); e.target.value = ''; }} /></label>}
          </div>
        </div>
      </div>

      {dialog === 'assign' && <Modal title={`Assign messenger — ${run.run_number}`} onClose={() => setDialog(null)}>
        <p className="muted small" style={{ marginTop: 0 }}>Number = open runs they already have on {fmtDate(run.required_date)}.</p>
        <div role="radiogroup" aria-label="Messenger" style={{ border: '1px solid var(--line)', borderRadius: 4, maxHeight: 260, overflowY: 'auto' }}>
          {messengers.length === 0 && <p className="muted" style={{ padding: 12, margin: 0 }}>No messengers yet. The Messenger Manager adds them under Users (role: Messenger).</p>}
          {messengers.map((m) => <button key={m.id} type="button" role="radio" aria-checked={form.messenger_id === m.id} onClick={() => setForm({ ...form, messenger_id: m.id })}
            style={{ all: 'unset', boxSizing: 'border-box', display: 'flex', width: '100%', padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--line-soft)',
              background: form.messenger_id === m.id ? '#fdf6e3' : undefined, boxShadow: form.messenger_id === m.id ? 'inset 3px 0 0 var(--brand-gold)' : undefined }}>
            <span style={{ flex: 1 }}><b>{m.full_name}</b>{m.mobile && <span className="muted small"> · {m.mobile}</span>}</span>
            <span className={m.open_runs ? 'flag' : 'badge'} style={m.open_runs ? undefined : { background: '#276749' }}>{m.open_runs ? `${m.open_runs} run${m.open_runs > 1 ? 's' : ''}` : 'Free'}</span>
          </button>)}
        </div>
        <label className="f" style={{ marginTop: 12 }}><span>Planned time (optional)</span>
          <input type="datetime-local" value={form.planned_at ?? ''} onChange={(e) => setForm({ ...form, planned_at: e.target.value })} /></label>
        <div className="actions"><button className="btn" onClick={() => setDialog(null)}>Cancel</button>
          <button className="btn primary" disabled={busy || !form.messenger_id} onClick={() => act(() => api(`/api/runs/${run.id}/assign`, { body: form }))}>Assign</button></div>
      </Modal>}

      {dialog === 'deliver' && <Modal title={run.task_type === 'collect' ? 'Documents collected' : 'Mark as delivered'} onClose={() => setDialog(null)}>
        {run.task_type !== 'collect' && <label className="f"><span>Received by <em>*</em></span>
          <input value={form.received_by ?? ''} onChange={(e) => setForm({ ...form, received_by: e.target.value })} placeholder="Name of the person who took the documents" /></label>}
        <label className="f" style={{ marginTop: 12 }}><span>Photo of the receipt or stamped copy (recommended)</span>
          <input type="file" accept="image/*,.pdf" capture="environment" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] })} /></label>
        <div className="actions"><button className="btn" onClick={() => setDialog(null)}>Back</button>
          <button className="btn primary" disabled={busy} onClick={deliver}>{busy ? 'Saving…' : 'Confirm'}</button></div>
      </Modal>}

      {(dialog === 'fail' || dialog === 'cancel') && <Modal title={dialog === 'fail' ? 'Could not complete' : `Cancel ${run.run_number}?`} onClose={() => setDialog(null)}>
        <p className="muted small" style={{ marginTop: 0 }}>{dialog === 'fail' ? 'The Messenger Manager and the requester are told, so they can arrange it again.' : 'The messenger and the Messenger Manager are told.'}</p>
        <label className="f"><span>Reason <em>*</em></span><textarea value={form.reason ?? ''} onChange={(e) => setForm({ ...form, reason: e.target.value })}
          placeholder={dialog === 'fail' ? 'e.g. Office closed / documents not ready' : 'e.g. Customer will collect himself'} /></label>
        <div className="actions"><button className="btn" onClick={() => setDialog(null)}>Back</button>
          <button className="btn danger" disabled={busy} onClick={() => act(() => api(`/api/runs/${run.id}/status`, { body: { to: dialog === 'fail' ? 'failed' : 'cancelled', reason: form.reason } }))}>
            {dialog === 'fail' ? 'Report' : 'Cancel run'}</button></div>
      </Modal>}
    </div>
  );
}
