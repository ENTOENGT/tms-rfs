import { requireActor } from '@/server/auth';
import { requestRunUpload } from '@/server/runs';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => requestRunUpload(await requireActor(req), params.id, await body(req)));
