'use client';
import SendAppLink from '@/components/SendAppLink';
import { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';

const SIDE: Record<string, string> = { admin: 'Administration', operations: 'Operations', transport: 'Transport', messenger: 'Messengers', finance: 'Finance' };

function UserForm({ user, data, onDone, onClose }: { user?: any; data: any; onDone: (msg: string, sendApp?: any) => void; onClose: () => void }) {
  const all = data.scope === 'all';
  const [f, setF] = useState<any>(user ? { ...user } : {
    full_name: '', email: '', mobile: '', role_id: '', department_id: all ? '' : data.department.id, overrides: [] });
  const [err, setErr] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, ...(k === 'department_id' ? { role_id: '' } : {}) });
  const dept = data.departments.find((d: any) => d.id === f.department_id);
  // Only roles that fit the chosen department (same side, and either shared or this department's own)
  const roles = data.roles.filter((r: any) => dept && (r.code === 'super_admin' ? dept.side === 'admin'
    : (!r.side || r.side === dept.side) && (!r.department_id || r.department_id === dept.id))
    // drivers are added on the Drivers page (so jobs can be assigned to them), then sent the app from there
    && (r.code !== 'driver' || user?.role_code === 'driver'));
  const appRole = !!data.roles.find((r: any) => r.id === f.role_id)?.app_only;
  const ov = (code: string) => f.overrides.find((o: any) => o.code === code);
  const setOv = (code: string, v: string) => setF({ ...f, overrides: [...f.overrides.filter((o: any) => o.code !== code),
    ...(v === '' ? [] : [{ code, granted: v === 'grant' }])] });
  // One simple choice for the setting managers change most: the selling price.
  const SELL = ['finance.selling.view', 'finance.profit.view', 'documents.view_commercial'], SELL_EDIT = 'finance.selling.edit';
  const showSell = dept?.side === 'operations' && data.permissions.some((p: any) => p.code === SELL_EDIT);
  const sell = ov(SELL[0])?.granted === false ? 'no' : ov(SELL[0])?.granted ? (ov(SELL_EDIT)?.granted ? 'edit' : 'view') : '';
  const setSell = (v: string) => {
    const codes = [...SELL, SELL_EDIT];
    const rest = f.overrides.filter((o: any) => !codes.includes(o.code));
    const add = v === 'view' ? SELL.map((code) => ({ code, granted: true }))
      : v === 'edit' ? codes.map((code) => ({ code, granted: true }))
      : v === 'no' ? codes.map((code) => ({ code, granted: false })) : [];
    setF({ ...f, overrides: [...rest, ...add] });
  };
  const save = async () => {
    try {
      if (user) {
        await api(`/api/users/${user.id}`, { method: 'PATCH', body: { full_name: f.full_name, mobile: f.mobile, role_id: f.role_id,
          ...(all ? { department_id: f.department_id } : {}), overrides: f.overrides } });
        onDone(`Changes saved for ${f.full_name}. They will be asked to sign in again if their access changed.`);
      } else {
        const r = await api('/api/users', { body: f });
        if (appRole) onDone(`${f.full_name} added.`, { id: r.id, full_name: f.full_name });     // goes straight to "Send app link"
        else onDone(`${f.full_name} added. Temporary password: ${r.temporary_password} — give it to them privately. They choose their own password at first sign-in.`);
      }
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={user ? 'Edit user' : 'Add user'}>
        <h2>{user ? `Edit ${user.full_name}` : all ? 'Add user' : `Add user to ${data.department.name}`}</h2>
        {err && <div className="msg err">{err}</div>}
        <div className="grid g2">
          <label className="f"><span>Full name <em>*</em></span><input value={f.full_name} onChange={set('full_name')} /></label>
          <label className="f"><span>Email {appRole ? <small className="muted">(optional)</small> : <em>*</em>}</span><input type="email" value={f.email} onChange={set('email')} disabled={!!user} /></label>
          <label className="f"><span>Mobile {appRole && <em>*</em>}</span><input value={f.mobile ?? ''} onChange={set('mobile')} placeholder={appRole ? 'They sign in to the phone app with this' : ''} /></label>
          {all ? <label className="f"><span>Department <em>*</em></span><select value={f.department_id ?? ''} onChange={set('department_id')}>
              <option value="">Choose department</option>
              {Object.keys(SIDE).map((side) => {
                const ds = data.departments.filter((d: any) => d.side === side);
                return ds.length ? <optgroup key={side} label={SIDE[side]}>{ds.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</optgroup> : null;
              })}</select></label>
            : <label className="f"><span>Department</span><input value={data.department.name} disabled /></label>}
          <label className="f span2"><span>Role <em>*</em></span><select value={f.role_id} onChange={set('role_id')} disabled={all && !f.department_id}>
            <option value="">{all && !f.department_id ? 'Choose the department first' : 'Choose role'}</option>
            {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}{r.is_manager ? ' (department admin)' : ''}</option>)}</select></label>
        </div>
        {user && showSell && <label className="f" style={{ marginTop: 14 }}><span>Selling price, revenue and profit</span>
          <select value={sell} onChange={(e) => setSell(e.target.value)}>
            <option value="">As the role gives</option><option value="view">Can see them</option>
            <option value="edit">Can see them and enter the selling price</option><option value="no">Cannot see them</option></select></label>}
        {user && <>
          <h2 style={{ marginTop: 16 }}>Exceptions to the role</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Leave on "From role" unless this person needs more or less than their role gives.
            {!all && ' You can only give permissions you have yourself.'}</p>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}>
            <table className="t"><tbody>{data.permissions.map((p: any) => (
              <tr key={p.code}><td>{p.name}{p.sensitivity === 'commercial' && <span className="sens">confidential</span>}</td>
                <td style={{ width: 140 }}><select value={ov(p.code) ? (ov(p.code).granted ? 'grant' : 'revoke') : ''} onChange={(e) => setOv(p.code, e.target.value)}>
                  <option value="">From role</option><option value="grant">Always allow</option><option value="revoke">Never allow</option></select></td></tr>))}
            </tbody></table>
          </div>
          {dept && ['transport', 'messenger'].includes(dept.side) && <p className="muted small">Selling price, revenue and profit can never be given to anyone on the {SIDE[dept.side]} side.</p>}
        </>}
        <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>{user ? 'Save changes' : 'Add user'}</button></div>
      </div>
    </div>
  );
}

export default function Users() {
  const { me, can } = useMe();
  const [data, setData] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const [appFor, setAppFor] = useState<any>(null);
  const load = () => api('/api/users').then(setData).catch((e) => setMsg({ t: 'err', m: e.message }));
  useEffect(() => { load(); }, []);
  const rows = useMemo(() => (data?.users ?? []).filter((u: any) => !q || `${u.full_name} ${u.email} ${u.department_name} ${u.role_name}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (!can('users.manage') && !can('users.manage_department')) return <div className="page"><div className="msg err">You don't have permission to manage users.</div></div>;
  if (!data) return <div className="page muted">{msg ? <div className="msg err">{msg.m}</div> : 'Loading…'}</div>;
  const act = async (fn: () => Promise<any>, ok: (r: any) => string) => {
    try { const r = await fn(); setMsg({ t: 'ok', m: ok(r) }); load(); } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
    window.scrollTo(0, 0);
  };
  return (
    <div className="page">
      <div className="page-head"><h1>{data.scope === 'all' ? 'Users' : `Users — ${data.department.name}`}</h1><span className="spacer" />
        <input style={{ width: 220 }} placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        <button className="btn primary" onClick={() => setEdit({})}>Add user</button></div>
      {data.scope === 'department' && <p className="muted small" style={{ marginTop: -6 }}>You manage the users of {data.department.name}. Managers are added and changed by the Super Admin.</p>}
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Name</th><th>Email / mobile</th><th>Department</th><th>Role</th><th>Exceptions</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((u: any) => (
          <tr key={u.id}>
            <td><b>{u.full_name}</b>{u.app_only && <div className="muted small">Phone app</div>}</td>
            <td>{u.app_only && u.mobile ? u.mobile : u.email}</td>
            <td>{u.department_name ?? <span className="flag">No department</span>}</td>
            <td>{u.role_name}{u.is_manager && <span className="badge outline" style={{ marginLeft: 6 }}>Manager</span>}</td>
            <td>{u.overrides.length ? <span className="flag">{u.overrides.length}</span> : '—'}</td>
            <td>{fmtDateTime(u.last_login_at)}</td>
            <td>{u.is_active ? (u.must_change_password ? <span className="badge outline">{u.app_only ? 'App not set up yet' : 'Awaiting first sign-in'}</span> : 'Active') : <span className="badge" style={{ background: '#9B2C2C' }}>Disabled</span>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{u.can_edit && <>
              <button className="btn small" onClick={() => setEdit(u)}>Edit</button>{' '}
              {u.app_only
                ? u.is_active && <><button className="btn small" onClick={() => setAppFor(u)}>Send app link</button>{' '}</>
                : <><button className="btn small" onClick={() => confirm(`Reset password for ${u.full_name}?`) && act(() => api(`/api/users/${u.id}/reset-password`, { body: {} }), (r) => `Temporary password for ${u.full_name}: ${r.temporary_password}`)}>Reset password</button>{' '}</>}
              {u.id !== me.id && <button className="btn small danger" onClick={() => act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }), () => `${u.full_name} ${u.is_active ? 'disabled' : 'enabled'}`)}>{u.is_active ? 'Disable' : 'Enable'}</button>}
            </>}</td>
          </tr>))}
          {rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 24, textAlign: 'center' }}>{q ? 'Nobody matches that search.' : 'No users yet.'}</td></tr>}
        </tbody></table></div></div>
      {appFor && <SendAppLink userId={appFor.id} name={appFor.full_name} onClose={() => { setAppFor(null); load(); }} />}
      {edit && <UserForm user={edit.id ? edit : undefined} data={data} onClose={() => setEdit(null)} onDone={(m, app) => { setEdit(null); setMsg({ t: 'ok', m }); load(); if (app) setAppFor(app); }} />}
    </div>
  );
}
