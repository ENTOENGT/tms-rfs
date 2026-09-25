import { requireActor } from '@/server/auth';
import { getJob } from '@/server/jobs';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => getJob(await requireActor(req), params.id));
