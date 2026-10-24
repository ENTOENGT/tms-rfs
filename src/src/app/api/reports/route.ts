import { requireActor } from '@/server/auth';
import { reportList } from '@/server/reports';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => reportList(await requireActor(req)));
