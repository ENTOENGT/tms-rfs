import { requireActor } from '@/server/auth';
import { setPodNotRequired } from '@/server/workflow';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => setPodNotRequired(await requireActor(req), params.id, Boolean((await body(req)).not_required)));
