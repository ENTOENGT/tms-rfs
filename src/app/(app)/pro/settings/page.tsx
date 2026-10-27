'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';

/** Authorities, activity types, status names and reminder hours — changed by the Documentation Manager or Super Admin. */
export default function ProSettings() {
  const [c, setC] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: string; m: string } | null>(null);
  const [newAuth, setNewAuth] = useState('');
  const [newType, setNewType] = useState('');
  useEffect(() => { api('/api/pro/config').then(setC).catch((e) => setMsg({ t: 'err', m: e.message })); }, []);
  const save = async (b: any, ok = 'Saved') => {
    try { setC(await api('/api/pro/config', { body: b })); setMsg({ t: 'ok', m: ok }); } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  if (!c) return <div className="page muted">{msg?.m ?? 'Loading…'}</div>;
  const ro = !c.can_configure;
  const Row = ({ name, active, onToggle, onRename }: any) => (
    <tr><td><input defaultValue={name} disabled={ro} onBlur={(e) => e.target.value.trim() && e.target.value !== name && onRename(e.target.value.trim())} /></td>
      <td style={{ width: 130 }}><label className="small"><input type="checkbox" style={{ width: 'auto' }} disabled={ro} checked={active} onChange={(e) => onToggle(e.target.checked)} /> In use</label></td></tr>);
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head"><h1>PRO settings</h1><span className="spacer" /><Link className="btn" href="/pro">Back to PRO</Link></div>
      {ro && <div className="msg">Only the Documentation Manager or Super Admin can change these.</div>}
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="cols">
        <div>
          <div className="panel"><h2>Authorities</h2>
            <table className="t"><tbody>{c.authorities.map((a: any) => <Row key={a.id} name={a.name} active={a.is_active}
              onToggle={(v: boolean) => save({ kind: 'authority', id: a.id, is_active: v })} onRename={(n: string) => save({ kind: 'authority', id: a.id, name: n })} />)}</tbody></table>
            {!ro && <div style={{ display: 'flex', gap: 6, marginTop: 8 }}><input value={newAuth} onChange={(e) => setNewAuth(e.target.value)} placeholder="New authority" />
              <button className="btn" disabled={!newAuth.trim()} onClick={() => save({ kind: 'authority', name: newAuth }, 'Authority added').then(() => setNewAuth(''))}>Add</button></div>}</div>
        </div>
        <div>
          <div className="panel"><h2>Activity types</h2>
            <table className="t"><tbody>{c.activity_types.map((t: any) => <Row key={t.code} name={t.name} active={t.is_active}
              onToggle={(v: boolean) => save({ kind: 'activity_type', code: t.code, existing: true, is_active: v })} onRename={(n: string) => save({ kind: 'activity_type', code: t.code, existing: true, name: n })} />)}</tbody></table>
            {!ro && <div style={{ display: 'flex', gap: 6, marginTop: 8 }}><input value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="New activity type" />
              <button className="btn" disabled={!newType.trim()} onClick={() => save({ kind: 'activity_type', name: newType }, 'Activity type added').then(() => setNewType(''))}>Add</button></div>}</div>
          <div className="panel"><h2>Statuses</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Rename, or switch off ones you don't use. Draft, Pending Assignment, Assigned, On Hold, Cancelled and Completed are always needed.</p>
            <table className="t"><tbody>{c.statuses.map((s: any) => <Row key={s.code} name={s.name} active={s.is_active}
              onToggle={(v: boolean) => save({ kind: 'status', code: s.code, is_active: v })} onRename={(n: string) => save({ kind: 'status', code: s.code, name: n })} />)}</tbody></table></div>
          <div className="panel"><h2>Reminders and escalation</h2>
            <div className="grid g2">
              <label className="f"><span>Warn before deadline (hours)</span><input type="number" min="0" disabled={ro} defaultValue={c.settings.pro_deadline_warning_hours}
                onBlur={(e) => save({ kind: 'settings', pro_deadline_warning_hours: e.target.value })} /></label>
              <label className="f"><span>Escalate to PRO supervisor after deadline (hours)</span><input type="number" min="0" disabled={ro} defaultValue={c.settings.pro_escalate_after_hours}
                onBlur={(e) => save({ kind: 'settings', pro_escalate_after_hours: e.target.value })} /></label>
            </div>
            <p className="muted small">Checked every hour automatically. The officer and requester get the warning; PRO supervisors get the escalation.</p></div>
        </div>
      </div>
    </div>
  );
}
