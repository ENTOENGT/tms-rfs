import { requireActor } from '@/server/auth';
import { financials } from '@/server/financials';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => financials(await requireActor(req), params(req)));
