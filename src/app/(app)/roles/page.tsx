'use client';
import { Fragment, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';

const SIDES: [string, string][] = [['operations', 'Operations'], ['transport', 'Transport'], ['messenger', 'Messengers'], ['pro', 'PRO'], ['finance', 'Finance'], ['admin', 'Administration']];

export default function Roles() {
  const { can } = useMe();
  const [data, setData] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [side, setSide] = useState('operations');
  const [adding, setAdding] = useState<{ name: string; side: string } | null>(null);
  const [msg, setMsg] = useState<{ t: string; m: string } | null>(null);
  const load = () => api('/api/roles').then((d) => {
    setData(d); setDraft(Object.fromEntries(d.roles.map((r: any) => [r.id, new Set(r.permissions)])));
  }).catch((e) => setMsg({ t: 'err', m: e.message }));
  useEffect(() => { load(); }, []);
  if (!can('roles.manage') && !can('roles.manage_department')) return <div className="page"><div className="msg err">You don't have permission to manage roles.</div></div>;
  if (!data) return <div className="page muted">{msg ? <div className="msg err">{msg.m}</div> : 'Loading…'}</div>;
  const all = data.scope === 'all';
  const shown = all ? data.roles.filter((r: any) => r.side === side || (side === 'admin' && !r.side)) : data.roles;
  const toggle = (rid: string, code: string) => { const s = new Set(draft[rid]); s.has(code) ? s.delete(code) : s.add(code); setDraft({ ...draft, [rid]: s }); };
  const dirty = (r: any) => r.editable && [...draft[r.id]].sort().join() !== [...r.permissions].sort().join();
  const save = async (r: any) => {
    try { await api(`/api/roles/${r.id}`, { method: 'PUT', body: { permissions: [...draft[r.id]] } });
      setMsg({ t: 'ok', m: `${r.name} saved. Its ${r.user_count} user(s) will be asked to sign in again.` }); load();
    } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const add = async () => {
    try { await api('/api/roles', { body: adding }); setAdding(null); setMsg({ t: 'ok', m: `Role "${adding!.name}" added. Tick its permissions below and save.` }); load(); }
    catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const blocked = (r: any, p: any) => p.sensitivity === 'commercial' && ['transport', 'messenger', 'pro'].includes(r.side);
  const modules = [...new Set(data.permissions.map((p: any) => p.module))] as string[];
  return (
    <div className="page">
      <div className="page-head"><h1>{all ? 'Roles & permissions' : `Roles — ${data.department.name}`}</h1><span className="spacer" />
        {all && <select value={side} onChange={(e) => setSide(e.target.value)} style={{ width: 170 }} aria-label="Side">
          {SIDES.map(([k, l]) => <option key={k} value={k}>{l} roles</option>)}</select>}
        <button className="btn" onClick={() => setAdding({ name: '', side: all ? side : data.department.side })}>Add role</button></div>
      {!all && <p className="muted small" style={{ marginTop: -6 }}>Roles you add here are only for {data.department.name}. You can give a role only the permissions you have yourself. Shared roles are shown for reference and can only be changed by the Super Admin.</p>}
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="msg warn">Selling price, revenue, profit and customer documents can never reach Transport or Messenger users, whatever is ticked. Profit is only shown to someone who can see both the selling price and the cost.</div>
      <div className="panel flush"><div className="table-wrap"><table className="t perm-matrix">
        <thead><tr><th>Permission</th>{shown.map((r: any) => <th key={r.id}>{r.name}
          <div className="muted small">{r.department_name ?? (r.is_manager ? 'Department admin' : 'Shared')} · {r.user_count} user(s)</div></th>)}</tr></thead>
        <tbody>
          {modules.map((m) => <Fragment key={m}>
            <tr><td colSpan={shown.length + 1} style={{ background: '#f7f6f3', fontWeight: 600 }}>{m}</td></tr>
            {data.permissions.filter((p: any) => p.module === m).map((p: any) => (
              <tr key={p.code}><td>{p.name}{p.sensitivity === 'commercial' && <span className="sens">confidential</span>}</td>
                {shown.map((r: any) => <td key={r.id}><input type="checkbox" aria-label={`${r.name}: ${p.name}`}
                  disabled={!r.editable || blocked(r, p)} title={blocked(r, p) ? 'Never available on this side' : undefined}
                  checked={r.code === 'super_admin' || (!blocked(r, p) && !!draft[r.id]?.has(p.code))} onChange={() => toggle(r.id, p.code)} /></td>)}</tr>))}
          </Fragment>)}
          <tr><td />{shown.map((r: any) => <td key={r.id}>{dirty(r) && <button className="btn small primary" onClick={() => save(r)}>Save</button>}</td>)}</tr>
        </tbody></table></div></div>
      {shown.length === 0 && <p className="muted">No roles here yet.</p>}
      {adding && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAdding(null)}>
        <div className="modal" role="dialog" aria-label="Add role">
          <h2>Add role{!all && ` for ${data.department.name}`}</h2>
          <div className="grid g2">
            <label className="f span2"><span>Role name</span><input autoFocus value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. Senior Clerk" /></label>
            {all && <label className="f span2"><span>For which side</span><select value={adding.side} onChange={(e) => setAdding({ ...adding, side: e.target.value })}>
              {SIDES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <span className="muted small" style={{ fontWeight: 400, marginTop: 4 }}>Managers on that side can then give this role to their staff.</span></label>}
          </div>
          <div className="actions"><button className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn primary" disabled={!adding.name.trim()} onClick={add}>Add role</button></div>
        </div></div>}
    </div>
  );
}
