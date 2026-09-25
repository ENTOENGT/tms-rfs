'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';

function UserForm({ user, perms, onDone, onClose }: { user?: any; perms: any[]; onDone: (msg: string) => void; onClose: () => void }) {
  const { lk } = useMe();
  const [f, setF] = useState<any>(user ? { ...user } : { full_name: '', email: '', mobile: '', role_id: '', department_id: '', overrides: [] });
  const [err, setErr] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const ov = (code: string) => f.overrides.find((o: any) => o.code === code);
  const setOv = (code: string, v: string) => setF({ ...f, overrides: [...f.overrides.filter((o: any) => o.code !== code),
    ...(v === '' ? [] : [{ code, granted: v === 'grant' }])] });
  const save = async () => {
    try {
      if (user) {
        await api(`/api/users/${user.id}`, { method: 'PATCH', body: { full_name: f.full_name, mobile: f.mobile, role_id: f.role_id, department_id: f.department_id, overrides: f.overrides } });
        onDone('Changes saved. The user will need to sign in again if their access changed.');
      } else {
        const r = await api('/api/users', { body: f });
        onDone(`User created. Temporary password: ${r.temporary_password} — share it privately; they must change it at first sign-in.`);
      }
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={user ? 'Edit user' : 'Add user'}>
        <h2>{user ? `Edit ${user.full_name}` : 'Add user'}</h2>
        {err && <div className="msg err">{err}</div>}
        <div className="grid g2">
          <label className="f"><span>Full name <em>*</em></span><input value={f.full_name} onChange={set('full_name')} /></label>
          <label className="f"><span>Email <em>*</em></span><input type="email" value={f.email} onChange={set('email')} disabled={!!user} /></label>
          <label className="f"><span>Mobile</span><input value={f.mobile ?? ''} onChange={set('mobile')} /></label>
          <label className="f"><span>Department</span><select value={f.department_id ?? ''} onChange={set('department_id')}>
            <option value="">None</option>{lk.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label className="f span2"><span>Role <em>*</em></span><select value={f.role_id} onChange={set('role_id')}>
            <option value="">Choose role</option>{lk.roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        </div>
        {user && <>
          <h2 style={{ marginTop: 16 }}>Exceptions to the role</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Leave on "From role" unless this person needs more or less than their role gives.</p>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}>
            <table className="t"><tbody>{perms.map((p) => (
              <tr key={p.code}><td>{p.name}{p.sensitivity === 'commercial' && <span className="sens">confidential</span>}</td>
                <td style={{ width: 140 }}><select value={ov(p.code) ? (ov(p.code).granted ? 'grant' : 'revoke') : ''} onChange={(e) => setOv(p.code, e.target.value)}>
                  <option value="">From role</option><option value="grant">Always allow</option><option value="revoke">Never allow</option></select></td></tr>))}
            </tbody></table>
          </div>
        </>}
        <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>{user ? 'Save changes' : 'Create user'}</button></div>
      </div>
    </div>
  );
}

export default function Users() {
  const { me, can } = useMe();
  const [users, setUsers] = useState<any[]>([]);
  const [perms, setPerms] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const load = () => api('/api/users').then(setUsers);
  useEffect(() => { load(); api('/api/roles').then((r) => setPerms(r.permissions)); }, []);
  if (!can('users.manage')) return <div className="page"><div className="msg err">You don't have permission to manage users.</div></div>;
  const act = async (fn: () => Promise<any>, ok: (r: any) => string) => {
    try { const r = await fn(); setMsg({ t: 'ok', m: ok(r) }); load(); } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>Users</h1><span className="spacer" /><button className="btn primary" onClick={() => setEdit({})}>Add user</button></div>
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Role</th><th>Exceptions</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id}>
            <td><b>{u.full_name}</b></td><td>{u.email}</td><td>{u.department_name ?? '—'}</td><td>{u.role_name}</td>
            <td>{u.overrides.length ? <span className="flag">{u.overrides.length}</span> : '—'}</td>
            <td>{fmtDateTime(u.last_login_at)}</td>
            <td>{u.is_active ? (u.must_change_password ? <span className="badge outline">Awaiting first sign-in</span> : 'Active') : <span className="badge" style={{ background: '#9B2C2C' }}>Disabled</span>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className="btn small" onClick={() => setEdit(u)}>Edit</button>{' '}
              <button className="btn small" onClick={() => confirm(`Reset password for ${u.full_name}?`) && act(() => api(`/api/users/${u.id}/reset-password`, { body: {} }), (r) => `Temporary password for ${u.full_name}: ${r.temporary_password}`)}>Reset password</button>{' '}
              {u.id !== me.id && <button className="btn small danger" onClick={() => act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }), () => `${u.full_name} ${u.is_active ? 'disabled' : 'enabled'}`)}>{u.is_active ? 'Disable' : 'Enable'}</button>}
            </td>
          </tr>))}
        </tbody></table></div></div>
      {edit && <UserForm user={edit.id ? edit : undefined} perms={perms} onClose={() => setEdit(null)} onDone={(m) => { setEdit(null); setMsg({ t: 'ok', m }); load(); }} />}
    </div>
  );
}
