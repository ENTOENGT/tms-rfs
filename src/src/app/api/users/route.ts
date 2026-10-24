import { requireActor } from '@/server/auth';
import { listUsers, createUser } from '@/server/admin';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listUsers(await requireActor(req)));
export const POST = route(async (req) => createUser(await requireActor(req), await body(req)));
