'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { FileLink, docUrl, uploadOne } from '@/components/JobFiles';
import { nextStep } from '@/components/DriverApp';

// The words a driver sees for each step. The server only offers steps a driver may take.
const STEP: Record<string, { label: string; ask: string }> = {
  dispatched: { label: 'Start trip', ask: 'Are you leaving for the pickup now?' },
  picked_up: { label: 'Goods picked up', ask: 'Have you loaded the goods?' },
  in_transit: { label: 'On the way', ask: 'Are you on the way to the delivery place?' },
  delivered: { label: 'Delivered', ask: 'Have you handed over the goods?' },
};
const mapUrl = (name: string, address?: string | null, lat?: string | null, lng?: string | null) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat && lng ? `${lat},${lng}` : [name, address].filter(Boolean).join(', '))}`;

function Place({ title, j, p }: { title: string; j: any; p: 'pickup' | 'delivery' }) {
  const phone = j[`${p}_contact_number`];
  return (
    <div className="panel app-place">
      <div className="muted small">{title}</div>
      <div className="app-place-name">{j[`${p}_name`]}</div>
      {j[`${p}_address`] && <div className="small">{j[`${p}_address`]}</div>}
      {j[`${p}_contact_person`] && <div className="small" style={{ marginTop: 4 }}>Contact: <b>{j[`${p}_contact_person`]}</b></div>}
      <div className="app-place-btns">
        <a className="btn" href={mapUrl(j[`${p}_name`], j[`${p}_address`], j[`${p}_latitude`], j[`${p}_longitude`])} target="_blank" rel="noopener">Map</a>
        {phone && <a className="btn" href={`tel:${String(phone).replace(/[^\d+]/g, '')}`}>Call {phone}</a>}
      </div>
    </div>
  );
}

export default function MyJob({ params }: { params: { id: string } }) {
  const [j, setJ] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState<string | null>(null);
  const [pod, setPod] = useState<{ file?: File; received_by: string }>({ received_by: '' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api(`/api/jobs/${params.id}`).then(setJ).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);
  if (err && !j) return <div className="app-page"><div className="msg err">{err}</div><Link href="/my-jobs">‹ Back to my jobs</Link></div>;
  if (!j) return <div className="app-page muted">Loading…</div>;

  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setErr('');
    try { const r = await fn(); if (r) setJ(r); setAsk(null); }
    catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
    setBusy(false);
  };
  const steps = (j.next_statuses ?? []).filter((s: any) => STEP[s.code]);
  const needsPod = j.permissions.upload_pod && ['delivered', 'pod_pending'].includes(j.status_code) && ['pending', 'rejected'].includes(j.pod_status);
  const pods = j.documents.filter((d: any) => d.document_type_code === 'pod');
  const sendPod = () => run(async () => {
    const r = await uploadOne(j.id, pod.file!, 'pod', { received_by: pod.received_by, pod_date: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }) });
    setPod({ received_by: '' });
    return r.job;
  });
  const step = nextStep(j);

  return (
    <div className="app-page">
      <Link href="/my-jobs" className="app-back">‹ My jobs</Link>
      <div className="app-card-head" style={{ margin: '6px 0 2px' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{j.job_number}</h1>
        <span className="badge" style={{ background: j.status_color }}>{j.status_name}</span>
        {j.priority === 'urgent' && <span className="flag">Urgent</span>}
      </div>
      <div className="app-when">{j.planned_pickup_at ? `Pickup ${fmtDateTime(j.planned_pickup_at)}` : fmtDate(j.required_date)}
        {j.planned_delivery_at && <> · Deliver by {fmtDateTime(j.planned_delivery_at)}</>}</div>
      {err && <div className="msg err">{err}</div>}

      {(steps.length > 0 || needsPod) && <div className="panel app-action">
        {step && <div className="app-next" style={{ marginBottom: 10 }}>{step}</div>}
        {steps.map((s: any, i: number) => (
          <button key={s.code} className={`btn app-big${i === steps.length - 1 ? ' primary' : ''}`} disabled={busy} onClick={() => setAsk(s.code)}>{STEP[s.code].label}</button>
        ))}
        {needsPod && <>
          {j.pod?.rejection_reason && j.pod_status === 'rejected' && <div className="msg err">Office rejected the POD: {j.pod.rejection_reason}</div>}
          <label className="btn app-big primary" style={{ textAlign: 'center' }}>
            {pod.file ? 'Change photo' : 'Take POD photo'}
            <input type="file" accept="image/*,.pdf" capture="environment" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) setPod({ ...pod, file: f }); e.target.value = ''; }} />
          </label>
          {pod.file && <>
            <p className="small" style={{ margin: '8px 0' }}>Photo ready: <b>{pod.file.name}</b></p>
            <label className="f"><span>Received by (name)</span><input value={pod.received_by} onChange={(e) => setPod({ ...pod, received_by: e.target.value })} placeholder="Who signed for the goods?" /></label>
            <button className="btn app-big primary" style={{ marginTop: 10 }} disabled={busy} onClick={sendPod}>{busy ? 'Sending…' : 'Send POD to office'}</button>
          </>}
        </>}
      </div>}
      {!steps.length && !needsPod && j.pod_status === 'uploaded' && <div className="msg ok">POD sent. The office will check it.</div>}

      <Place title="PICK UP FROM" j={j} p="pickup" />
      <Place title="DELIVER TO" j={j} p="delivery" />

      <div className="panel">
        <div className="muted small">LOAD</div>
        <dl className="kv" style={{ gridTemplateColumns: '110px 1fr', marginTop: 6 }}>
          {j.vehicle_number && <><dt>Vehicle</dt><dd><b>{j.vehicle_number}</b></dd></>}
          {j.cargo_description && <><dt>Goods</dt><dd>{j.cargo_description}</dd></>}
          {j.packages != null && <><dt>Packages</dt><dd>{j.packages}</dd></>}
          {j.pallets != null && <><dt>Pallets</dt><dd>{j.pallets}</dd></>}
          {j.weight_kg != null && <><dt>Weight</dt><dd>{Number(j.weight_kg).toLocaleString('en-US')} kg</dd></>}
          {j.boe_number && <><dt>BOE</dt><dd>{j.boe_number}</dd></>}
          {j.temperature_requirement && <><dt>Temperature</dt><dd>{j.temperature_requirement}</dd></>}
          {j.special_handling && <><dt>Handling</dt><dd>{j.special_handling}</dd></>}
        </dl>
        {j.special_instructions && <div className="msg" style={{ marginTop: 8, background: '#FFF8E6' }}><b>Instructions:</b> {j.special_instructions}</div>}
      </div>

      {pods.length > 0 && <div className="panel"><div className="muted small">POD</div>
        <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
          {pods.map((d: any, i: number) => <li key={d.id} style={{ padding: '4px 0' }}><FileLink files={pods} index={i} base={docUrl} /></li>)}
        </ul></div>}

      <div className="panel">
        <div className="muted small">MESSAGE TO THE OFFICE</div>
        {j.notes.map((n: any) => <div key={n.id} className="small" style={{ padding: '6px 0', borderBottom: '1px solid #eee' }}>
          <b>{n.author}</b> <span className="muted">{fmtDateTime(n.created_at)}</span><div>{n.body}</div></div>)}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Customer not available, waiting at gate" style={{ marginTop: 8 }} />
        <button className="btn app-big" style={{ marginTop: 8 }} disabled={busy || !note.trim()}
          onClick={() => run(async () => { const r = await api(`/api/jobs/${j.id}/notes`, { body: { body: note } }); setNote(''); return r; })}>Send message</button>
      </div>

      {ask && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAsk(null)}>
        <div className="modal" role="dialog" aria-label={STEP[ask].label}>
          <h2>{STEP[ask].label}</h2>
          <p>{STEP[ask].ask}</p>
          <div className="actions"><button className="btn app-big" onClick={() => setAsk(null)}>No</button>
            <button className="btn app-big primary" disabled={busy} onClick={() => run(() => api(`/api/jobs/${j.id}/status`, { body: { to: ask } }))}>Yes</button></div>
        </div>
      </div>}
    </div>
  );
}
