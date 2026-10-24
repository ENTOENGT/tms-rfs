import { requireActor } from '@/server/auth';
import { runCounts } from '@/server/runs';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => (await runCounts(await requireActor(req))) ?? {});
