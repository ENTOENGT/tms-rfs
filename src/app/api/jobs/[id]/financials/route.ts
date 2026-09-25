import { requireActor } from '@/server/auth';
import { updateFinancials } from '@/server/jobs';
import { route, body } from '@/server/http';
export const PUT = route(async (req, { params }) => updateFinancials(await requireActor(req), params.id, await body(req)));
