import { requireActor } from '@/server/auth';
import { deleteNote } from '@/server/documents';
import { route } from '@/server/http';
export const DELETE = route(async (req, { params }) => deleteNote(await requireActor(req), params.id));
