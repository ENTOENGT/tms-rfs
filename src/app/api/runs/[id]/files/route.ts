import { requireActor } from '@/server/auth';
import { confirmRunUpload } from '@/server/runs';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => confirmRunUpload(await requireActor(req), params.id, await body(req)));
