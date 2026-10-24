'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate } from './api';
import { useMe } from './Shell';
import { MASTERS, MasterField } from '@/lib/masters';

const STATUS_LABEL: Record<string, string> = {
  available: 'Available', on_leave: 'On leave', off_duty: 'Off duty', inactive: 'Inactive', maintenance: 'In maintenance', assigned: 'Assigned',
};

function expiryFlag(d: string | null, warnDays: number) {
  if (!d) return null;
  const days = Math.floor((new Date(d + 'T00:00:00').getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
  if (days < 0) return <span className="badge" style={{ background: '#9B2C2C' }}>Expired</span>;
  if (days <= warnDays) return <span className="flag">{days === 0 ? 'Today' : `${days} days`}</span>;
  return null;
}

function Form({ entity, row, onDone, onClose }: { entity: string; row: any; onDone: (m: string) => void; onClose: () => void }) {
  const d = MASTERS[entity];
  const { lk } = useMe();
  const [f, setF] = useState<any>(() => {
    const init: any = {};
    d.fields.forEach((x) => { init[x.key] = row?.[x.key] ?? (x.type === 'bool' ? true : x.key === 'status' ? 'available' : ''); });
    return init;
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const refs: Record<string, any[]> = { vehicle_types: lk.vehicle_types, drivers: lk.drivers, customers: lk.customers };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (row?.id) await api(`/api/masters/${entity}/${row.id}`, { method: 'PATCH', body: f });
      else await api(`/api/masters/${entity}`, { body: f });
      onDone(`${d.singular[0].toUpperCase() + d.singular.slice(1)} saved`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const input = (x: MasterField) => {
    const v = f[x.key] ?? '';
    const on = (e: any) => setF({ ...f, [x.key]: x.type === 'bool' ? e.target.checked : e.target.value });
    switch (x.type) {
      case 'longtext': return <textarea value={v} onChange={on} />;
      case 'bool': return <input type="checkbox" style={{ width: 'auto' }} checked={!!v} onChange={on} />;
      case 'select': return <select value={v} onChange={on}>{!x.required && <option value="">—</option>}
        {x.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
      case 'ref': return <select value={v} onChange={on}><option value="">{x.required ? 'Choose…' : 'None'}</option>
        {(refs[x.ref!] ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
      case 'date': return <input type="date" value={v} onChange={on} />;
      case 'number': case 'int': return <input type="number" step={x.type === 'int' ? 1 : 'any'} value={v} onChange={on} />;
      case 'email': return <input type="email" value={v} onChange={on} />;
      case 'phone': return <input type="tel" value={v} onChange={on} placeholder="+971 50 123 4567" />;
      default: return <input value={v} onChange={on} />;
    }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={row?.id ? `Edit ${d.singular}` : `Add ${d.singular}`}>
        <h2>{row?.id ? `Edit ${d.singular}` : `Add ${d.singular}`}</h2>
        {err && <div className="msg err">{err}</div>}
        <div className="grid g2">
          {d.fields.map((x) => (
            <label key={x.key} className={`f${x.half ? '' : ' span2'}`}>
              <span>{x.label}{x.required && <em> *</em>}</span>{input(x)}
            </label>
          ))}
        </div>
        <div className="actions"><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>{row?.id ? 'Save changes' : `Add ${d.singular}`}</button></div>
      </div>
    </div>
  );
}

export default function MasterPage({ entity, embedded }: { entity: string; embedded?: boolean }) {
  const d = MASTERS[entity];
  const { can, lk, reloadLookups } = useMe();
  const [q, setQ] = useState('');
  const [data, setData] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: string; m: string } | null>(null);
  const canEdit = can(d.perm);
  const load = () => api(`/api/masters/${entity}?q=${encodeURIComponent(q)}&page_size=500`).then(setData).catch((e) => setMsg({ t: 'err', m: e.message }));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q, entity]);
  const remove = async (r: any) => {
    if (!confirm(`Remove ${r[d.fields[0].key]}? It stays on past jobs.`)) return;
    try { await api(`/api/masters/${entity}/${r.id}`, { method: 'DELETE' }); setMsg({ t: 'ok', m: 'Removed' }); load(); reloadLookups(); }
    catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const cols = d.fields.filter((x) => x.list);
  const cell = (r: any, x: MasterField) => {
    const v = r[x.key];
    if (x.type === 'ref') return r[d.display?.[x.key] ?? ''] ?? '—';
    if (x.type === 'bool') return v ? 'Yes' : <span className="muted">No</span>;
    if (x.key === 'status') return <span className={v === 'available' ? '' : 'flag'}>{STATUS_LABEL[v] ?? v}</span>;
    if (x.type === 'date') return <>{fmtDate(v)} {x.expiry && expiryFlag(v, Number(lk.expiry_warning_days ?? 30))}</>;
    if (x.type === 'number' && v != null) return Number(v).toLocaleString('en-US');
    return v ?? '—';
  };
  const Head = embedded ? 'h2' : 'h1';
  return (
    <div className={embedded ? '' : 'page'}>
      <div className="page-head">
        <Head style={embedded ? { margin: 0 } : undefined}>{d.title}</Head>
        <span className="spacer" />
        <input style={{ width: 240 }} placeholder={`Search ${d.title.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        {canEdit && <button className="btn primary" onClick={() => setEdit({})}>Add {d.singular}</button>}
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>{d.blurb}</p>
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr>{cols.map((x) => <th key={x.key}>{x.label}</th>)}{canEdit && <th />}</tr></thead>
        <tbody>
          {data?.rows.map((r: any) => (
            <tr key={r.id}>
              {cols.map((x, i) => <td key={x.key}>{i === 0 ? <b>{cell(r, x)}</b> : cell(r, x)}</td>)}
              {canEdit && <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                <button className="btn small" onClick={() => setEdit(r)}>Edit</button>{' '}
                <button className="btn small danger" onClick={() => remove(r)}>Remove</button></td>}
            </tr>))}
          {data && data.rows.length === 0 && <tr><td colSpan={cols.length + 1} className="muted" style={{ padding: 24, textAlign: 'center' }}>
            {q ? 'Nothing matches that search.' : `No ${d.title.toLowerCase()} yet.`}{canEdit && !q && <> <a href="#" onClick={(e) => { e.preventDefault(); setEdit({}); }}>Add the first {d.singular}</a>.</>}
          </td></tr>}
        </tbody>
      </table></div>
        <div className="pager"><span>{data ? `${data.total} ${data.total === 1 ? d.singular : d.title.toLowerCase()}` : 'Loading…'}</span></div>
      </div>
      {edit && <Form entity={entity} row={edit} onClose={() => setEdit(null)}
        onDone={(m) => { setEdit(null); setMsg({ t: 'ok', m }); load(); reloadLookups(); }} />}
    </div>
  );
}
