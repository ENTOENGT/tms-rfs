import { requireActor } from '@/server/auth';
import { assignRun } from '@/server/runs';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => assignRun(await requireActor(req), params.id, await body(req)));
