'use client';
import MasterPage from '@/components/MasterPage';

const MASTER_PAGES = ['drivers', 'vehicles', 'customers', 'locations'];
const PLAN: Record<string, [string, number, string]> = {
  reports: ['Reports', 6, 'Operational, financial, driver, vehicle, customer and POD-pending reports with Excel/CSV/PDF export.'],
};
export default function Section({ params }: { params: { section: string } }) {
  if (MASTER_PAGES.includes(params.section)) return <MasterPage entity={params.section} />;
  const p = PLAN[params.section];
  if (!p) return <div className="page"><h1>Page not found</h1></div>;
  return (
    <div className="page">
      <div className="page-head"><h1>{p[0]}</h1></div>
      <div className="panel"><p style={{ marginTop: 0 }}>{p[2]}</p><p className="muted" style={{ marginBottom: 0 }}>Scheduled for Phase {p[1]}.</p></div>
    </div>
  );
}
