'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { nextStep } from '@/components/DriverApp';

const OPEN = 'assigned,confirmed,dispatched,picked_up,in_transit,delivered,pod_pending';
const DONE = 'pod_received,completed,cancelled';
/** A driver's own jobs on the phone: today's work first, big cards. */
export default function MyJobs() {
  const [done, setDone] = useState(false);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const load = () => api(`/api/jobs?status=${done ? DONE : OPEN}&sort=required_date&dir=${done ? 'desc' : 'asc'}&page_size=${done ? 30 : 100}`)
    .then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { setData(null); load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [done]);
  return (
    <div className="app-page">
      <div className="app-tabs">
        <button className={done ? '' : 'on'} onClick={() => setDone(false)}>To do</button>
        <button className={done ? 'on' : ''} onClick={() => setDone(true)}>Finished</button>
      </div>
      {err && <div className="msg err">{err}</div>}
      {!data && !err && <p className="muted">Loading…</p>}
      {data?.rows.length === 0 && <div className="panel"><p style={{ margin: 0 }}>{done ? 'No finished jobs yet.' : 'No jobs for you right now. New jobs appear here — you also get a notification.'}</p></div>}
      {data?.rows.map((j: any) => {
        const step = nextStep(j);
        return (
          <Link key={j.id} href={`/my-jobs/${j.id}`} className="app-card">
            <div className="app-card-head">
              <b>{j.job_no ?? j.job_number}</b>
              <span className="badge" style={{ background: j.status_color }}>{j.status_name}</span>
              {j.priority === 'urgent' && <span className="flag">Urgent</span>}
            </div>
            <div className="app-when">{j.planned_pickup_at ? fmtDateTime(j.planned_pickup_at) : fmtDate(j.required_date)}{j.vehicle_number && <> · {j.vehicle_number}</>}</div>
            <div className="app-route"><span>From</span><b>{j.pickup_name}</b></div>
            <div className="app-route"><span>To</span><b>{j.delivery_name}</b></div>
            {!done && step && <div className="app-next">{step} ›</div>}
          </Link>
        );
      })}
    </div>
  );
}
