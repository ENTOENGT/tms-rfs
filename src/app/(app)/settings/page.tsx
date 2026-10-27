'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import MasterPage from '@/components/MasterPage';

const FIELDS: [string, string, string, string?][] = [
  ['company_name', 'Company name', 'text'],
  ['currency', 'Currency code', 'text', 'e.g. AED'],
  ['vat_rate', 'VAT rate (%)', 'number', 'Applies to jobs created after you change it'],
  ['job_number_prefix', 'Request No. prefix', 'text', 'Automatic Request No. — e.g. TR- gives TR-1001. The Job No. is typed by Operations.'],
  ['timezone', 'Timezone', 'text', 'Asia/Dubai'],
  ['expiry_warning_days', 'Warn about expiring documents (days)', 'number', 'Licence, visa, registration, insurance'],
  ['pod_reminder_hours', 'POD reminder after (hours)', 'number', 'Used when reminders arrive in Phase 7'],
];
const STAGE: Record<string, string> = { draft: 'Draft', open: 'Waiting', active: 'In progress', delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled' };

const SIDE_NAMES: Record<string, string> = { admin: 'Administration', operations: 'Operations', transport: 'Transport', messenger: 'Messengers', finance: 'Finance', pro: 'PRO' };
function Departments() {
  const { reloadLookups } = useMe();
  const [rows, setRows] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/settings/departments').then(setRows).catch((e) => setErr(e.message)); }, []);
  const save = async (body: any) => {
    try { setRows(await api('/api/settings/departments', { body })); setEdit(null); setErr(''); reloadLookups(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="panel">
      <div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Departments</h2><span className="spacer" />
        <button className="btn" onClick={() => setEdit({ name: '', side: 'operations' })}>Add department</button></div>
      <p className="muted small" style={{ marginTop: 0 }}>Each department belongs to a side. Operations departments see only their own jobs; Transport sees jobs from every department.</p>
      {err && <div className="msg err">{err}</div>}
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Department</th><th>Side</th><th className="num">Active users</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((d) => <tr key={d.id} style={d.is_active ? undefined : { opacity: 0.55 }}>
          <td><b>{d.name}</b></td><td>{SIDE_NAMES[d.side]}</td><td className="num">{d.users}</td><td>{d.is_active ? 'Active' : 'Switched off'}</td>
          <td style={{ textAlign: 'right' }}><button className="btn small" onClick={() => setEdit({ ...d })}>Edit</button></td></tr>)}</tbody>
      </table></div>
      {edit && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setEdit(null)}>
        <div className="modal" role="dialog" aria-label="Department">
          <h2>{edit.id ? `Edit ${edit.name}` : 'Add department'}</h2>
          <div className="grid g2">
            <label className="f"><span>Name</span><input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="f"><span>Side</span><select value={edit.side} disabled={edit.code === 'admin'} onChange={(e) => setEdit({ ...edit, side: e.target.value })}>
              {Object.entries(SIDE_NAMES).filter(([k]) => k !== 'admin' || edit.code === 'admin').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            {edit.id && edit.code !== 'admin' && <label className="f"><span>Active</span>
              <input type="checkbox" style={{ width: 'auto' }} checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /></label>}
          </div>
          <div className="actions"><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn primary" disabled={!edit.name.trim()} onClick={() => save(edit)}>Save</button></div>
        </div></div>}
    </div>
  );
}

function StorageCheck() {
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { setR(await api('/api/storage-check', { body: {} })); } catch (e: any) { setR({ ok: false, steps: [{ step: 'Check', ok: false, detail: e.message }] }); } setBusy(false); };
  return (
    <div className="panel">
      <div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>File storage (POD & documents)</h2><span className="spacer" />
        <button className="btn" disabled={busy} onClick={run}>{busy ? 'Testing…' : 'Test file storage'}</button></div>
      <p className="muted small" style={{ marginTop: 0 }}>Uploads a tiny test file, reads it back and deletes it. Run this once after setting up storage.</p>
      {r && <div className={`msg ${r.ok ? 'ok' : 'err'}`}>
        <b>{r.ok ? 'File storage is working.' : 'File storage is not working yet.'}</b>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{r.steps.map((s: any, i: number) => <li key={i}>{s.ok ? '✓' : '✕'} {s.step}{s.detail ? ` — ${s.detail}` : ''}</li>)}</ul>
      </div>}
    </div>
  );
}

/** The 30-day rule: proof that it runs, what it deleted, and anything that failed (retried automatically). */
function DocumentCleanup() {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => api('/api/settings/document-cleanup').then(setD).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  const run = async () => {
    setBusy(true); setMsg('');
    try { const r = await api('/api/settings/document-cleanup', { body: {} });
      setMsg(r.skipped ? 'A clean-up is already running.' : `Done: ${r.deleted} deleted, ${r.failed} failed.`); load(); }
    catch (e: any) { setMsg(e.message); }
    setBusy(false);
  };
  return (
    <div className="panel">
      <div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Document clean-up (30-day rule)</h2><span className="spacer" />
        <button className="btn small" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run now'}</button></div>
      <p className="muted small" style={{ marginTop: 0 }}>Trip documents (Invoice, Packing list, BOE, BL, Gate pass, Other) are deleted 30 days after each upload —
        the file in storage and then its record. Runs every hour automatically. Jobs, history and reports are never deleted. PODs are kept.</p>
      {msg && <div className="msg">{msg}</div>}
      {d && <>
        <p className="small">Deleted in the last 30 days: <b>{d.deleted_30d}</b> · Waiting now: <b>{d.waiting}</b>
          {d.next_due && <> · Next one due: <b>{fmtDateTime(d.next_due)}</b></>}</p>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Started</th><th>How</th><th>Deleted</th><th>Failed</th><th>Note</th></tr></thead>
          <tbody>{d.runs.map((r: any) => <tr key={r.id}><td>{fmtDateTime(r.started_at)}</td>
            <td>{({ schedule: 'Every hour', backup: 'Backup trigger', manual: 'Run now' } as any)[r.trigger] ?? r.trigger}</td>
            <td>{r.deleted}</td><td>{r.failed ? <span className="flag">{r.failed}</span> : 0}</td><td className="small">{r.error ?? (r.finished_at ? '' : 'Running…')}</td></tr>)}
            {d.runs.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}</tbody></table></div>
        {d.problems.length > 0 && <>
          <p className="small" style={{ marginBottom: 4 }}><b>Files that could not be deleted yet</b> — tried again on every run:</p>
          <ul className="small">{d.problems.map((p: any) => <li key={p.id}>{p.file_name} (Job No. {p.job_no ?? p.job_number}) — {p.purge_attempts} attempt(s): {p.purge_error}</li>)}</ul>
        </>}
      </>}
    </div>
  );
}

export default function Settings() {
  const { can, reloadLookups } = useMe();
  const [data, setData] = useState<any>(null);
  const [f, setF] = useState<any>({});
  const [msg, setMsg] = useState<{ t: string; m: string } | null>(null);
  const [edit, setEdit] = useState<any>(null);
  const load = () => api('/api/settings').then((d) => { setData(d); setF(d.settings); });
  useEffect(() => { load(); }, []);
  if (!can('settings.manage')) return <div className="page"><div className="msg err">You don't have permission to change settings.</div></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const run = async (fn: () => Promise<any>, ok: string) => {
    try { const d = await fn(); setData(d); setF(d.settings); setMsg({ t: 'ok', m: ok }); setEdit(null); reloadLookups(); window.scrollTo(0, 0); }
    catch (e: any) { setMsg({ t: 'err', m: e.message }); window.scrollTo(0, 0); }
  };
  const next = (code: string) => data.transitions.filter((t: any) => t.from_code === code)
    .map((t: any) => data.statuses.find((s: any) => s.code === t.to_code)?.name).filter(Boolean).join(', ');
  return (
    <div className="page">
      <div className="page-head"><h1>Settings</h1></div>
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="panel">
        <h2>Company</h2>
        <div className="grid g3">
          {FIELDS.map(([k, label, type, hint]) => (
            <label className="f" key={k}><span>{label}</span>
              <input type={type} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
              {hint && <span className="muted small" style={{ fontWeight: 400, marginTop: 3 }}>{hint}</span>}</label>))}
        </div>
        <div className="form-actions"><button className="btn primary" onClick={() => run(() => api('/api/settings', { method: 'PUT', body: f }), 'Settings saved')}>Save settings</button></div>
      </div>

      <div className="panel">
        <div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Job statuses</h2><span className="spacer" />
          <button className="btn" onClick={() => setEdit({ name: '', color: '#446688', after: 'picked_up', before: 'in_transit' })}>Add status</button></div>
        <p className="muted small" style={{ marginTop: 0 }}>Rename or recolour any status. Built-in statuses can't be switched off because the workflow depends on them; ones you add can.</p>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Status</th><th>Group</th><th>Can move to</th><th /></tr></thead>
          <tbody>{data.statuses.map((s: any) => (
            <tr key={s.code} style={s.is_active ? undefined : { opacity: 0.5 }}>
              <td><span className="badge" style={{ background: s.color }}>{s.name}</span>{!s.is_system && <span className="muted small"> custom</span>}</td>
              <td>{STAGE[s.stage]}</td><td className="small">{next(s.code) || '—'}</td>
              <td><button className="btn small" onClick={() => setEdit({ ...s })}>Edit</button></td>
            </tr>))}</tbody>
        </table></div>
      </div>

      <Departments />

      <StorageCheck />
      <DocumentCleanup />

      <div className="panel"><MasterPage entity="vehicle_types" embedded /></div>

      {edit && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setEdit(null)}>
          <div className="modal" role="dialog" aria-label="Status">
            <h2>{edit.code ? 'Edit status' : 'Add status'}</h2>
            <div className="grid g2">
              <label className="f"><span>Name</span><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label className="f"><span>Colour</span><input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} style={{ height: 36 }} /></label>
              {!edit.code && <>
                <label className="f"><span>Comes after</span><select value={edit.after} onChange={(e) => setEdit({ ...edit, after: e.target.value })}>
                  {data.statuses.filter((s: any) => s.code !== 'cancelled').map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
                <label className="f"><span>Comes before</span><select value={edit.before} onChange={(e) => setEdit({ ...edit, before: e.target.value })}>
                  {data.statuses.filter((s: any) => s.code !== 'cancelled').map((s: any) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></label>
              </>}
              {edit.code && !edit.is_system && <label className="f"><span>Active</span>
                <input type="checkbox" style={{ width: 'auto' }} checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /></label>}
            </div>
            {!edit.code && <p className="muted small">Jobs can then go "{data.statuses.find((s: any) => s.code === edit.after)?.name}" → your new status → "{data.statuses.find((s: any) => s.code === edit.before)?.name}". The direct route stays available too.</p>}
            <div className="actions"><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn primary" onClick={() => run(() => api('/api/settings/statuses', { body: edit }), edit.code ? 'Status saved' : 'Status added')}>Save</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
