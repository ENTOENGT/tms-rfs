import { requireActor } from '@/server/auth';
import { deleteDocument } from '@/server/documents';
import { route } from '@/server/http';
export const DELETE = route(async (req, { params }) => deleteDocument(await requireActor(req), params.id));
