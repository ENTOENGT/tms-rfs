'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { uploadPro } from '@/components/ProShared';
import { fmtSize } from '@/components/JobFiles';

const Err = ({ m }: { m?: string }) => (m ? <small className="ferr">{m}</small> : null);

export default function NewPro() {
  const { can, lk } = useMe();
  const router = useRouter();
  const [f, setF] = useState<any>({ direction: 'import', load_type: 'FCL', transport_mode: 'sea', priority: 'normal', activity_types: ['customs_declaration', 'gate_pass_release'] });
  const [conts, setConts] = useState<{ container_no: string; size_type: string }[]>([{ container_no: '', size_type: '40HC' }]);
  const [cfg, setCfg] = useState<any>(null);
  const [docTypes, setDocTypes] = useState<[string, string][]>([]);
  const [officers, setOfficers] = useState<any[]>([]);
  const [files, setFiles] = useState<{ type: string; file: File }[]>([]);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState<{ code: string; msg: string } | null>(null);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api('/api/pro/config').then(setCfg);
    if (can('pro.assign')) api('/api/pro?officers=1').then(setOfficers).catch(() => {});
    setDocTypes([['commercial_invoice', 'Commercial Invoice'], ['packing_list', 'Packing List'], ['bill_of_lading', 'Bill of Lading'],
      ['certificate_of_origin', 'Certificate of Origin'], ['customs_declaration', 'Customs Declaration / BOE'], ['permit', 'Import or Export Permit'],
      ['delivery_order', 'Delivery Order'], ['other', 'Other Supporting Documents']]);
  }, []);
  if (!can('pro.create')) return <div className="page"><div className="msg err">You can't create PRO requests.</div></div>;
  const set = (k: string) => (e: any) => { setF({ ...f, [k]: e.target.value }); if (fe[k]) setFe({ ...fe, [k]: '' }); };
  const own = lk.my_department?.side === 'operations';
  const toggleType = (code: string) => setF({ ...f, activity_types: f.activity_types.includes(code) ? f.activity_types.filter((x: string) => x !== code) : [...f.activity_types, code] });
  const submit = async (draft: boolean, confirm: Record<string, boolean> = {}) => {
    setErr(''); setWarn(null); setBusy('Saving…');
    try {
      const r = await api('/api/pro', { body: { ...f, containers: conts.filter((k) => k.container_no.trim()), save_as_draft: draft, ...confirm } });
      const failed: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setBusy(`Uploading document ${i + 1} of ${files.length}…`);
        try { await uploadPro(r.id, files[i].file, files[i].type); } catch (e: any) { failed.push(`${files[i].file.name}: ${e.message}`); }
      }
      if (failed.length) alert(`Request saved, but these did not upload — add them on the request:\n${failed.join('\n')}`);
      router.push(`/pro/${r.id}`);
    } catch (e: any) {
      setBusy('');
      if (e.code === 'PRO_JOB_NO_EXISTS' || e.code === 'CONTAINER_CHECK') setWarn({ code: e.code, msg: e.message });
      else { setErr(e.message); if (e.details?.fields) setFe(e.details.fields); }
      window.scrollTo(0, 0);
    }
  };
  const confirmAll = (extra: Record<string, boolean>) => submit(false, { confirm_duplicate_job_no: true, ...extra });
  return (
    <div className="page">
      <div className="page-head"><h1>New PRO request</h1></div>
      {err && <div className="msg err">{err}</div>}
      {busy && <div className="msg">{busy}</div>}
      {warn && <div className="msg warn">{warn.msg} <button className="btn small" onClick={() => confirmAll(warn.code === 'CONTAINER_CHECK' ? { confirm_container_check: true } : {})}>
        {warn.code === 'CONTAINER_CHECK' ? 'The number is correct — continue' : 'Yes, add another request'}</button></div>}
      <div className="cols">
        <div>
          <div className="panel"><h2>Job and shipment</h2>
            {!own && <label className="f" style={{ maxWidth: 320, marginBottom: 12 }}><span>Requesting department</span>
              <select value={f.department_id ?? ''} onChange={set('department_id')}><option value="">PRO / none</option>
                {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
            <div className="grid g3">
              <label className={`f${fe.job_no ? ' bad' : ''}`}><span>Job No. <em>*</em></span><input value={f.job_no ?? ''} onChange={set('job_no')} autoFocus maxLength={40} /><Err m={fe.job_no} /></label>
              <label className={`f span2${fe.customer_id ? ' bad' : ''}`}><span>Customer <em>*</em></span><select value={f.customer_id ?? ''} onChange={set('customer_id')}>
                <option value="">Choose customer</option>{lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Err m={fe.customer_id} /></label>
              <label className={`f${fe.bl_number ? ' bad' : ''}`}><span>BL number <em>*</em></span><input value={f.bl_number ?? ''} onChange={set('bl_number')} /><Err m={fe.bl_number} /></label>
              <label className="f"><span>Shipment / booking ref.</span><input value={f.shipment_reference ?? ''} onChange={set('shipment_reference')} /></label>
              <label className={`f${fe.direction ? ' bad' : ''}`}><span>Import / Export / Transit <em>*</em></span><select value={f.direction} onChange={set('direction')}>
                <option value="import">Import</option><option value="export">Export</option><option value="transit">Transit</option></select></label>
              <label className="f"><span>Transport mode</span><select value={f.transport_mode ?? ''} onChange={set('transport_mode')}>
                <option value="sea">Sea</option><option value="air">Air</option><option value="land">Land</option></select></label>
              <label className="f"><span>FCL / LCL</span><select value={f.load_type ?? ''} onChange={set('load_type')}><option value="">—</option><option value="FCL">FCL</option><option value="LCL">LCL</option></select></label>
              <label className="f"><span>Vessel</span><input value={f.vessel ?? ''} onChange={set('vessel')} /></label>
              <label className="f"><span>Voyage</span><input value={f.voyage ?? ''} onChange={set('voyage')} /></label>
              <label className="f"><span>Port of origin</span><input value={f.port_of_origin ?? ''} onChange={set('port_of_origin')} /></label>
              <label className="f"><span>Port of destination</span><input value={f.port_of_destination ?? ''} onChange={set('port_of_destination')} /></label>
              <label className={`f span2${fe.uae_location ? ' bad' : ''}`}><span>UAE port / terminal / free zone <em>*</em></span><input value={f.uae_location ?? ''} onChange={set('uae_location')} placeholder="e.g. Jebel Ali Port T2, JAFZA" /><Err m={fe.uae_location} /></label>
              <label className="f span2"><span>Cargo description</span><input value={f.cargo_description ?? ''} onChange={set('cargo_description')} /></label>
            </div></div>
          <div className={`panel${fe.containers ? ' bad' : ''}`}><h2>Containers</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Each container is tracked on its own. Not needed for LCL, air or land.</p>
            {conts.map((k, i) => <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input value={k.container_no} onChange={(e) => setConts(conts.map((x, j) => j === i ? { ...x, container_no: e.target.value.toUpperCase() } : x))} placeholder="e.g. MSCU1234566" style={{ flex: 2 }} />
              <select value={k.size_type} onChange={(e) => setConts(conts.map((x, j) => j === i ? { ...x, size_type: e.target.value } : x))} style={{ flex: 1 }}>
                {['20GP', '40GP', '40HC', '20RF', '40RF', '20OT', '40OT', '20FR', '40FR', 'Other'].map((t) => <option key={t}>{t}</option>)}</select>
              <button className="btn small" type="button" onClick={() => setConts(conts.filter((_, j) => j !== i))} disabled={conts.length === 1}>✕</button></div>)}
            <button className="btn small" type="button" onClick={() => setConts([...conts, { container_no: '', size_type: conts[conts.length - 1]?.size_type ?? '40HC' }])}>+ Add container</button>
            <Err m={fe.containers} /></div>
          <div className="panel"><h2>Clearance activities needed</h2>
            <p className="muted small" style={{ marginTop: 0 }}>Tick what this shipment needs. PRO can add or remove activities later.</p>
            <div className="grid g2">{cfg?.activity_types.filter((t: any) => t.is_active).map((t: any) => (
              <label key={t.code} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={f.activity_types.includes(t.code)} onChange={() => toggleType(t.code)} />{t.name}</label>))}</div></div>
        </div>
        <div>
          <div className="panel"><h2>When</h2><div className="grid">
            <label className={`f${fe.required_date ? ' bad' : ''}`}><span>Required clearance date <em>*</em></span><input type="date" value={f.required_date ?? ''} onChange={set('required_date')} /><Err m={fe.required_date} /></label>
            <label className="f"><span>Deadline</span><input type="date" value={f.deadline ?? ''} onChange={set('deadline')} /></label>
            <label className="f"><span>Priority</span><select value={f.priority} onChange={set('priority')}><option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option></select></label>
            {can('pro.assign') && <label className="f"><span>PRO officer</span><select value={f.assigned_to ?? ''} onChange={set('assigned_to')}><option value="">Assign later</option>
              {officers.map((o) => <option key={o.id} value={o.id}>{o.full_name} ({o.open_requests} open)</option>)}</select></label>}
          </div></div>
          <div className="panel"><h2>Instructions</h2><textarea value={f.instructions ?? ''} onChange={set('instructions')} placeholder="Special instructions and remarks for PRO" /></div>
          <div className="panel"><h2>Supporting documents</h2>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select id="pro-doc-type" defaultValue="commercial_invoice" style={{ flex: 1 }}>{docTypes.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
              <label className="btn small">Add files<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png" style={{ display: 'none' }} onChange={(e) => {
                const type = (document.getElementById('pro-doc-type') as HTMLSelectElement).value;
                setFiles([...files, ...[...(e.target.files ?? [])].map((file) => ({ type, file }))]); e.target.value = ''; }} /></label></div>
            {files.map((x, i) => <div key={i} className="small docs-file">{docTypes.find(([c]) => c === x.type)?.[1]}: {x.file.name} <span className="muted">{fmtSize(x.file.size)}</span>
              <button className="linkish" onClick={() => setFiles(files.filter((_, j) => j !== i))}>✕</button></div>)}
          </div>
          <div className="panel"><div className="form-actions" style={{ marginTop: 0 }}>
            <button className="btn" disabled={!!busy} onClick={() => submit(true)}>Save as draft</button>
            <button className="btn primary" disabled={!!busy} onClick={() => submit(false)}>Send to PRO</button></div></div>
        </div>
      </div>
    </div>
  );
}
