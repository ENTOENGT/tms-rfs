'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';

function LocationFields({ p, f, set, lk }: { p: 'pickup' | 'delivery'; f: any; set: any; lk: any }) {
  const saved = f[`${p}_location_id`];
  return (
    <div className="panel">
      <h2>{p === 'pickup' ? 'Pickup' : 'Delivery'}</h2>
      <div className="grid g2">
        <label className="f span2"><span>Saved location</span>
          <select value={saved ?? ''} onChange={set(`${p}_location_id`)}>
            <option value="">Enter manually</option>
            {lk.locations.map((l: any) => <option key={l.id} value={l.id}>{l.name}{l.emirate ? `, ${l.emirate}` : ''}</option>)}
          </select></label>
        {!saved && <>
          <label className="f"><span>Location name <em>*</em></span><input value={f[`${p}_name`] ?? ''} onChange={set(`${p}_name`)} placeholder={p === 'pickup' ? 'e.g. Jebel Ali Free Zone' : 'e.g. Dubai Investment Park'} /></label>
          <label className="f"><span>Address</span><input value={f[`${p}_address`] ?? ''} onChange={set(`${p}_address`)} /></label>
          <label className="f"><span>Contact person</span><input value={f[`${p}_contact_person`] ?? ''} onChange={set(`${p}_contact_person`)} /></label>
          <label className="f"><span>Contact number</span><input value={f[`${p}_contact_number`] ?? ''} onChange={set(`${p}_contact_number`)} /></label>
        </>}
      </div>
    </div>
  );
}

export default function RequestForm({ job }: { job?: any }) {
  const { me, can, lk } = useMe();
  const router = useRouter();
  const EDIT_KEYS = ['department_id', 'required_date', 'slot_from', 'slot_to', 'priority', 'customer_id', 'customer_reference', 'email_subject', 'boe_number',
    'shipment_number', 'booking_reference', 'requested_vehicle_type_id', 'pickup_name', 'pickup_address', 'pickup_contact_person',
    'pickup_contact_number', 'delivery_name', 'delivery_address', 'delivery_contact_person', 'delivery_contact_number', 'cargo_description',
    'cargo_type', 'packages', 'weight_kg', 'volume_cbm', 'pallets', 'temperature_requirement', 'special_handling', 'special_instructions'];
  const initial = job ? Object.fromEntries(EDIT_KEYS.map((k) => [k, k.startsWith('slot_') && job[k] ? job[k].slice(0, 5) : job[k] ?? ''])) : { priority: 'normal' };
  const [f, setF] = useState<any>(initial);
  const [err, setErr] = useState('');
  const [dupe, setDupe] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCust, setNewCust] = useState<string | null>(null);
  const [customers, setCustomers] = useState(lk.customers);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  if (!job && !can('jobs.create')) return <div className="page"><div className="msg err">You don't have permission to create transport requests.</div></div>;

  const addCustomer = async () => {
    try {
      const c = await api('/api/customers', { body: { name: newCust } });
      setCustomers([...customers, c].sort((a: any, b: any) => a.name.localeCompare(b.name)));
      setF({ ...f, customer_id: c.id }); setNewCust(null);
    } catch (e: any) { setErr(e.message); }
  };
  const submit = async (draft: boolean, confirmDupe = false) => {
    setBusy(true); setErr(''); setDupe('');
    try {
      if (job) {
        const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => String(v ?? '') !== String((initial as any)[k] ?? '')));
        await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: changed });
        router.push(`/jobs/${job.id}`);
        return;
      }
      const created = await api('/api/jobs', { body: { ...f, save_as_draft: draft, confirm_duplicate_boe: confirmDupe } });
      router.push(`/jobs/${created.id}`);
    } catch (e: any) {
      if (e.code === 'BOE_DUPLICATE') setDupe(e.message); else setErr(e.message);
      setBusy(false); window.scrollTo(0, 0);
    }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>{job ? `Edit ${job.job_number}` : 'New transport request'}</h1></div>
      {err && <div className="msg err">{err}</div>}
      {dupe && <div className="msg warn">{dupe} <button className="btn small" onClick={() => submit(false, true)}>Yes, submit anyway</button></div>}
      <div className="cols">
        <div>
          <div className="panel">
            <h2>Job</h2>
            {(() => {
              // Operations staff: the request belongs to their own department.
              // Super Admin (or anyone outside Operations): choose the department.
              const own = lk.my_department?.side === 'operations' ? lk.my_department : null;
              const canChoose = !own && (!job || me.role_code === 'super_admin');
              const opsDepts = lk.departments.filter((d: any) => d.side === 'operations');
              if (canChoose) return (
                <label className="f" style={{ marginBottom: 12, maxWidth: 320 }}><span>Department <em>*</em></span>
                  <select value={f.department_id ?? ''} onChange={set('department_id')}>
                    <option value="">Choose department</option>
                    {opsDepts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>);
              const name = job?.department_name ?? own?.name;
              return name ? <p className="muted small" style={{ marginTop: -6 }}>Department: <b>{name}</b></p> : null;
            })()}
            <div className="grid g3">
              <label className="f"><span>Required date <em>*</em></span><input type="date" value={f.required_date ?? ''} onChange={set('required_date')} /></label>
              <label className="f"><span>Time slot from</span><input type="time" value={f.slot_from ?? ''} onChange={set('slot_from')} /></label>
              <label className="f"><span>Time slot to</span><input type="time" value={f.slot_to ?? ''} onChange={set('slot_to')} /></label>
              <label className="f span2"><span>Customer <em>*</em></span>
                {newCust === null ? (
                  <select value={f.customer_id ?? ''} onChange={(e) => e.target.value === '__new' ? setNewCust('') : set('customer_id')(e)}>
                    <option value="">Choose customer</option>
                    {customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    {can('customers.manage') && <option value="__new">+ Add new customer</option>}
                  </select>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input autoFocus value={newCust} onChange={(e) => setNewCust(e.target.value)} placeholder="New customer name" />
                    <button className="btn" type="button" onClick={addCustomer} disabled={!newCust.trim()}>Add</button>
                    <button className="btn" type="button" onClick={() => setNewCust(null)}>Cancel</button>
                  </div>
                )}</label>
              <label className="f"><span>Priority</span>
                <select value={f.priority} onChange={set('priority')}>
                  <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
                </select></label>
              <label className="f"><span>Vehicle type needed</span>
                <select value={f.requested_vehicle_type_id ?? ''} onChange={set('requested_vehicle_type_id')}>
                  <option value="">Any</option>{lk.vehicle_types.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select></label>
              <label className="f"><span>BOE number</span><input value={f.boe_number ?? ''} onChange={set('boe_number')} /></label>
              <label className="f"><span>Customer reference</span><input value={f.customer_reference ?? ''} onChange={set('customer_reference')} /></label>
              <label className="f span2"><span>Email subject / reference</span><input value={f.email_subject ?? ''} onChange={set('email_subject')} /></label>
              <label className="f"><span>Shipment number</span><input value={f.shipment_number ?? ''} onChange={set('shipment_number')} /></label>
            </div>
          </div>
          <LocationFields p="pickup" f={f} set={set} lk={lk} />
          <LocationFields p="delivery" f={f} set={set} lk={lk} />
          <div className="panel">
            <h2>Cargo</h2>
            <div className="grid g4">
              <label className="f span2"><span>Description</span><input value={f.cargo_description ?? ''} onChange={set('cargo_description')} /></label>
              <label className="f"><span>Cargo type</span><input value={f.cargo_type ?? ''} onChange={set('cargo_type')} placeholder="General, chilled…" /></label>
              <label className="f"><span>Temperature</span><input value={f.temperature_requirement ?? ''} onChange={set('temperature_requirement')} placeholder="e.g. 2–8 °C" /></label>
              <label className="f"><span>Packages</span><input type="number" min="0" value={f.packages ?? ''} onChange={set('packages')} /></label>
              <label className="f"><span>Weight (kg)</span><input type="number" min="0" step="0.01" value={f.weight_kg ?? ''} onChange={set('weight_kg')} /></label>
              <label className="f"><span>Volume (cbm)</span><input type="number" min="0" step="0.001" value={f.volume_cbm ?? ''} onChange={set('volume_cbm')} /></label>
              <label className="f"><span>Pallets</span><input type="number" min="0" value={f.pallets ?? ''} onChange={set('pallets')} /></label>
              <label className="f span2"><span>Special handling</span><input value={f.special_handling ?? ''} onChange={set('special_handling')} /></label>
              <label className="f span2"><span>Special instructions</span><input value={f.special_instructions ?? ''} onChange={set('special_instructions')} /></label>
            </div>
          </div>
        </div>
        <div>
          {!job && me.financial_access.sellingEdit && (
            <div className="panel">
              <h2>Selling price</h2>
              <p className="muted small" style={{ marginTop: 0 }}>Excluding VAT. Transport never sees this section or its values.</p>
              <div className="grid">
                <label className="f"><span>Base selling price ({lk.currency})</span><input type="number" min="0" step="0.01" value={f.base_selling_price ?? ''} onChange={set('base_selling_price')} /></label>
                <label className="f"><span>Additional charges</span><input type="number" min="0" step="0.01" value={f.additional_selling_charges ?? ''} onChange={set('additional_selling_charges')} /></label>
                <label className="f"><span>Discount</span><input type="number" min="0" step="0.01" value={f.discount ?? ''} onChange={set('discount')} /></label>
              </div>
            </div>
          )}
          <div className="panel">
            {job ? <>
              <p className="small muted" style={{ marginTop: 0 }}>Every change is recorded in the job's activity.{job.status_stage === 'active' ? ' Transport will be notified because this job is already assigned.' : ''}</p>
              <div className="form-actions" style={{ marginTop: 0 }}>
                <button className="btn" disabled={busy} onClick={() => router.push(`/jobs/${job.id}`)}>Cancel</button>
                <button className="btn primary" disabled={busy} onClick={() => submit(false)}>Save changes</button>
              </div>
            </> : <>
              <p className="small muted" style={{ marginTop: 0 }}>Submitting sends the request to Transport as Pending Assignment and notifies them.</p>
              <div className="form-actions" style={{ marginTop: 0 }}>
                <button className="btn" disabled={busy} onClick={() => submit(true)}>Save as draft</button>
                <button className="btn primary" disabled={busy} onClick={() => submit(false)}>Submit to Transport</button>
              </div>
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}
