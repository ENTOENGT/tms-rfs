import { requireActor } from '@/server/auth';
import { getJob } from '@/server/jobs';
import { updateRequest } from '@/server/workflow';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => getJob(await requireActor(req), params.id));
export const PATCH = route(async (req, { params }) => updateRequest(await requireActor(req), params.id, await body(req)));
