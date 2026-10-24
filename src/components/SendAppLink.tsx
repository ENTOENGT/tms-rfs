'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

/** UAE numbers written locally (050…, 50…) → international digits for WhatsApp (97150…). */
export function waNumber(mobile?: string | null) {
  let d = String(mobile ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = '971' + d.slice(1);
  if (d.length === 9 && d.startsWith('5')) d = '971' + d;
  return d.length >= 10 ? d : '';
}

/**
 * "Send app link": makes a one-time link and lets the manager send it by WhatsApp or copy it.
 * Pass driverId (Drivers page) or userId (Users page).
 */
export default function SendAppLink({ driverId, userId, name, onClose }: { driverId?: string; userId?: string; name: string; onClose: (changed: boolean) => void }) {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api('/api/app-links', { body: driverId ? { driver_id: driverId } : { user_id: userId } }).then(setR).catch((e) => setErr(e.message));
  }, []);
  const url = r ? `${location.origin}${r.path}` : '';
  const text = r ? `Hello ${r.full_name},\n\nThis is your Reliance Freight app.\n1. Open this link on your phone: ${url}\n2. Choose a password.\n3. Add the app to your home screen.\n\nYou sign in with: ${r.sign_in_with}\nThe link works once, for ${r.valid_days} days.` : '';
  const wa = r ? waNumber(r.mobile) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { const t = document.getElementById('app-link-text') as HTMLTextAreaElement | null; t?.select(); document.execCommand?.('copy'); setCopied(true); }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose(!!r)}>
      <div className="modal" role="dialog" aria-label="Send app link">
        <h2>Send the phone app to {name}</h2>
        {!r && !err && <p className="muted">Making the link…</p>}
        {err && <div className="msg err">{err}</div>}
        {r && <>
          <p className="small" style={{ marginTop: 0 }}>Send this message to {r.full_name}. The link works <b>once</b> and only for <b>{r.valid_days} days</b>.
            Any older link for this person has stopped working.</p>
          <textarea id="app-link-text" readOnly value={text} rows={9} style={{ fontSize: 13 }} onFocus={(e) => e.currentTarget.select()} />
          <div className="actions" style={{ flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => onClose(true)}>Close</button>
            <button className="btn" onClick={copy}>{copied ? 'Copied ✓' : 'Copy message'}</button>
            {wa ? <a className="btn primary" href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener">Send by WhatsApp</a>
              : <span className="muted small" style={{ alignSelf: 'center' }}>No mobile number — copy the message and send it yourself.</span>}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>Forgot their password later? Just press <b>Send app link</b> again.</p>
        </>}
        {err && <div className="actions"><button className="btn" onClick={() => onClose(false)}>Close</button></div>}
      </div>
    </div>
  );
}
