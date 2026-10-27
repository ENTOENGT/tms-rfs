import { requireActor } from '@/server/auth';
import { storageCheck } from '@/server/documents';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';   // storage links must always be fresh
export const POST = route(async (req) => storageCheck(await requireActor(req)));
