import { requireActor } from '@/server/auth';
import { saveStatus } from '@/server/workflow';
import { route, body } from '@/server/http';
export const POST = route(async (req) => saveStatus(await requireActor(req), await body(req)));
