'use client';
import { useState } from 'react';
import { api } from '@/components/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api('/api/auth/login', { body: { email, password } });
      const next = new URLSearchParams(location.search).get('next');
      location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="login">
      <div className="art">
        <img className="mark" src="/brand/mark-on-dark.png" alt="" width={120} height={110} />
        <div>
          <h1>Operations requests it. Transport moves it. Everyone sees where it is.</h1>
          <p>Sign in with the account your administrator created for you.</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <img className="logo" src="/brand/logo.png" alt="Reliance Freight Systems LLC" width={300} height={72} />
        <h1>Sign in</h1>
        {err && <div className="msg err">{err}</div>}
        <label className="f"><span>Email or mobile number</span><input type="text" inputMode="email" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
        <label className="f"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small">Forgot your password? Ask your manager to reset it, or to send you a new app link.</p>
      </form>
    </div>
  );
}
