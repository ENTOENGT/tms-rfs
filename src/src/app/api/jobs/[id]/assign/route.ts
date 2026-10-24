import { requireActor } from '@/server/auth';
import { assignJob } from '@/server/workflow';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => assignJob(await requireActor(req), params.id, await body(req)));
