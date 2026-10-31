'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney, slot } from '@/components/api';
import { useMe } from '@/components/Shell';
import JobActions from '@/components/JobActions';
import { DocumentsTab, NotesTab, PodCard, docUrl, printFiles, tripSheetHtml } from '@/components/JobFiles';

const LANE = ['pending_assignment', 'assigned', 'dispatched', 'picked_up', 'in_transit', 'delivered', 'pod_received', 'completed'];

function Lane({ job, statuses }: { job: any; statuses: any[] }) {
  const order = (c: string) => statuses.find((s) => s.code === c)?.stage === 'cancelled' ? -1 : statuses.findIndex((s) => s.code === c);
  const cur = order(job.status_code);
  return (
    <div className={`lane${job.status_code === 'cancelled' ? ' cancelled' : ''}`} aria-label="Job progress">
      {LANE.map((code) => {
        const s = statuses.find((x) => x.code === code);
        const i = order(code);
        const cls = code === job.status_code ? 'now' : cur >= 0 && cur > i ? 'done' : '';
        return <div key={code} className={cls} style={cls === 'now' ? { background: s?.color } : undefined}>{s?.name ?? code}</div>;
      })}
    </div>
  );
}

function LinesEditor({ title, types, lines, extra, onSave, onClose }: {
  title: string; types: any[]; lines: any[]; extra?: { discount: string }; onSave: (l: any[], d?: string) => Promise<void>; onClose: () => void;
}) {
  const [rows, setRows] = useState(lines.map((l) => ({ type: l.expense_type_code ?? l.revenue_type_code, amount: l.amount, description: l.description ?? '' })));
  const [discount, setDiscount] = useState(extra?.discount ?? '0');
  const [err, setErr] = useState('');
  const upd = (i: number, k: string, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => { try { await onSave(rows.filter((r) => r.amount !== ''), extra ? discount : undefined); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {err && <div className="msg err">{err}</div>}
        <p className="muted small" style={{ marginTop: 0 }}>Amounts exclude VAT. Every change is recorded in the job history.</p>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1.3fr auto', gap: 6, marginBottom: 6 }}>
            <select value={r.type} onChange={(e) => upd(i, 'type', e.target.value)} aria-label="Type">
              {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
            <input type="number" min="0" step="0.01" value={r.amount} onChange={(e) => upd(i, 'amount', e.target.value)} aria-label="Amount" />
            <input value={r.description} onChange={(e) => upd(i, 'description', e.target.value)} placeholder="Note (optional)" aria-label="Note" />
            <button className="btn small danger" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove line">Remove</button>
          </div>
        ))}
        <button className="btn small" onClick={() => setRows([...rows, { type: rows.length ? types[types.length - 1].code : types[0].code, amount: '', description: '' }])}>Add line</button>
        {extra && <label className="f" style={{ marginTop: 12, maxWidth: 200 }}><span>Discount</span><input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></label>}
        <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
      </div>
    </div>
  );
}

function Financials({ job, reload }: { job: any; reload: (j?: any) => void }) {
  const { lk } = useMe();
  const [edit, setEdit] = useState<'cost' | 'selling' | null>(null);
  const fz = job.financials, cur = lk.currency;
  const save = (kind: 'cost' | 'selling') => async (lines: any[], discount?: string) => {
    const j = await api(`/api/jobs/${job.id}/financials`, { method: 'PUT', body: { [kind]: { lines, discount } } });
    setEdit(null); reload(j);
  };
  if (!fz.cost && !fz.commercial) return null;
  return (
    <>
      {fz.commercial && (
        <div className="panel">
          <div style={{ display: 'flex' }}><h2 style={{ flex: 1 }}>Customer billing</h2>
            {job.permissions.edit_selling && <button className="btn small" onClick={() => setEdit('selling')}>Edit</button>}</div>
          <table className="money-table"><tbody>
            {fz.commercial.lines.map((l: any) => <tr key={l.id}><td>{l.revenue_type}{l.description && <span className="muted"> · {l.description}</span>}</td><td>{fmtMoney(l.amount, cur)}</td></tr>)}
            {fz.commercial.lines.length === 0 && <tr><td className="muted">No selling price yet</td><td /></tr>}
            {Number(fz.commercial.discount) > 0 && <tr><td>Discount</td><td>−{fmtMoney(fz.commercial.discount, cur)}</td></tr>}
            <tr className="total"><td>Net revenue (before VAT)</td><td>{fmtMoney(fz.commercial.net_revenue, cur)}</td></tr>
            <tr><td>VAT {fz.commercial.vat_rate}%</td><td>{fmtMoney(fz.commercial.vat_amount, cur)}</td></tr>
            <tr><td><b>Customer total</b></td><td><b>{fmtMoney(fz.commercial.customer_total, cur)}</b></td></tr>
          </tbody></table>
        </div>
      )}
      {fz.cost && (
        <div className="panel">
          <div style={{ display: 'flex' }}><h2 style={{ flex: 1 }}>Transport cost</h2>
            {job.permissions.edit_cost && <button className="btn small" onClick={() => setEdit('cost')}>Edit</button>}</div>
          <table className="money-table"><tbody>
            {fz.cost.lines.map((l: any) => <tr key={l.id}><td>{l.expense_type}{l.description && <span className="muted"> · {l.description}</span>}</td><td>{fmtMoney(l.amount, cur)}</td></tr>)}
            {fz.cost.lines.length === 0 && <tr><td className="muted">No cost entered yet</td><td /></tr>}
            <tr className="total"><td>Total transport cost</td><td>{fmtMoney(fz.cost.total_cost, cur)}</td></tr>
          </tbody></table>
        </div>
      )}
      {fz.profit && (
        <div className="panel">
          <table className="money-table"><tbody>
            <tr className={Number(fz.profit.gross_profit) < 0 ? 'loss' : 'profit'}><td>Gross profit</td><td>{fmtMoney(fz.profit.gross_profit, cur)}</td></tr>
            <tr><td>Margin</td><td>{fz.profit.margin_pct === null ? '—' : fz.profit.margin_pct + '%'}</td></tr>
          </tbody></table>
        </div>
      )}
      {edit === 'cost' && <LinesEditor title="Transport cost" types={lk.expense_types} lines={fz.cost.lines} onSave={save('cost')} onClose={() => setEdit(null)} />}
      {edit === 'selling' && <LinesEditor title="Selling price" types={lk.revenue_types} lines={fz.commercial.lines}
        extra={{ discount: fz.commercial.discount }} onSave={save('selling')} onClose={() => setEdit(null)} />}
    </>
  );
}

export default function JobDetail({ params }: { params: { id: string } }) {
  const { lk } = useMe();
  const [job, setJob] = useState<any>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('overview');
  const [printing, setPrinting] = useState('');
  const load = (j?: any) => (j ? setJob(j) : api(`/api/jobs/${params.id}`).then(setJob).catch((e) => setErr(e.message)));
  useEffect(() => { load(); }, [params.id]);
  if (err) return <div className="page"><div className="msg err">{err}</div><Link href="/jobs">Back to jobs</Link></div>;
  if (!job) return <div className="page muted">Loading…</div>;
  const podMissing = job.status_stage === 'delivered' && ['pending', 'rejected'].includes(job.pod_status);
  const KV = ({ rows }: { rows: [string, any][] }) => (
    <dl className="kv">{rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v === null || v === undefined || v === '' ? '—' : v}</dd></Fragment>)}</dl>
  );
  return (
    <div className="page">
      <div className="page-head">
        <h1>Job No. {job.job_no ?? job.job_number}</h1>
        <span className="muted small">Request {job.job_number}</span>
        <span className="badge" style={{ background: job.status_color }}>{job.status_name}</span>
        {job.priority !== 'normal' && <span className="flag">{job.priority[0].toUpperCase() + job.priority.slice(1)} priority</span>}
        {podMissing && <span className="flag">Delivered, POD missing</span>}
        {job.request_docs?.ready > 0 && <button className="print-badge" style={{ cursor: 'pointer' }} onClick={() => setTab('documents')}>
          🖨 {job.request_docs.ready} document{job.request_docs.ready === 1 ? '' : 's'} to print</button>}
        <span className="spacer" />
        <button className="btn small" disabled={!!printing} title="One page for the driver, followed by the trip documents"
          onClick={() => { const docs = job.documents.filter((d: any) => d.is_request_doc && !d.expired);
            printFiles(docs.map((d: any) => `${docUrl(d.id)}?view=1`), setPrinting, tripSheetHtml(job, docs, lk.timezone)).catch((e) => { setPrinting(''); alert(e.message); }); }}>
          {printing || (job.request_docs?.ready ? `Print trip sheet + ${job.request_docs.ready} document${job.request_docs.ready === 1 ? '' : 's'}` : 'Print trip sheet')}</button>
        <span className="muted small">Requested by {job.requested_by_name} · {fmtDateTime(job.created_at)}</span>
      </div>
      <Lane job={job} statuses={lk.job_statuses} />
      {job.status_code === 'cancelled' && <div className="msg err">Cancelled{job.cancel_reason ? `: ${job.cancel_reason}` : ''}</div>}
      <JobActions job={job} onChange={(j) => setJob(j)} />
      <div className="cols">
        <div>
          <div className="tabs" role="tablist">
            {[['overview', 'Overview'], ['documents', `Documents (${job.documents.length})`], ['notes', `Notes (${job.notes.length})`], ['activity', `Activity (${job.activity.length})`]].map(([k, l]) =>
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === 'overview' && <>
            <div className="panel"><h2>Request</h2><KV rows={[
              ['Job No.', job.job_no], ['Request No.', job.job_number], ['Department', job.department_name], ['Customer', job.customer_name], ['Required', job.slot_from ? `${fmtDate(job.required_date)}, ${slot(job.slot_from, job.slot_to)}` : fmtDate(job.required_date)],
              ['BOE number', job.boe_number], ['Customer reference', job.customer_reference], ['Email subject', job.email_subject],
              ['Shipment / booking', [job.shipment_number, job.booking_reference].filter(Boolean).join(' / ') || null],
              ['Vehicle type needed', job.requested_vehicle_type]]} /></div>
            <div className="panel"><h2>Route</h2>
              <div className="grid g2">
                <KV rows={[['Pickup', job.pickup_name], ['Address', job.pickup_address], ['Contact', [job.pickup_contact_person, job.pickup_contact_number].filter(Boolean).join(', ') || null]]} />
                <KV rows={[['Delivery', job.delivery_name], ['Address', job.delivery_address], ['Contact person', job.delivery_contact_person],
                  ['Contact number', job.delivery_contact_number && <a href={`tel:${String(job.delivery_contact_number).replace(/[^\d+]/g, '')}`}>{job.delivery_contact_number}</a>]]} />
              </div></div>
            <div className="panel"><h2>Cargo</h2><KV rows={[
              ['Description', job.cargo_description], ['Type', job.cargo_type], ['Packages', job.packages],
              ['Weight', job.weight_kg && `${job.weight_kg} kg`], ['Volume', job.volume_cbm && `${job.volume_cbm} cbm`], ['Pallets', job.pallets],
              ['Temperature', job.temperature_requirement], ['Special handling', job.special_handling], ['Instructions', job.special_instructions]]} /></div>
            <div className="panel"><h2>Assignment</h2>
              {job.driver_id || job.vehicle_id ? <KV rows={[
                ['Driver', job.driver_name && `${job.driver_name}${job.driver_mobile ? ' · ' + job.driver_mobile : ''}`],
                ['Vehicle', job.vehicle_number && `${job.vehicle_number}${job.assigned_vehicle_type ? ` (${job.assigned_vehicle_type})` : ''}`],
                ['Hired from', job.rental_company],
                ['Planned pickup', fmtDateTime(job.planned_pickup_at)], ['ETA', fmtDateTime(job.planned_delivery_at)],
                ['Actual pickup', fmtDateTime(job.actual_pickup_at)], ['Actual delivery', fmtDateTime(job.actual_delivery_at)],
                ['Assigned by', job.assigned_by_name]]} />
                : <p className="muted" style={{ margin: 0 }}>Waiting for Transport to assign a driver and vehicle.</p>}
            </div>
          </>}
          {tab === 'activity' && <div className="panel"><ul className="timeline">
            {job.activity.map((a: any) => <li key={a.id}><span className="muted">{fmtDateTime(a.occurred_at)}</span>
              <span><b>{a.action}</b> · {a.user_name}{a.department_code ? ` (${a.department_code})` : ''}
                {(a.old_value || a.new_value) && <div className="muted small">{a.field ? a.field + ': ' : ''}{a.old_value ?? '—'} → {a.new_value ?? '—'}</div>}</span></li>)}
          </ul></div>}
          {tab === 'documents' && <DocumentsTab job={job} onChange={setJob} />}
          {tab === 'notes' && <NotesTab job={job} onChange={setJob} />}
        </div>
        <div><PodCard job={job} onChange={setJob} /><Financials job={job} reload={load} /></div>
      </div>
    </div>
  );
}
