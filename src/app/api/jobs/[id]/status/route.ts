import { requireActor } from '@/server/auth';
import { changeStatus } from '@/server/workflow';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => changeStatus(await requireActor(req), params.id, await body(req)));
