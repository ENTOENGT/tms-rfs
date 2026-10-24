import { requireActor } from '@/server/auth';
import { confirmUpload } from '@/server/documents';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => confirmUpload(await requireActor(req), params.id, await body(req)));
