import { requireActor } from '@/server/auth';
import { setRolePermissions } from '@/server/admin';
import { route, body } from '@/server/http';
export const PUT = route(async (req, { params }) => setRolePermissions(await requireActor(req), params.id, (await body(req)).permissions));
