'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import RequestForm from '@/components/RequestForm';

export default function EditRequest({ params }: { params: { id: string } }) {
  const [job, setJob] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/jobs/${params.id}`).then(setJob).catch((e) => setErr(e.message)); }, [params.id]);
  if (err) return <div className="page"><div className="msg err">{err}</div></div>;
  if (!job) return <div className="page muted">Loading…</div>;
  if (!job.permissions.edit_request) return <div className="page"><div className="msg err">This request can no longer be edited by you.</div></div>;
  return <RequestForm job={job} />;
}
