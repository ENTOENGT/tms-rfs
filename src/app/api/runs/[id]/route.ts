import { requireActor } from '@/server/auth';
import { getRun, updateRun } from '@/server/runs';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => getRun(await requireActor(req), params.id));
export const PATCH = route(async (req, { params }) => updateRun(await requireActor(req), params.id, await body(req)));
