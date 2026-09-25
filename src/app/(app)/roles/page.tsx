'use client';
import { Fragment, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';

export default function Roles() {
  const { can } = useMe();
  const [data, setData] = useState<{ roles: any[]; permissions: any[] } | null>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [msg, setMsg] = useState<{ t: string; m: string } | null>(null);
  const load = () => api('/api/roles').then((d) => {
    setData(d); setDraft(Object.fromEntries(d.roles.map((r: any) => [r.id, new Set(r.permissions)])));
  });
  useEffect(() => { load(); }, []);
  if (!can('roles.manage')) return <div className="page"><div className="msg err">You don't have permission to manage roles.</div></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const toggle = (rid: string, code: string) => { const s = new Set(draft[rid]); s.has(code) ? s.delete(code) : s.add(code); setDraft({ ...draft, [rid]: s }); };
  const dirty = (r: any) => r.code !== 'super_admin' && [...draft[r.id]].sort().join() !== [...r.permissions].sort().join();
  const save = async (r: any) => {
    try { await api(`/api/roles/${r.id}`, { method: 'PUT', body: { permissions: [...draft[r.id]] } });
      setMsg({ t: 'ok', m: `${r.name} saved. Its ${r.user_count} user(s) will be asked to sign in again.` }); load();
    } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const addRole = async () => {
    const name = prompt('Name for the new role'); if (!name) return;
    try { await api('/api/roles', { body: { name } }); load(); } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const modules = [...new Set(data.permissions.map((p) => p.module))];
  return (
    <div className="page">
      <div className="page-head"><h1>Roles & permissions</h1><span className="spacer" /><button className="btn" onClick={addRole}>Add role</button></div>
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="msg warn">Profit is only ever shown to someone who can see both the selling price and the transport cost, whatever is ticked here — otherwise it would reveal the other figure.</div>
      <div className="panel flush"><div className="table-wrap"><table className="t perm-matrix">
        <thead><tr><th>Permission</th>{data.roles.map((r) => <th key={r.id}>{r.name}<div className="muted small">{r.user_count} user(s)</div></th>)}</tr></thead>
        <tbody>
          {modules.map((m) => <Fragment key={m}>
            <tr><td colSpan={data.roles.length + 1} style={{ background: '#f7f9f9', fontWeight: 600 }}>{m}</td></tr>
            {data.permissions.filter((p) => p.module === m).map((p) => (
              <tr key={p.code}><td>{p.name}{p.sensitivity === 'commercial' && <span className="sens">confidential</span>}</td>
                {data.roles.map((r) => <td key={r.id}><input type="checkbox" aria-label={`${r.name}: ${p.name}`} disabled={r.code === 'super_admin'}
                  checked={r.code === 'super_admin' || draft[r.id]?.has(p.code)} onChange={() => toggle(r.id, p.code)} /></td>)}</tr>))}
          </Fragment>)}
          <tr><td />{data.roles.map((r) => <td key={r.id}>{dirty(r) && <button className="btn small primary" onClick={() => save(r)}>Save</button>}</td>)}</tr>
        </tbody></table></div></div>
    </div>
  );
}
