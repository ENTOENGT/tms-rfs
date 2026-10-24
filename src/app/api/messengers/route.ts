import { requireActor } from '@/server/auth';
import { messengersFor } from '@/server/runs';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => messengersFor(await requireActor(req), params(req).date));
