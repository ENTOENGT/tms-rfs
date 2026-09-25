import { requireActor } from '@/server/auth';
import { createCustomer } from '@/server/admin';
import { route, body } from '@/server/http';
export const POST = route(async (req) => createCustomer(await requireActor(req), await body(req)));
