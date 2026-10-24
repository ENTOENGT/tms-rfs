import { requireActor } from '@/server/auth';
import { listNotifications, markNotificationsRead } from '@/server/admin';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listNotifications(await requireActor(req)));
export const POST = route(async (req) => markNotificationsRead(await requireActor(req), (await body(req)).ids));
