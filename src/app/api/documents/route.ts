import { requireActor } from '@/server/auth';
import { listDocuments } from '@/server/documents';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';   // storage links must always be fresh
export const GET = route(async (req) => listDocuments(await requireActor(req), params(req)));
