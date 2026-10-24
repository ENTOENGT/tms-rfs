import { requireActor } from '@/server/auth';
import { addRunNote } from '@/server/runs';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => addRunNote(await requireActor(req), params.id, await body(req)));
