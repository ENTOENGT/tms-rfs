'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { fmtSize, uploadOne } from '@/components/JobFiles';
import { jobNoProblem, phoneProblem, REQUEST_DOCS } from '@/lib/requestRules';

const Err = ({ m }: { m?: string }) => (m ? <small className="ferr">{m}</small> : null);
const OK_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

function LocationFields({ p, f, set, lk, fe }: { p: 'pickup' | 'delivery'; f: any; set: any; lk: any; fe: Record<string, string> }) {
  const saved = f[`${p}_location_id`];
  const isDel = p === 'delivery';
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
          {!isDel && <>
          <label className="f"><span>Contact person</span><input value={f[`${p}_contact_person`] ?? ''} onChange={set(`${p}_contact_person`)} /></label>
          <label className="f"><span>Contact number</span><input value={f[`${p}_contact_number`] ?? ''} onChange={set(`${p}_contact_number`)} /></label></>}
        </>}
        {isDel && <>
          {/* Who receives the goods — always required, even with a saved location */}
          <label className={`f${fe.delivery_contact_person ? ' bad' : ''}`}><span>Delivery contact person <em>*</em></span>
            <input value={f.delivery_contact_person ?? ''} onChange={set('delivery_contact_person')} placeholder="Name of the person receiving" />
            <Err m={fe.delivery_contact_person} /></label>
          <label className={`f${fe.delivery_contact_number ? ' bad' : ''}`}><span>Delivery contact number <em>*</em></span>
            <input type="tel" value={f.delivery_contact_number ?? ''} onChange={set('delivery_contact_number')} placeholder="e.g. 050 123 4567 or +44 20 7946 0000" />
            <Err m={fe.delivery_contact_number} /></label>
        </>}
      </div>
    </div>
  );
}

export default function RequestForm({ job }: { job?: any }) {
  const { me, can, lk } = useMe();
  const router = useRouter();
  const EDIT_KEYS = ['job_no', 'department_id', 'required_date', 'slot_from', 'slot_to', 'priority', 'customer_id', 'customer_reference', 'email_subject', 'boe_number',
    'shipment_number', 'booking_reference', 'requested_vehicle_type_id', 'pickup_name', 'pickup_address', 'pickup_contact_person',
    'pickup_contact_number', 'delivery_name', 'delivery_address', 'delivery_contact_person', 'delivery_contact_number', 'cargo_description',
    'cargo_type', 'packages', 'weight_kg', 'volume_cbm', 'pallets', 'temperature_requirement', 'special_handling', 'special_instructions'];
  const initial = job ? Object.fromEntries(EDIT_KEYS.map((k) => [k, k.startsWith('slot_') && job[k] ? job[k].slice(0, 5) : job[k] ?? ''])) : { priority: 'normal' };
  const [f, setF] = useState<any>(initial);
  const [err, setErr] = useState('');
  const [dupe, setDupe] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCust, setNewCust] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});          // field-level messages
  const [jobDupe, setJobDupe] = useState('');
  const [files, setFiles] = useState<{ type: string; file: File }[]>([]);
  const [progress, setProgress] = useState('');
  const [partial, setPartial] = useState<{ id: string; job_no: string; failed: string[] } | null>(null);
  const [customers, setCustomers] = useState(lk.customers);
  const set = (k: string) => (e: any) => {
    const v = e.target.value, next: any = { ...f, [k]: v };
    // choosing a saved delivery location fills its contact (only where nothing was typed yet)
    if (k === 'delivery_location_id' && v) {
      const l = lk.locations.find((x: any) => x.id === v);
      if (l && !f.delivery_contact_person) next.delivery_contact_person = l.contact_person ?? '';
      if (l && !f.delivery_contact_number) next.delivery_contact_number = l.contact_number ?? '';
    }
    setF(next); if (fe[k]) setFe({ ...fe, [k]: '' });
  };
  const addFiles = (type: string, list: FileList | null) => {
    const bad: string[] = [];
    const ok = [...(list ?? [])].filter((file) => {
      const t = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
      if (!OK_TYPES.includes(t)) { bad.push(`${file.name}: only PDF, JPG or PNG`); return false; }
      if (file.size > 10 * 1024 * 1024) { bad.push(`${file.name}: larger than 10 MB`); return false; }
      return true;
    });
    setFiles([...files, ...ok.map((file) => ({ type, file }))]);
    setErr(bad.length ? bad.join(' · ') : '');
  };
  const check = () => {
    const e: Record<string, string> = {};
    const j = jobNoProblem(f.job_no); if (j) e.job_no = j;
    if (!String(f.delivery_contact_person ?? '').trim()) e.delivery_contact_person = "Enter the delivery contact person's name";
    const pp = phoneProblem(f.delivery_contact_number); if (pp) e.delivery_contact_number = pp;
    setFe(e);
    return Object.keys(e).length === 0;
  };
  if (!job && !can('jobs.create')) return <div className="page"><div className="msg err">You don't have permission to create transport requests.</div></div>;

  const addCustomer = async () => {
    try {
      const c = await api('/api/customers', { body: { name: newCust } });
      setCustomers([...customers, c].sort((a: any, b: any) => a.name.localeCompare(b.name)));
      setF({ ...f, customer_id: c.id }); setNewCust(null);
    } catch (e: any) { setErr(e.message); }
  };
  const submit = async (draft: boolean, confirmDupe = false, confirmJobNo = false) => {
    setErr(''); setDupe(''); setJobDupe('');
    if (!job && !check()) { setErr('Please fill in the fields marked in red.'); window.scrollTo(0, 0); return; }
    setBusy(true);
    try {
      if (job) {
        const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => String(v ?? '') !== String((initial as any)[k] ?? '')));
        await api(`/api/jobs/${job.id}`, { method: 'PATCH', body: { ...changed, confirm_duplicate_job_no: confirmJobNo } });
        router.push(`/jobs/${job.id}`);
        return;
      }
      const created = await api('/api/jobs', { body: { ...f, save_as_draft: draft, confirm_duplicate_boe: confirmDupe, confirm_duplicate_job_no: confirmJobNo } });
      // the request is saved — now its documents, one by one
      const failed: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Uploading document ${i + 1} of ${files.length}…`);
        try { await uploadOne(created.id, files[i].file, files[i].type); } catch (e: any) { failed.push(`${files[i].file.name} (${e.message})`); }
      }
      setProgress('');
      if (failed.length) { setPartial({ id: created.id, job_no: created.job_no, failed }); setBusy(false); window.scrollTo(0, 0); return; }
      router.push(`/jobs/${created.id}`);
    } catch (e: any) {
      if (e.code === 'BOE_DUPLICATE') setDupe(e.message);
      else if (e.code === 'JOB_NO_OTHER_DEPT') setJobDupe(e.message);
      else { setErr(e.message); if (e.details?.fields) setFe(e.details.fields); if (e.code === 'JOB_NO_TAKEN') setFe({ job_no: 'Already used in your department' }); }
      setBusy(false); setProgress(''); window.scrollTo(0, 0);
    }
  };
  if (partial) return (
    <div className="page">
      <div className="msg warn">Request <b>Job No. {partial.job_no}</b> is saved, but {partial.failed.length} document(s) did not upload:
        <ul>{partial.failed.map((x) => <li key={x}>{x}</li>)}</ul>Open the job and add them again in its <b>Documents</b> tab.</div>
      <button className="btn primary" onClick={() => router.push(`/jobs/${partial.id}`)}>Open the job</button>
    </div>
  );
  return (
    <div className="page">
      <div className="page-head"><h1>{job ? `Edit Job No. ${job.job_no ?? job.job_number}` : 'New transport request'}</h1></div>
      {err && <div className="msg err">{err}</div>}
      {progress && <div className="msg">{progress}</div>}
      {dupe && <div className="msg warn">{dupe} <button className="btn small" onClick={() => submit(false, true)}>Yes, submit anyway</button></div>}
      {jobDupe && <div className="msg warn">{jobDupe} <button className="btn small" onClick={() => submit(false, !!dupe, true)}>Yes, it is a separate request</button></div>}
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
              <label className={`f${fe.job_no ? ' bad' : ''}`}><span>Job No. <em>*</em></span>
                <input value={f.job_no ?? ''} onChange={set('job_no')} placeholder="Your internal Job No." autoFocus={!job} maxLength={40} />
                <Err m={fe.job_no} /></label>
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
          <LocationFields p="pickup" f={f} set={set} lk={lk} fe={fe} />
          <LocationFields p="delivery" f={f} set={set} lk={lk} fe={fe} />
          {!job && <div className="panel">
            <h2>Documents for the trip</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Transport prints these and gives them to the driver. PDF, JPG or PNG, up to 10 MB each — you can add several per heading.
              Files are deleted automatically 30 days after upload.</p>
            <div className="docs-grid">
              {REQUEST_DOCS.map(([code, name]) => {
                const mine = files.map((x, i) => ({ ...x, i })).filter((x) => x.type === code);
                return <div key={code} className="docs-slot">
                  <div className="docs-slot-head"><b>{name}</b>
                    <label className="btn small">Add files<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" style={{ display: 'none' }}
                      onChange={(e) => { addFiles(code, e.target.files); e.target.value = ''; }} /></label></div>
                  {mine.length === 0 ? <div className="muted small">No file</div> : mine.map((x) => (
                    <div key={x.i} className="small docs-file">{x.file.name} <span className="muted">{fmtSize(x.file.size)}</span>
                      <button type="button" className="linkish" aria-label={`Remove ${x.file.name}`} onClick={() => setFiles(files.filter((_, j) => j !== x.i))}>✕</button></div>))}
                </div>;
              })}
            </div>
          </div>}
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
              <p className="small muted" style={{ marginTop: 0 }}>Submitting sends the request to Transport as Pending Assignment and notifies them.
                {files.length > 0 && <> {files.length} document{files.length === 1 ? '' : 's'} will be attached.</>}</p>
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
