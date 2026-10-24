import { requireActor } from '@/server/auth';
import { updateRunStatus } from '@/server/runs';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => updateRunStatus(await requireActor(req), params.id, await body(req)));
