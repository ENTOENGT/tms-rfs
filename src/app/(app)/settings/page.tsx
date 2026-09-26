'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import MasterPage from '@/components/MasterPage';

const FIELDS: [string, string, string, string?][] = [
  ['company_name', 'Company name', 'text'],
  ['currency', 'Currency code', 'text', 'e.g. AED'],
  ['vat_rate', 'VAT rate (%)', 'number', 'Applies to jobs created after you change it'],
  ['job_number_prefix', 'Job number prefix', 'text', 'e.g. JOB- gives JOB-1001'],
  ['timezone', 'Timezone', 'text', 'Asia/Dubai'],
  ['expiry_warning_days', 'Warn about expiring documents (days)', 'number', 'Licence, visa, registration, insurance'],
  ['pod_reminder_hours', 'POD reminder after (hours)', 'number', 'Used when reminders arrive in Phase 7'],
];
const STAGE: Record<string, string> = { draft: 'Draft', open: 'Waiting', active: 'In progress', delivered: 'Delivered', closed: 'Closed', cancelled: 'Cancelled' };

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
