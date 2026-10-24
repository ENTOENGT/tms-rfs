import { requireActor } from '@/server/auth';
import { requestUpload } from '@/server/documents';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => requestUpload(await requireActor(req), params.id, await body(req)));
