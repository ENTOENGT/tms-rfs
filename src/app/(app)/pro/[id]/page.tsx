'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { FileLink, fmtSize } from '@/components/JobFiles';
import { DIRECTION, PriorityFlag, proAct, proFileUrl, uploadPro } from '@/components/ProShared';

const ACT_COLOR: Record<string, string> = { not_started: '#8A94A6', documents_required: '#C05621', submitted: '#6B46C1', pending_inspection: '#805AD5',
  inspection_in_progress: '#553C9A', pending_approval: '#9F7AEA', payment_pending: '#D69E2E', approved: '#2F855A', rejected: '#9B2C2C',
  completed: '#22543D', not_required: '#A0AEC0', on_hold: '#718096' };
const d10 = (v: any) => (v ? String(v).slice(0, 10) : '');
const local16 = (v: any) => (v ? new Date(v).toLocaleString('sv-SE', { timeZone: 'Asia/Dubai' }).slice(0, 16).replace(' ', 'T') : '');

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-label={title}><h2>{title}</h2>{children}</div></div>;
}
const KV = ({ rows }: { rows: [string, any][] }) => (
  <dl className="kv">{rows.filter(([, v]) => v !== undefined).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v === null || v === '' ? '—' : v}</dd></Fragment>)}</dl>);

export default function ProDetail({ params }: { params: { id: string } }) {
  const { me, lk } = useMe();
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('work');
  const [dlg, setDlg] = useState<{ kind: string; data?: any } | null>(null);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const load = () => api(`/api/pro/${params.id}`).then(setR).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);
  if (err && !r) return <div className="page"><div className="msg err">{err}</div><Link href="/pro">Back</Link></div>;
  if (!r) return <div className="page muted">Loading…</div>;
  const can = r.can, o = r.options;
  const run = async (fn: () => Promise<any>, close = true) => {
    setBusy(true); setErr('');
    try { const x = await fn(); if (x?.id) setR(x); if (close) { setDlg(null); setForm({}); } }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const open = (kind: string, data?: any, init: any = {}) => { setErr(''); setForm(init); setDlg({ kind, data }); };
  const setF = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const docsCurrent = r.documents.filter((d: any) => d.current);
  const containerOpts = <><option value="">Whole request</option>{r.containers.map((k: any) => <option key={k.id} value={k.id}>{k.container_no}</option>)}</>;

  return (
    <div className={me.app_only ? 'app-page' : 'page'}>
      {me.app_only && <Link href="/pro" className="app-back">‹ My PRO work</Link>}
      <div className="page-head" style={{ flexWrap: 'wrap' }}>
        <h1>Job No. {r.job_no}</h1>
        <span className="muted small">{r.request_no}</span>
        <span className="badge" style={{ background: r.status_color }}>{r.status_name}</span>
        <PriorityFlag p={r.priority} />
        {!['done', 'cancelled'].includes(r.stage) && d10(r.deadline ?? r.required_date) < new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }) && <span className="flag">Overdue</span>}
        <span className="spacer" />
        <span className="muted small pro-hide-sm">Requested by {r.requested_by_name}{r.department_name ? ` (${r.department_name})` : ''} · {fmtDateTime(r.created_at)}</span>
      </div>
      {err && <div className="msg err">{err}</div>}
      {r.stage === 'hold' && r.hold_reason && <div className="msg warn">On hold: {r.hold_reason}</div>}
      {r.stage === 'cancelled' && <div className="msg err">Cancelled{r.cancel_reason ? `: ${r.cancel_reason}` : ''}</div>}

      <div className="panel" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>PRO officer: <b>{r.assigned_to_name ?? 'not assigned'}</b></span><span className="spacer" style={{ flex: 1 }} />
        {can.submit_draft && <button className="btn primary" disabled={busy} onClick={() => run(() => proAct(r.id, 'status', { to: 'pending_assignment' }))}>Send to PRO</button>}
        {can.assign && !['done', 'cancelled'].includes(r.stage) && <button className="btn primary" onClick={() => open('assign', null, { assigned_to: r.assigned_to ?? '' })}>{r.assigned_to ? 'Reassign' : 'Assign officer'}</button>}
        {can.status && <button className="btn" onClick={() => open('status', null, { to: '' })}>Change status</button>}
        {can.edit_request && <button className="btn" onClick={() => open('edit', null, { job_no: r.job_no, bl_number: r.bl_number, shipment_reference: r.shipment_reference ?? '', vessel: r.vessel ?? '', voyage: r.voyage ?? '',
          uae_location: r.uae_location, required_date: d10(r.required_date), deadline: d10(r.deadline), priority: r.priority, instructions: r.instructions ?? '', cargo_description: r.cargo_description ?? '' })}>Edit details</button>}
        {can.cancel && !can.status && <button className="btn danger" onClick={() => open('status', null, { to: 'cancelled' })}>Cancel request</button>}
      </div>
      {!['done', 'cancelled', 'draft'].includes(r.stage) && (r.completion.ready
        ? <div className="pro-ok">All activities are finished and all containers released — this request can be marked <b>Completed</b>.</div>
        : <div className="pro-block"><b>Still open before completion:</b> {r.completion.blockers.join(' · ')}</div>)}

      <div className="tabs" role="tablist" style={{ marginTop: 12 }}>
        {[['work', 'Clearance'], ['details', 'Request'], ['documents', `Documents (${docsCurrent.length})`], ...(can.charges_view ? [['charges', 'Charges']] : []), ['history', `History (${r.history.length})`]].map(([k, l]) =>
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'work' && <>
        <div className="panel"><div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Containers</h2><span className="spacer" />
          {(can.work || can.edit_request) && !['done', 'cancelled'].includes(r.stage) && <button className="btn small" onClick={() => open('container', null, { size_type: '40HC' })}>+ Container</button>}</div>
          {r.containers.length === 0 && <p className="muted small">No containers (LCL / air / land).</p>}
          {me.app_only ? r.containers.map((k: any) => <div key={k.id} className="pro-act">
            <div className="pro-act-head"><b>{k.container_no}</b><span className="muted small">{k.size_type}</span>{k.delay_reason && <span className="flag">{k.delay_reason}</span>}</div>
            <div className="grid g3" style={{ marginTop: 6 }}>{(['customs_status', 'inspection_status', 'release_status'] as const).map((fld) => <label key={fld} className="f">
              <span>{({ customs_status: 'Customs', inspection_status: 'Inspection', release_status: 'Release' } as any)[fld]}</span>
              {can.work && !['done', 'cancelled'].includes(r.stage)
                ? <select value={k[fld]} disabled={busy} onChange={(e) => run(() => proAct(r.id, 'container', { container_id: k.id, [fld]: e.target.value }), false)}>
                    {Object.entries(o.container_labels[fld]).map(([v, l]: any) => <option key={v} value={v}>{l}</option>)}</select>
                : <b>{k.labels[fld]}</b>}</label>)}</div>
            {can.work && !['done', 'cancelled'].includes(r.stage) && <a href="#" className="small" onClick={(e) => { e.preventDefault(); open('container_note', k, { delay_reason: k.delay_reason ?? '', remarks: k.remarks ?? '' }); }}>Delay reason / remarks</a>}
          </div>) : <div className="table-wrap"><table className="t">
            <thead><tr><th>Container</th><th>Customs</th><th>Inspection</th><th>Release</th><th className="pro-hide-sm">Delay / remarks</th></tr></thead>
            <tbody>{r.containers.map((k: any) => <tr key={k.id} className="cont-row">
              <td><b>{k.container_no}</b><div className="muted small">{k.size_type}</div></td>
              {(['customs_status', 'inspection_status', 'release_status'] as const).map((fld) => <td key={fld}>
                {can.work && !['done', 'cancelled'].includes(r.stage)
                  ? <select value={k[fld]} disabled={busy} onChange={(e) => run(() => proAct(r.id, 'container', { container_id: k.id, [fld]: e.target.value }), false)}>
                      {Object.entries(o.container_labels[fld]).map(([v, l]: any) => <option key={v} value={v}>{l}</option>)}</select>
                  : k.labels[fld]}
                {fld === 'customs_status' && k.customs_cleared_at && <div className="muted small">{fmtDateTime(k.customs_cleared_at)}</div>}
                {fld === 'release_status' && k.released_at && <div className="muted small">{fmtDateTime(k.released_at)}</div>}</td>)}
              <td className="pro-hide-sm small">{k.delay_reason && <div className="flag">{k.delay_reason}</div>}{k.remarks}
                {can.work && !['done', 'cancelled'].includes(r.stage) && <div><a href="#" onClick={(e) => { e.preventDefault(); open('container_note', k, { delay_reason: k.delay_reason ?? '', remarks: k.remarks ?? '' }); }}>Edit</a></div>}</td>
            </tr>)}</tbody></table></div>}
        </div>

        <div className="panel"><div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Authority activities</h2><span className="spacer" />
          {can.work && !['done', 'cancelled'].includes(r.stage) && <button className="btn small" onClick={() => open('activity_new', null, { assigned_to: r.assigned_to ?? '' })}>+ Activity</button>}</div>
          {r.activities.length === 0 && <p className="muted small">No activities yet. Add the approvals this shipment needs (not every shipment needs every authority).</p>}
          {r.activities.map((x: any) => <div key={x.id} className={`pro-act${x.finished ? ' done' : ''}`}>
            <div className="pro-act-head"><b>{x.type_name}</b>{x.authority_name && <span>— {x.authority_name}</span>}
              {x.container_no && <span className="muted small">({x.container_no})</span>}
              <span className="badge" style={{ background: ACT_COLOR[x.status] }}>{x.status_name}</span><span className="spacer" style={{ flex: 1 }} />
              {can.work && !['done', 'cancelled'].includes(r.stage) && <button className="btn small" onClick={() => open('activity', x, {
                status: x.status, authority_id: x.authority_id ?? '', reference_no: x.reference_no ?? '', submitted_on: d10(x.submitted_on), appointment_at: local16(x.appointment_at),
                required_documents: x.required_documents ?? '', authority_remarks: x.authority_remarks ?? '', outstanding: x.outstanding ?? '', approved_on: d10(x.approved_on),
                rejected_on: d10(x.rejected_on), completed_on: d10(x.completed_on), next_action: x.next_action ?? '', next_action_by: x.next_action_by ?? '',
                next_action_due: d10(x.next_action_due), assigned_to: x.assigned_to ?? '', container_id: x.container_id ?? '' })}>Update</button>}</div>
            <KV rows={[['Reference no.', x.reference_no], ['Officer', x.assigned_to_name], ['Submitted', x.submitted_on ? fmtDate(x.submitted_on) : null],
              ['Appointment', x.appointment_at ? fmtDateTime(x.appointment_at) : undefined], ['Required documents', x.required_documents || undefined],
              ['Authority remarks', x.authority_remarks || undefined], ['Outstanding', x.outstanding || undefined],
              ['Approved', x.approved_on ? fmtDate(x.approved_on) : undefined], ['Rejected', x.rejected_on ? fmtDate(x.rejected_on) : undefined],
              ['Completed', x.completed_on ? fmtDate(x.completed_on) : undefined],
              ['Next action', x.next_action ? `${x.next_action}${x.next_action_by_name ? ' — ' + x.next_action_by_name : ''}${x.next_action_due ? ' by ' + fmtDate(x.next_action_due) : ''}` : undefined]]} />
            {r.documents.filter((d: any) => d.activity_id === x.id && d.current).length > 0 && <div className="small" style={{ marginTop: 4 }}>Evidence: {
              r.documents.filter((d: any) => d.activity_id === x.id && d.current).map((d: any) => <span key={d.id} style={{ marginRight: 8 }}><FileLink files={docsCurrent} index={docsCurrent.indexOf(d)} base={proFileUrl} /></span>)}</div>}
          </div>)}
        </div>
      </>}

      {tab === 'details' && <div className="panel"><KV rows={[
        ['Job No.', r.job_no], ['PRO Request No.', r.request_no], ['Truck job', r.job_id ? <Link href={`/jobs/${r.job_id}`}>{r.linked_request_no}</Link> : null],
        ['Customer', r.customer_name], ['BL number', r.bl_number], ['Shipment / booking', r.shipment_reference], ['Import / Export / Transit', DIRECTION[r.direction]],
        ['FCL / LCL', r.load_type], ['Transport mode', r.transport_mode], ['Vessel / voyage', [r.vessel, r.voyage].filter(Boolean).join(' / ') || null],
        ['Origin → destination', [r.port_of_origin, r.port_of_destination].filter(Boolean).join(' → ') || null], ['UAE port / terminal / free zone', r.uae_location],
        ['Cargo', r.cargo_description], ['Containers', r.containers.length ? `${r.containers.length}: ${r.containers.map((k: any) => `${k.container_no} ${k.size_type ?? ''}`).join(', ')}` : null],
        ['Request date', fmtDate(r.request_date)], ['Required clearance date', fmtDate(r.required_date)], ['Deadline', r.deadline ? fmtDate(r.deadline) : null],
        ['Customs cleared', r.customs_cleared_at ? fmtDateTime(r.customs_cleared_at) : null], ['Completed', r.completed_at ? fmtDateTime(r.completed_at) : null],
        ['Requested by', `${r.requested_by_name}${r.department_name ? ' — ' + r.department_name : ''}`], ['Assigned by', r.assigned_by_name ? `${r.assigned_by_name}, ${fmtDateTime(r.assigned_at)}` : null],
        ['Instructions', r.instructions]]} /></div>}

      {tab === 'documents' && <div className="panel">
        {can.upload && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <select value={form.doc_type ?? 'commercial_invoice'} onChange={setF('doc_type')} style={{ flex: '1 1 200px' }}>{o.doc_types.map(([c, n]: any) => <option key={c} value={c}>{n}</option>)}</select>
          <select value={form.activity_id ?? ''} onChange={setF('activity_id')} style={{ flex: '1 1 200px' }}><option value="">Whole request</option>
            {r.activities.map((x: any) => <option key={x.id} value={x.id}>{x.type_name}{x.authority_name ? ' — ' + x.authority_name : ''}</option>)}</select>
          <label className="btn primary small">{busy ? 'Uploading…' : 'Upload / take photo'}<input type="file" accept=".pdf,image/*" style={{ display: 'none' }} disabled={busy}
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) run(() => uploadPro(r.id, file, form.doc_type ?? 'commercial_invoice', { activity_id: form.activity_id || undefined }), false); }} /></label>
        </div>}
        {o.doc_types.filter(([c]: any) => r.documents.some((d: any) => d.doc_type === c)).map(([c, n]: any) => <div key={c} style={{ marginBottom: 10 }}>
          <b className="small">{n}</b>
          {r.documents.filter((d: any) => d.doc_type === c && d.current).map((d: any) => {
            const older = r.documents.filter((x: any) => x.doc_type === c && !x.current && chainOf(r.documents, d).includes(x.id));
            return <div key={d.id} className="small" style={{ padding: '4px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <FileLink files={docsCurrent} index={docsCurrent.indexOf(d)} base={proFileUrl} /> <span className="muted">v{d.version} · {fmtSize(d.size_bytes)} · {d.uploaded_by_name}, {fmtDateTime(d.created_at)}</span>
              {d.activity_id && <span className="muted"> · {r.activities.find((x: any) => x.id === d.activity_id)?.type_name}</span>}
              {can.upload && <label className="btn small" style={{ marginLeft: 8 }}>Replace<input type="file" accept=".pdf,image/*" style={{ display: 'none' }}
                onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) run(() => uploadPro(r.id, file, d.doc_type, { activity_id: d.activity_id ?? undefined, replaces_id: d.id }), false); }} /></label>}
              {older.length > 0 && <div className="muted">Older versions: {older.map((x: any) => <span key={x.id} style={{ marginRight: 8 }}>
                <a href={`${proFileUrl(x.id)}?view=1`} target="_blank" rel="noopener">v{x.version} {x.file_name}</a> ({x.uploaded_by_name}, {fmtDateTime(x.created_at)})</span>)}</div>}
            </div>;
          })}
        </div>)}
        {r.documents.length === 0 && <p className="muted small">No documents yet.</p>}
      </div>}

      {tab === 'charges' && can.charges_view && <div className="panel">
        <div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Clearance charges</h2><span className="spacer" />
          {can.charges_edit && <button className="btn small" onClick={() => open('charge', null, { category: 'customs_duty', payment_status: 'unpaid' })}>+ Charge</button>}</div>
        <p className="muted small" style={{ marginTop: 0 }}>Recorded here only — nothing is posted to accounts. Estimates are kept apart from actual charges.</p>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Category</th><th>For</th><th className="num">Amount</th><th>Type</th><th>Payment</th><th>Receipt</th><th /></tr></thead>
          <tbody>{r.charges.map((g: any) => <tr key={g.id}>
            <td>{g.category_name}{g.description && <div className="muted small">{g.description}</div>}</td>
            <td className="small">{[g.activity_name && `${g.activity_name}${g.authority_name ? ' — ' + g.authority_name : ''}`, g.container_no].filter(Boolean).join(' · ') || 'Whole request'}</td>
            <td className="num">{fmtMoney(g.amount, lk.currency)}</td><td>{g.is_estimate ? <span className="badge outline">Estimate</span> : 'Actual'}</td>
            <td>{g.payment_status === 'paid' ? `Paid ${fmtDate(g.paid_on)}` : g.payment_status === 'waived' ? 'Waived' : <span className="flag">Unpaid</span>}</td>
            <td className="small">{g.receipt_document_id ? (() => { const d = r.documents.find((x: any) => x.id === g.receipt_document_id); return d ? <a href={`${proFileUrl(d.id)}?view=1`} target="_blank" rel="noopener">{d.file_name}</a> : '—'; })() : '—'}</td>
            <td>{can.charges_edit && <button className="btn small" onClick={() => open('charge', g, { ...g, paid_on: d10(g.paid_on), receipt_document_id: g.receipt_document_id ?? '', activity_id: g.activity_id ?? '', container_id: g.container_id ?? '' })}>Edit</button>}</td>
          </tr>)}{r.charges.length === 0 && <tr><td colSpan={7} className="muted">No charges recorded.</td></tr>}</tbody>
          <tfoot><tr><td colSpan={2}><b>Actual</b> {fmtMoney(r.charges_total.actual, lk.currency)} · <b>Unpaid</b> {fmtMoney(r.charges_total.unpaid, lk.currency)} · <b>Estimates</b> {fmtMoney(r.charges_total.estimated, lk.currency)}</td><td colSpan={5} /></tr></tfoot>
        </table></div></div>}

      {tab === 'history' && <div className="panel">
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" />
          <button className="btn" disabled={busy || !note.trim()} onClick={() => run(async () => { const x = await proAct(r.id, 'note', { remarks: note }); setNote(''); return x; }, false)}>Add</button></div>
        <ul className="timeline">{[...r.history].reverse().map((h: any) => <li key={h.id}><span className="muted">{fmtDateTime(h.at)}</span>
          <span><b>{h.field ?? (h.kind === 'note' ? 'Note' : h.kind)}</b> · {h.user_name}
            {(h.old_value || h.new_value) && <div className="small">{h.old_value ?? '—'} → {h.new_value ?? '—'}</div>}
            {h.remarks && <div className="muted small">{h.remarks}</div>}
            {h.document_id && (() => { const d = r.documents.find((x: any) => x.id === h.document_id); return d ? <div className="small"><a href={`${proFileUrl(d.id)}?view=1`} target="_blank" rel="noopener">📎 {d.file_name}</a></div> : null; })()}</span></li>)}
        </ul></div>}

      {/* ---------------- dialogs ---------------- */}
      {dlg?.kind === 'assign' && <Modal title={r.assigned_to ? 'Reassign PRO officer' : 'Assign PRO officer'} onClose={() => setDlg(null)}>
        <label className="f"><span>PRO officer</span><select value={form.assigned_to} onChange={setF('assigned_to')}><option value="">Choose…</option>
          {o.officers.map((x: any) => <option key={x.id} value={x.id}>{x.full_name} ({x.open_requests} open)</option>)}</select></label>
        <label className="f"><span>Remarks</span><input value={form.remarks ?? ''} onChange={setF('remarks')} /></label>
        <div className="actions"><button className="btn" onClick={() => setDlg(null)}>Back</button>
          <button className="btn primary" disabled={busy || !form.assigned_to} onClick={() => run(() => proAct(r.id, 'assign', form))}>Save</button></div></Modal>}

      {dlg?.kind === 'status' && <Modal title="Change status" onClose={() => setDlg(null)}>
        <p className="muted small" style={{ marginTop: 0 }}>Customs cleared, container released and completed are separate steps. Completed needs every activity finished and every container released.</p>
        <label className="f"><span>New status</span><select value={form.to} onChange={setF('to')}><option value="">Choose…</option>
          {o.statuses.filter((s: any) => s.code !== 'draft' && s.code !== r.status_code && (can.status || s.code === 'cancelled')).map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
        <label className="f"><span>Remarks {['cancelled', 'on_hold', 'rejected'].includes(form.to) && <em>*</em>}</span><textarea value={form.remarks ?? ''} onChange={setF('remarks')} /></label>
        {form.to === 'completed' && !r.completion.ready && <div className="pro-block">Not ready: {r.completion.blockers.join(' · ')}</div>}
        <label className="f"><span>Attach proof (optional)</span><input type="file" accept=".pdf,image/*" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] })} /></label>
        <div className="actions"><button className="btn" onClick={() => setDlg(null)}>Back</button>
          <button className="btn primary" disabled={busy || !form.to} onClick={() => run(async () => {
            let docId: string | undefined;
            if (form.file) { const x = await uploadPro(r.id, form.file, form.to === 'container_released' ? 'release_confirmation' : form.to === 'customs_cleared' ? 'clearance_proof' : 'other');
              docId = x.documents.filter((d: any) => d.current).sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1))[0]?.id; }
            return proAct(r.id, 'status', { to: form.to, remarks: form.remarks, document_id: docId });
          })}>Save</button></div></Modal>}

      {dlg?.kind === 'edit' && <Modal title="Edit request details" onClose={() => setDlg(null)}>
        <div className="grid g2">
          {[['job_no', 'Job No.'], ['bl_number', 'BL number'], ['shipment_reference', 'Shipment / booking ref.'], ['vessel', 'Vessel'], ['voyage', 'Voyage'], ['uae_location', 'UAE port / terminal / free zone']].map(([k, l]) =>
            <label key={k} className="f"><span>{l}</span><input value={form[k] ?? ''} onChange={setF(k)} /></label>)}
          <label className="f"><span>Required clearance date</span><input type="date" value={form.required_date} onChange={setF('required_date')} /></label>
          <label className="f"><span>Deadline</span><input type="date" value={form.deadline} onChange={setF('deadline')} /></label>
          <label className="f"><span>Priority</span><select value={form.priority} onChange={setF('priority')}><option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option></select></label>
          <label className="f span2"><span>Cargo</span><input value={form.cargo_description} onChange={setF('cargo_description')} /></label>
          <label className="f span2"><span>Instructions</span><textarea value={form.instructions} onChange={setF('instructions')} /></label>
        </div>
        <div className="actions"><button className="btn" onClick={() => setDlg(null)}>Back</button>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/pro/${r.id}`, { method: 'PATCH', body: form }))}>Save</button></div></Modal>}

      {dlg?.kind === 'container' && <Modal title="Add container" onClose={() => setDlg(null)}>
        <div className="grid g2"><label className="f"><span>Container number</span><input value={form.container_no ?? ''} onChange={(e) => setForm({ ...form, container_no: e.target.value.toUpperCase() })} placeholder="e.g. MSCU1234566" /></label>
          <label className="f"><span>Size / type</span><input value={form.size_type} onChange={setF('size_type')} /></label></div>
        {form.check && <label className="small"><input type="checkbox" style={{ width: 'auto' }} checked={!!form.confirm_container_check} onChange={setF('confirm_container_check')} /> The number is correct</label>}
        <div className="actions"><button className="btn" onClick={() => setDlg(null)}>Back</button>
          <button className="btn primary" disabled={busy} onClick={() => run(() => proAct(r.id, 'container', form).catch((e) => { if (e.code === 'CONTAINER_CHECK') setForm({ ...form, check: true }); throw e; }))}>Add</button></div></Modal>}

      {dlg?.kind === 'container_note' && <Modal title={`Container ${dlg.data.container_no}`} onClose={() => setDlg(null)}>
        <label className="f"><span>Delay reason</span><input value={form.delay_reason} onChange={setF('delay_reason')} placeholder="e.g. Waiting for municipality inspection slot" /></label>
        <label className="f"><span>Remarks</span><textarea value={form.remarks} onChange={setF('remarks')} /></label>
        <div className="actions">{(can.supervisor || can.edit_request) && <button className="btn danger" onClick={() => confirm('Remove this container from the request?') && run(() => proAct(r.id, 'container', { container_id: dlg.data.id, remove: true }))}>Remove container</button>}
          <span className="spacer" style={{ flex: 1 }} /><button className="btn" onClick={() => setDlg(null)}>Back</button>
          <button className="btn primary" disabled={busy} onClick={() => run(() => proAct(r.id, 'container', { container_id: dlg.data.id, ...form }))}>Save</button></div></Modal>}

      {(dlg?.kind === 'activity' || dlg?.kind === 'activity_new') && <Modal title={dlg.kind === 'activity' ? `${dlg.data.type_name}` : 'Add clearance activity'} onClose={() => setDlg(null)}>
        <div className="grid g2">
          {dlg.kind === 'activity_new' && <label className="f span2"><span>Activity <em>*</em></span><select value={form.activity_type_code ?? ''} onChange={setF('activity_type_code')}>
            <option value="">Choose…</option>{o.activity_types.map((t: any) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></label>}
          {dlg.kind === 'activity' && <label className="f"><span>Status</span><select value={form.status} onChange={setF('status')}>{o.activity_statuses.map(([c, n]: any) => <option key={c} value={c}>{n}</option>)}</select></label>}
          <label className="f"><span>Authority</span><select value={form.authority_id ?? ''} onChange={setF('authority_id')}><option value="">—</option>{o.authorities.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="f"><span>Reference / application no.</span><input value={form.reference_no ?? ''} onChange={setF('reference_no')} /></label>
          <label className="f"><span>Container</span><select value={form.container_id ?? ''} onChange={setF('container_id')}>{containerOpts}</select></label>
          <label className="f"><span>Submitted on</span><input type="date" value={form.submitted_on ?? ''} onChange={setF('submitted_on')} /></label>
          <label className="f"><span>Inspection / appointment</span><input type="datetime-local" value={form.appointment_at ?? ''} onChange={setF('appointment_at')} /></label>
          <label className="f span2"><span>Required documents</span><input value={form.required_documents ?? ''} onChange={setF('required_documents')} /></label>
          {dlg.kind === 'activity' && <>
            <label className="f span2"><span>Authority remarks</span><textarea value={form.authority_remarks ?? ''} onChange={setF('authority_remarks')} /></label>
            <label className="f span2"><span>Outstanding requirements</span><input value={form.outstanding ?? ''} onChange={setF('outstanding')} /></label>
            <label className="f"><span>Approved on</span><input type="date" value={form.approved_on ?? ''} onChange={setF('approved_on')} /></label>
            <label className="f"><span>Rejected on</span><input type="date" value={form.rejected_on ?? ''} onChange={setF('rejected_on')} /></label>
            <label className="f"><span>Completed on</span><input type="date" value={form.completed_on ?? ''} onChange={setF('completed_on')} /></label>
          </>}
          <label className="f span2"><span>Next action</span><input value={form.next_action ?? ''} onChange={setF('next_action')} placeholder="e.g. Collect inspection report from DM counter" /></label>
          <label className="f"><span>Next action by</span><select value={form.next_action_by ?? ''} onChange={setF('next_action_by')}><option value="">—</option>
            {o.officers.map((x: any) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></label>
          <label className="f"><span>Due</span><input type="date" value={form.next_action_due ?? ''} onChange={setF('next_action_due')} /></label>
          {can.supervisor && <label className="f"><span>PRO officer</span><select value={form.assigned_to ?? ''} onChange={setF('assigned_to')}><option value="">—</option>
            {o.officers.map((x: any) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></label>}
          <label className="f span2"><span>Remarks for the history {form.status === 'rejected' && <em>*</em>}</span><input value={form.remarks ?? ''} onChange={setF('remarks')} /></label>
          <label className="f span2"><span>Attach evidence (optional)</span><input type="file" accept=".pdf,image/*" onChange={(e) => setForm({ ...form, file: e.target.files?.[0] })} /></label>
        </div>
        <div className="actions">{dlg.kind === 'activity' && (can.supervisor || dlg.data.status === 'not_started') && <button className="btn danger" onClick={() => confirm('Remove this activity?') && run(() => proAct(r.id, 'activity', { activity_id: dlg.data.id, remove: true }))}>Remove</button>}
          <span className="spacer" style={{ flex: 1 }} /><button className="btn" onClick={() => setDlg(null)}>Back</button>
          <button className="btn primary" disabled={busy || (dlg.kind === 'activity_new' && !form.activity_type_code)} onClick={() => run(async () => {
            const { file, ...body } = form;
            let x = await proAct(r.id, 'activity', dlg.kind === 'activity' ? { ...body, activity_id: dlg.data.id } : body);
            if (file) {
              const actId = dlg.kind === 'activity' ? dlg.data.id : x.activities[x.activities.length - 1]?.id;
              const docType = /approv|clear/.test(form.status ?? '') ? 'authority_approval' : form.status === 'payment_pending' ? 'customs_payment_receipt' : 'other';
              x = await uploadPro(r.id, file, docType, { activity_id: actId });
            }
            return x;
          })}>Save</button></div></Modal>}

      {dlg?.kind === 'charge' && <Modal title={dlg.data ? 'Edit charge' : 'Add charge'} onClose={() => setDlg(null)}>
        <div className="grid g2">
          <label className="f"><span>Category</span><select value={form.category} onChange={setF('category')}>{o.charge_categories.map(([c, n]: any) => <option key={c} value={c}>{n}</option>)}</select></label>
          <label className="f"><span>Amount ({lk.currency})</span><input type="number" min="0" step="0.01" value={form.amount ?? ''} onChange={setF('amount')} /></label>
          <label className="f span2"><span>Description</span><input value={form.description ?? ''} onChange={setF('description')} /></label>
          <label className="f"><span>Activity</span><select value={form.activity_id ?? ''} onChange={setF('activity_id')}><option value="">—</option>
            {r.activities.map((x: any) => <option key={x.id} value={x.id}>{x.type_name}{x.authority_name ? ' — ' + x.authority_name : ''}</option>)}</select></label>
          <label className="f"><span>Container</span><select value={form.container_id ?? ''} onChange={setF('container_id')}>{containerOpts}</select></label>
          <label className="f"><span>Payment</span><select value={form.payment_status} onChange={setF('payment_status')}><option value="unpaid">Unpaid</option><option value="paid">Paid</option><option value="waived">Waived</option></select></label>
          {form.payment_status === 'paid' && <label className="f"><span>Paid on</span><input type="date" value={form.paid_on ?? ''} onChange={setF('paid_on')} /></label>}
          <label className="f span2"><span>Receipt (uploaded document)</span><select value={form.receipt_document_id ?? ''} onChange={setF('receipt_document_id')}><option value="">—</option>
            {docsCurrent.map((d: any) => <option key={d.id} value={d.id}>{d.doc_type_name}: {d.file_name}</option>)}</select></label>
          <label className="small span2"><input type="checkbox" style={{ width: 'auto' }} checked={!!form.is_estimate} onChange={setF('is_estimate')} /> This is an estimate, not an actual charge</label>
        </div>
        <div className="actions">{dlg.data && <button className="btn danger" onClick={() => confirm('Remove this charge?') && run(() => proAct(r.id, 'charge', { charge_id: dlg.data.id, remove: true }))}>Remove</button>}
          <span className="spacer" style={{ flex: 1 }} /><button className="btn" onClick={() => setDlg(null)}>Back</button>
          <button className="btn primary" disabled={busy || form.amount === undefined || form.amount === ''} onClick={() => run(() => proAct(r.id, 'charge', { ...form, charge_id: dlg.data?.id }))}>Save</button></div></Modal>}
    </div>
  );
}

/** The ids of every older version behind a current document. */
function chainOf(docs: any[], d: any) {
  const ids: string[] = [];
  let cur = d;
  while (cur?.replaces_id) { ids.push(cur.replaces_id); cur = docs.find((x) => x.id === cur.replaces_id); }
  return ids;
}
