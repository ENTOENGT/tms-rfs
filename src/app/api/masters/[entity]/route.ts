import { requireActor } from '@/server/auth';
import { listMaster, createMaster } from '@/server/masters';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params: p }) => listMaster(await requireActor(req), p.entity, params(req)));
export const POST = route(async (req, { params: p }) => createMaster(await requireActor(req), p.entity, await body(req)));
