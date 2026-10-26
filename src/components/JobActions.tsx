'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate } from './api';
import { useMe } from './Shell';

/** ISO instant -> "YYYY-MM-DDTHH:MM" in the company timezone, for datetime-local inputs. */
export function toLocalInput(iso: string | null | undefined, tz: string) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const nowLocal = (tz: string) => toLocalInput(new Date().toISOString(), tz);
const hhmm = (iso: string, tz: string) => toLocalInput(iso, tz).slice(11);


function Picker({ label, items, value, onPick, disabled, render }: {
  label: string; items: any[]; value: string; onPick: (id: string) => void; disabled?: boolean; render: (x: any) => [string, string];
}) {
  const { lk } = useMe();
  const tz = lk.timezone;
  const chip = (x: any) => {
    if (x.blocked) {
      const why = x.status && !['available', 'assigned'].includes(x.status) ? x.status.replace('_', ' ') : 'documents expired';
      return <span className="badge" style={{ background: '#9B2C2C' }}>{why}</span>;
    }
    if (x.conflicts.length) return <span className="flag">Busy {x.conflicts.map((c: any) => `${c.job_number} ${hhmm(c.from, tz)}–${hhmm(c.to, tz)}`).join(', ')}</span>;
    return <span className="badge" style={{ background: '#276749' }}>Free</span>;
  };
  return (
    <div>
      <div className="small" style={{ fontWeight: 500, marginBottom: 4 }}>{label}</div>
      <div role="radiogroup" aria-label={label} style={{ border: '1px solid var(--line)', borderRadius: 4, maxHeight: 250, overflowY: 'auto', opacity: disabled ? 0.6 : 1 }}>
        {[{ id: '' }, ...items].map((x: any) => {
          const on = value === x.id;
          const [main, sub] = x.id ? render(x) : [`No ${label.toLowerCase()} yet`, ''];
          return (
            <button type="button" key={x.id || 'none'} role="radio" aria-checked={on} disabled={disabled} onClick={() => onPick(x.id)}
              style={{ all: 'unset', boxSizing: 'border-box', display: 'flex', gap: 8, alignItems: 'center', width: '100%', padding: '7px 10px', cursor: disabled ? 'default' : 'pointer',
                borderBottom: '1px solid var(--line-soft)', background: on ? '#fdf6e3' : undefined, boxShadow: on ? 'inset 3px 0 0 var(--brand-gold)' : undefined }}>
              <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontWeight: on ? 600 : 500 }}>{main}</b>{sub && <span className="muted small"> · {sub}</span>}</span>
              {x.id && chip(x)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AssignDialog({ job, onDone, onClose }: { job: any; onDone: (j: any) => void; onClose: () => void }) {
  const { lk, me } = useMe();
  const tz = lk.timezone;
  const def = job.planned_pickup_at ? toLocalInput(job.planned_pickup_at, tz) : `${job.required_date}T${(job.slot_from ?? '09:00').slice(0, 5)}`;
  const defEta = job.planned_delivery_at ? toLocalInput(job.planned_delivery_at, tz) : job.slot_to ? `${job.required_date}T${job.slot_to.slice(0, 5)}` : '';
  const [f, setF] = useState({ driver_id: job.driver_id ?? '', vehicle_id: job.vehicle_id ?? '', planned_pickup_at: def, planned_delivery_at: defEta });
  const [av, setAv] = useState<any>(null);
  const [issues, setIssues] = useState<{ list: any[]; code: string; canOverride: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const canDriver = me.permissions.includes('jobs.assign_driver'), canVehicle = me.permissions.includes('jobs.assign_vehicle');

  useEffect(() => {
    if (!f.planned_pickup_at) return;
    const qs = new URLSearchParams({ from: f.planned_pickup_at, exclude_job: job.id, ...(f.planned_delivery_at ? { to: f.planned_delivery_at } : {}) });
    const t = setTimeout(() => api(`/api/availability?${qs}`).then(setAv).catch((e) => setErr(e.message)), 250);
    return () => clearTimeout(t);
  }, [f.planned_pickup_at, f.planned_delivery_at]);

  const submit = async (extra: any = {}) => {
    setBusy(true); setErr('');
    try { onDone(await api(`/api/jobs/${job.id}/assign`, { body: { ...f, ...extra } })); }
    catch (e: any) {
      if (e.code === 'ASSIGNMENT_BLOCKED' || e.code === 'ASSIGNMENT_WARNINGS')
        setIssues({ list: e.details.issues, code: e.code, canOverride: e.details.can_override });
      else setErr(e.message);
      setBusy(false);
    }
  };
  const set = (k: string) => (e: any) => { setIssues(null); setF({ ...f, [k]: e.target.value }); };
  const pickVehicle = (id: string) => {
    const v = av?.vehicles.find((x: any) => x.id === id);
    setIssues(null);
    setF({ ...f, vehicle_id: id, driver_id: f.driver_id || v?.default_driver_id || '' });
  };
  const wantType = job.requested_vehicle_type_id;
  const vehicles = av ? [...av.vehicles].sort((a: any, b: any) => Number(b.vehicle_type_id === wantType) - Number(a.vehicle_type_id === wantType)) : [];

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Assign driver and vehicle" style={{ width: 'min(860px, 100%)' }}>
        <h2>{job.driver_id || job.vehicle_id ? 'Change assignment' : 'Assign driver and vehicle'} — Job No. {job.job_no ?? job.job_number}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Required {fmtDate(job.required_date)}{job.slot_from ? `, ${job.slot_from.slice(0, 5)}–${(job.slot_to ?? '').slice(0, 5)}` : ''}
          {job.requested_vehicle_type ? ` · asked for ${job.requested_vehicle_type}` : ''}{job.weight_kg ? ` · ${Number(job.weight_kg)} kg` : ''}
        </p>
        {err && <div className="msg err">{err}</div>}
        <div className="grid g2">
          <label className="f"><span>Planned pickup <em>*</em></span><input type="datetime-local" value={f.planned_pickup_at} onChange={set('planned_pickup_at')} /></label>
          <label className="f"><span>Delivery ETA</span><input type="datetime-local" value={f.planned_delivery_at} onChange={set('planned_delivery_at')} /></label>
        </div>
        <div className="grid g2" style={{ marginTop: 12 }}>
          <Picker label="Vehicle" items={vehicles} value={f.vehicle_id} disabled={!canVehicle || !av} onPick={pickVehicle}
            render={(v) => [v.vehicle_number, [v.vehicle_type ?? 'no type', v.weight_capacity_kg ? `${Number(v.weight_capacity_kg)} kg` : ''].filter(Boolean).join(' · ')]} />
          <Picker label="Driver" items={av?.drivers ?? []} value={f.driver_id} disabled={!canDriver || !av} onPick={(id) => { setIssues(null); setF({ ...f, driver_id: id }); }}
            render={(d) => [d.full_name, d.mobile ?? '']} />
        </div>
        {!av && f.planned_pickup_at && <p className="muted small">Checking availability…</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>Availability is for the times above. Picking a truck fills in its usual driver.</p>
        {av && av.drivers.length === 0 && <div className="msg warn">No drivers yet. <Link href="/drivers">Add drivers</Link> first.</div>}
        {av && av.vehicles.length === 0 && <div className="msg warn">No vehicles yet. <Link href="/vehicles">Add vehicles</Link> first.</div>}
        {issues && (
          <div className={`msg ${issues.code === 'ASSIGNMENT_BLOCKED' ? 'err' : 'warn'}`} style={{ marginTop: 12 }}>
            {issues.list.map((i, n) => <div key={n}>{i.level === 'blocking' ? '✕ ' : '! '}{i.message}</div>)}
            {issues.code === 'ASSIGNMENT_BLOCKED' && !issues.canOverride && <div style={{ marginTop: 6 }}>Choose another driver/vehicle or time, or ask an admin to override.</div>}
          </div>
        )}
        <div className="actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          {issues?.code === 'ASSIGNMENT_WARNINGS' && <button className="btn primary" disabled={busy} onClick={() => submit({ confirm_warnings: true })}>Assign anyway</button>}
          {issues?.code === 'ASSIGNMENT_BLOCKED' && issues.canOverride && <button className="btn danger" disabled={busy} onClick={() => submit({ override_conflicts: true })}>Override and assign</button>}
          {!issues && <button className="btn primary" disabled={busy || !f.planned_pickup_at || (!f.driver_id && !f.vehicle_id)} onClick={() => submit()}>Assign</button>}
        </div>
      </div>
    </div>
  );
}

function StatusDialog({ job, to, onDone, onClose }: { job: any; to: any; onDone: (j: any) => void; onClose: () => void }) {
  const { lk } = useMe();
  const timed = ['picked_up', 'delivered'].includes(to.code);
  const [at, setAt] = useState(nowLocal(lk.timezone));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    try { onDone(await api(`/api/jobs/${job.id}/status`, { body: { to: to.code, at: timed ? at : undefined, reason: to.code === 'cancelled' ? reason : undefined } })); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={to.name}>
        <h2>{to.code === 'cancelled' ? `Cancel Job No. ${job.job_no ?? job.job_number}?` : `Mark Job No. ${job.job_no ?? job.job_number} as ${to.name}`}</h2>
        {err && <div className="msg err">{err}</div>}
        {timed && <label className="f"><span>{to.code === 'delivered' ? 'Delivered at' : 'Picked up at'}</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>}
        {to.code === 'cancelled' && <>
          <p className="muted small" style={{ marginTop: 0 }}>The job stays in history and reports as cancelled.{job.driver_id ? ' The driver and vehicle become free for this slot, and Transport is notified.' : ''}</p>
          <label className="f"><span>Reason <em>*</em></span><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer postponed to next week" /></label>
        </>}
        {to.code === 'pending_assignment' && job.driver_id && <p className="muted small">This removes the driver and vehicle and puts the job back in Transport's queue.</p>}
        <div className="actions"><button className="btn" onClick={onClose}>Back</button>
          <button className={`btn ${to.code === 'cancelled' ? 'danger' : 'primary'}`} onClick={go}>{to.code === 'cancelled' ? 'Cancel job' : `Mark ${to.name}`}</button></div>
      </div>
    </div>
  );
}

export default function JobActions({ job, onChange }: { job: any; onChange: (j: any) => void }) {
  const [dialog, setDialog] = useState<any>(null);
  const [err, setErr] = useState('');
  const perms = job.permissions;
  const forward = job.next_statuses.filter((s: any) => !['cancelled', 'pending_assignment'].includes(s.code) || (s.code === 'pending_assignment' && job.status_code === 'draft'));
  const back = job.next_statuses.find((s: any) => s.code === 'pending_assignment' && job.status_code !== 'draft');
  const cancel = job.next_statuses.find((s: any) => s.code === 'cancelled');
  const podNeeded = ['delivered', 'pod_pending'].includes(job.status_code) && ['pending', 'rejected'].includes(job.pod_status);
  const togglePod = async (v: boolean) => { try { onChange(await api(`/api/jobs/${job.id}/pod-requirement`, { body: { not_required: v } })); } catch (e: any) { setErr(e.message); } };
  const done = (j: any) => { setDialog(null); onChange(j); };
  const any = perms.assign || forward.length || back || cancel || perms.edit_request || (perms.pod_requirement && ['pending', 'rejected', 'not_required'].includes(job.pod_status));
  if (!any) return null;
  return (
    <>
      {err && <div className="msg err">{err}</div>}
      <div className="panel" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        {perms.assign && <button className="btn primary" onClick={() => setDialog({ kind: 'assign' })}>{job.driver_id || job.vehicle_id ? 'Change assignment' : 'Assign driver & vehicle'}</button>}
        {forward.map((s: any, i: number) => <button key={s.code} className={`btn${!perms.assign && i === 0 ? ' primary' : ''}`} onClick={() => setDialog({ kind: 'status', to: s })}>
          {s.code === 'pending_assignment' ? 'Submit to Transport' : `Mark ${s.name}`}</button>)}
        {perms.edit_request && <Link className="btn" href={`/jobs/${job.id}/edit`}>Edit request</Link>}
        {back && (job.driver_id || job.vehicle_id) && <button className="btn" onClick={() => setDialog({ kind: 'status', to: back })}>Unassign</button>}
        {perms.pod_requirement && ['pending', 'rejected'].includes(job.pod_status) && <button className="btn" onClick={() => togglePod(true)}>POD not required</button>}
        {perms.pod_requirement && job.pod_status === 'not_required' && <button className="btn" onClick={() => togglePod(false)}>Require POD</button>}
        <span style={{ flex: 1 }} />
        {cancel && <button className="btn danger" onClick={() => setDialog({ kind: 'status', to: cancel })}>Cancel job</button>}
        {podNeeded && <span className="flag" style={{ width: '100%' }}>Delivered — waiting for the POD. Upload it in the Proof of delivery panel.</span>}
      </div>
      {dialog?.kind === 'assign' && <AssignDialog job={job} onDone={done} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'status' && <StatusDialog job={job} to={dialog.to} onDone={done} onClose={() => setDialog(null)} />}
    </>
  );
}
