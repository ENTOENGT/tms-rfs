import { requireActor } from '@/server/auth';
import { addNote } from '@/server/documents';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => addNote(await requireActor(req), params.id, await body(req)));
