import { requireActor } from '@/server/auth';
import { exportReport, runReport } from '@/server/reports';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
// ?format=csv|xlsx downloads the whole report; otherwise returns a page of rows as JSON.
export const GET = route(async (req, { params: p }) => {
  const actor = await requireActor(req);
  const qs = params(req);
  if (qs.format) {
    const f = await exportReport(actor, p.type, qs, qs.format);
    return new Response(f.body, { headers: { 'Content-Type': f.type, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${f.name}"` } });
  }
  return runReport(actor, p.type, qs, { all: qs.all === '1' });
});
