import { requireActor } from '@/server/auth';
import { availability } from '@/server/workflow';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => availability(await requireActor(req), params(req)));
