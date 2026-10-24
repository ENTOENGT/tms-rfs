import { requireActor } from '@/server/auth';
import { resetPassword } from '@/server/admin';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => resetPassword(await requireActor(req), params.id, await body(req)));
