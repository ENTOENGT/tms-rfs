'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import RunForm from '@/components/RunForm';
export default function EditRun({ params }: { params: { id: string } }) {
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/runs/${params.id}`).then(setRun).catch((e) => setErr(e.message)); }, [params.id]);
  if (err) return <div className="page"><div className="msg err">{err}</div></div>;
  if (!run) return <div className="page muted">Loading…</div>;
  if (!run.can.edit) return <div className="page"><div className="msg err">This run can't be edited any more. Add a note instead.</div></div>;
  return <RunForm run={run} />;
}
