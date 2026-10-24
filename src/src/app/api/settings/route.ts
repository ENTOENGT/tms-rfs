import { requireActor } from '@/server/auth';
import { getSettings, saveSettings } from '@/server/workflow';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => getSettings(await requireActor(req)));
export const PUT = route(async (req) => saveSettings(await requireActor(req), await body(req)));
