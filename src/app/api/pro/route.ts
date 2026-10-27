import { requireActor } from '@/server/auth';
import { createPro, listContainers, listPro, proDashboard, proOfficers } from '@/server/pro';
import { forbidden } from '@/server/db';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
// GET: list (?containers=1 container overview, ?dashboard=1 tiles, ?officers=1 for assigning). POST: new PRO request.
export const GET = route(async (req) => {
  const a = await requireActor(req);
  const p = params(req);
  if (p.dashboard === '1') return proDashboard(a, p);
  if (p.containers === '1') return listContainers(a, p);
  if (p.officers === '1') { if (!a.isSuperAdmin && !a.has('pro.assign')) throw forbidden(); return proOfficers(); }
  return listPro(a, p);
});
export const POST = route(async (req) => createPro(await requireActor(req), await body(req)));
