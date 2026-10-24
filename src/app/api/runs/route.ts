import { requireActor } from '@/server/auth';
import { listRuns, createRun } from '@/server/runs';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listRuns(await requireActor(req), params(req)));
export const POST = route(async (req) => createRun(await requireActor(req), await body(req)));
