import { requireActor } from '@/server/auth';
import { lookups } from '@/server/admin';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => lookups(await requireActor(req)));
