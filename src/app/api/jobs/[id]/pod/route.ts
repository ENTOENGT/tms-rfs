import { requireActor } from '@/server/auth';
import { reviewPod } from '@/server/documents';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => reviewPod(await requireActor(req), params.id, await body(req)));
