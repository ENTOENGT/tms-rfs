import { requireActor } from '@/server/auth';
import { appLinkForDriver, appLinkForUser } from '@/server/applink';
import { bad } from '@/server/db';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
// "Send app link": { driver_id } from the Drivers page, or { user_id } from the Users page.
export const POST = route(async (req) => {
  const actor = await requireActor(req);
  const b = await body(req);
  if (b.driver_id) return appLinkForDriver(actor, String(b.driver_id));
  if (b.user_id) return appLinkForUser(actor, String(b.user_id));
  throw bad('Choose a driver or a user');
});
