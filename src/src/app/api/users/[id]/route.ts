import { requireActor } from '@/server/auth';
import { updateUser } from '@/server/admin';
import { route, body } from '@/server/http';
export const PATCH = route(async (req, { params }) => updateUser(await requireActor(req), params.id, await body(req)));
