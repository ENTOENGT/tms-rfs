'use client';
import { useState } from 'react';
import { api } from '@/components/api';

export default function ChangePassword() {
  const [f, setF] = useState({ current_password: '', new_password: '', confirm: '' });
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (f.new_password !== f.confirm) return setErr('The two new passwords do not match');
    try { await api('/api/auth/password', { body: f }); location.href = '/dashboard'; } catch (e: any) { setErr(e.message); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="login">
      <div className="art"><h1>Set your own password</h1><p>You signed in with a temporary password. Choose a new one to continue.</p></div>
      <form onSubmit={submit}>
        <h1>New password</h1>
        {err && <div className="msg err">{err}</div>}
        <label className="f"><span>Current (temporary) password</span><input type="password" autoComplete="current-password" value={f.current_password} onChange={set('current_password')} required /></label>
        <label className="f"><span>New password</span><input type="password" autoComplete="new-password" value={f.new_password} onChange={set('new_password')} required /></label>
        <label className="f"><span>Repeat new password</span><input type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} required /></label>
        <p className="muted small" style={{ margin: 0 }}>At least 10 characters, including a letter and a number.</p>
        <button className="btn primary">Save password</button>
      </form>
    </div>
  );
}
