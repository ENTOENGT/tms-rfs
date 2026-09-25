import { requireActor } from '@/server/auth';
import { listRoles, createRole } from '@/server/admin';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listRoles(await requireActor(req)));
export const POST = route(async (req) => createRole(await requireActor(req), await body(req)));
