import { requireActor } from '@/server/auth';
import { listJobs, createJob } from '@/server/jobs';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listJobs(await requireActor(req), params(req)));
export const POST = route(async (req) => createJob(await requireActor(req), await body(req)));
