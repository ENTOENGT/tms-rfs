import { requireActor } from '@/server/auth';
import { proConfig, saveProConfig } from '@/server/pro';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
// Authorities, activity types, statuses and reminder hours (Documentation Manager / Super Admin change them).
export const GET = route(async (req) => proConfig(await requireActor(req)));
export const POST = route(async (req) => saveProConfig(await requireActor(req), await body(req)));
