'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from './api';
import { useMe } from './Shell';

export const RUN_COLOR: Record<string, string> = {
  pending: '#B7791F', assigned: '#2B6CB0', collected: '#6B46C1', delivered: '#276749', failed: '#9B2C2C', cancelled: '#6B7280',
};
export const TASKS: [string, string][] = [
  ['collect_deliver', 'Collect and deliver'], ['collect', 'Collect documents'], ['deliver', 'Deliver documents'],
  ['submit', 'Submit documents (e.g. customs)'], ['other', 'Other'],
];
const KEYS = ['required_date', 'slot_from', 'slot_to', 'priority', 'task_type', 'documents', 'reference', 'customer_id',
  'from_name', 'from_address', 'from_contact_person', 'from_contact_number', 'to_name', 'to_address', 'to_contact_person',
  'to_contact_number', 'instructions'];

export default function RunForm({ run }: { run?: any }) {
  const { me, lk } = useMe();
  const router = useRouter();
  const initial: any = run ? Object.fromEntries(KEYS.map((k) => [k, k.startsWith('slot_') && run[k] ? run[k].slice(0, 5) : run[k] ?? '']))
    : { priority: 'normal', task_type: 'collect_deliver' };
  const [f, setF] = useState<any>(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTo, setShowTo] = useState(!!initial.to_name);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const own = lk.my_department?.side === 'operations' ? lk.my_department : null;
  const needsTo = !['collect', 'submit'].includes(f.task_type);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (run) {
        const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => String(v ?? '') !== String(initial[k] ?? '')));
        await api(`/api/runs/${run.id}`, { method: 'PATCH', body: changed });
        router.push(`/runs/${run.id}`);
      } else {
        const r = await api('/api/runs', { body: f });
        router.push(`/runs/${r.id}`);
      }
    } catch (e: any) { setErr(e.message); setBusy(false); window.scrollTo(0, 0); }
  };
  const place = (p: 'from' | 'to', title: string) => (
    <div className="panel">
      <h2>{title}</h2>
      <div className="grid g2">
        <label className="f span2"><span>Place {p === 'from' || needsTo ? <em>*</em> : null}</span>
          <input value={f[`${p}_name`] ?? ''} onChange={set(`${p}_name`)} placeholder={p === 'from' ? 'e.g. MSC Shipping, Port Rashid office' : 'e.g. Dubai Customs, Jebel Ali'} /></label>
        <label className="f span2"><span>Address</span><input value={f[`${p}_address`] ?? ''} onChange={set(`${p}_address`)} /></label>
        <label className="f"><span>Contact person</span><input value={f[`${p}_contact_person`] ?? ''} onChange={set(`${p}_contact_person`)} /></label>
        <label className="f"><span>Contact number</span><input value={f[`${p}_contact_number`] ?? ''} onChange={set(`${p}_contact_number`)} /></label>
      </div>
    </div>
  );
  return (
    <div className="page">
      <div className="page-head"><h1>{run ? `Edit ${run.run_number}` : 'Request a messenger'}</h1></div>
      {err && <div className="msg err">{err}</div>}
      <div className="cols">
        <div>
          <div className="panel">
            <h2>What needs doing</h2>
            {own ? <p className="muted small" style={{ marginTop: -6 }}>Department: <b>{run?.department_name ?? own.name}</b></p>
              : !run && <label className="f" style={{ marginBottom: 12, maxWidth: 320 }}><span>Department <em>*</em></span>
                <select value={f.department_id ?? ''} onChange={set('department_id')}><option value="">Choose department</option>
                  {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
            <div className="grid g3">
              <label className="f span2"><span>Task <em>*</em></span><select value={f.task_type} onChange={set('task_type')}>
                {TASKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label className="f"><span>Priority</span><select value={f.priority} onChange={set('priority')}>
                <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
              <label className="f span2"><span>Documents to carry <em>*</em></span>
                <input value={f.documents ?? ''} onChange={set('documents')} placeholder="e.g. Original BL x3, Delivery Order, Commercial invoice" /></label>
              <label className="f"><span>Reference (BL / BOE / DO)</span><input value={f.reference ?? ''} onChange={set('reference')} /></label>
              <label className="f"><span>Date <em>*</em></span><input type="date" value={f.required_date ?? ''} onChange={set('required_date')} /></label>
              <label className="f"><span>From time</span><input type="time" value={f.slot_from ?? ''} onChange={set('slot_from')} /></label>
              <label className="f"><span>To time</span><input type="time" value={f.slot_to ?? ''} onChange={set('slot_to')} /></label>
              <label className="f span2"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}>
                <option value="">None</option>{lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            </div>
          </div>
          {place('from', 'Collect from')}
          {(needsTo || showTo) && place('to', f.task_type === 'submit' ? 'Submit to' : 'Deliver to')}
          {!needsTo && !showTo && <p className="muted small"><a href="#" onClick={(e) => { e.preventDefault(); setShowTo(true); }}>Add a second place</a></p>}
        </div>
        <div>
          <div className="panel">
            <h2>Instructions</h2>
            <textarea value={f.instructions ?? ''} onChange={set('instructions')} placeholder="e.g. Ask for Mr. Ravi at counter 4. Bring company stamp." />
          </div>
          <div className="panel">
            <p className="small muted" style={{ marginTop: 0 }}>{run ? 'Every change is recorded in the run history.' : 'The Messenger Manager is notified and assigns a messenger.'}</p>
            <div className="form-actions" style={{ marginTop: 0 }}>
              {run && <button className="btn" disabled={busy} onClick={() => router.push(`/runs/${run.id}`)}>Cancel</button>}
              <button className="btn primary" disabled={busy} onClick={save}>{run ? 'Save changes' : 'Send request'}</button>
            </div>
          </div>
        </div>
      </div>
      <p className="muted small">Requested by {me.full_name}.</p>
    </div>
  );
}
