'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';

type Phone = 'iphone' | 'android' | 'other';
const phoneType = (): Phone => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'iphone';
  return /Android/i.test(ua) ? 'android' : 'other';
};

/**
 * The page behind the link a manager sends by WhatsApp.
 * Step 1: choose a password. Step 2: add the app to the home screen.
 */
export default function Join({ params }: { params: { token: string } }) {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [phone, setPhone] = useState<Phone>('other');
  const [installEvt, setInstallEvt] = useState<any>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setPhone(phoneType());
    api(`/api/app-links/${params.token}`).then(setInfo).catch((e) => setErr(e.message));
    const h = (e: any) => { e.preventDefault(); setInstallEvt(e); };       // Android Chrome: our own "Install app" button
    window.addEventListener('beforeinstallprompt', h);
    window.addEventListener('appinstalled', () => setInstalled(true));
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, [params.token]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw !== pw2) { setErr('The two passwords are not the same. Type them again.'); return; }
    setBusy(true);
    try { await api(`/api/app-links/${params.token}`, { body: { password: pw } }); setDone(true); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const okLen = pw.length >= 10, okLetter = /[A-Za-z]/.test(pw), okNum = /\d/.test(pw);

  return (
    <div className="join">
      <img src="/brand/logo-on-dark.png" alt="Reliance Freight Systems LLC" width={220} height={53} className="join-logo" />
      <div className="join-card">
        {!info && !err && <p className="muted">Opening…</p>}
        {!info && err && <>
          <h1>This link can't be used</h1>
          <div className="msg err">{err}</div>
          <p className="small">Already set your password? <a href="/login">Sign in here</a> with your mobile number.</p>
        </>}

        {info && !done && <form onSubmit={save}>
          <h1>Hello {info.full_name}</h1>
          <p>Welcome to the Reliance Freight app. First, choose your password.</p>
          <p className="small muted">You will sign in with: <b>{info.sign_in_with}</b></p>
          {err && <div className="msg err">{err}</div>}
          <label className="f"><span>New password</span>
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
          <ul className="join-rules small">
            <li className={okLen ? 'ok' : ''}>At least 10 letters or numbers</li>
            <li className={okLetter ? 'ok' : ''}>At least one letter</li>
            <li className={okNum ? 'ok' : ''}>At least one number</li>
          </ul>
          <label className="f"><span>Type it again</span>
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} style={{ width: 'auto' }} /> Show password</label>
          <button className="btn primary app-big" disabled={busy || !okLen || !okLetter || !okNum || !pw2}>{busy ? 'Saving…' : 'Save password'}</button>
          <p className="small muted">Write your password down somewhere safe. If you forget it, ask your manager for a new link.</p>
        </form>}

        {done && <>
          <h1>Done ✓</h1>
          <p>Your password is saved. Now put the app on your phone's home screen:</p>
          {phone === 'android' && <>
            {installEvt && !installed && <button className="btn primary app-big" onClick={async () => { installEvt.prompt(); const c = await installEvt.userChoice; if (c.outcome === 'accepted') setInstalled(true); }}>Install the app</button>}
            {installed ? <div className="msg ok">Installed. Find <b>RFS Transport</b> on your home screen.</div> : <ol className="join-steps">
              <li>Tap the <b>⋮</b> menu (top right of Chrome).</li>
              <li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li>
              <li>Tap <b>Install</b> / <b>Add</b>.</li>
            </ol>}
          </>}
          {phone === 'iphone' && <ol className="join-steps">
            <li>This page must be open in <b>Safari</b>. (In WhatsApp, tap the link, then the Safari/compass button.)</li>
            <li>Tap the <b>Share</b> button <span aria-hidden>⬆︎</span> at the bottom.</li>
            <li>Scroll and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          </ol>}
          {phone === 'other' && <p className="small">Open this link on your <b>phone</b> to add the app to the home screen.</p>}
          <div className="msg" style={{ background: '#FFF8E6' }}>When you open the app from the home screen the first time, sign in with
            <b> {info.sign_in_with}</b> and the password you just chose. After that it stays signed in.</div>
          <a className="btn app-big" href="/">Open the app now</a>
        </>}
      </div>
    </div>
  );
}
