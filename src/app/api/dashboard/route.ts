import { requireActor } from '@/server/auth';
import { dashboard } from '@/server/jobs';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => { const p = params(req); return dashboard(await requireActor(req), p.from, p.to); });
