import { requireActor, requirePerm } from '@/server/auth';
import { cleanupStatus, runDocumentCleanup } from '@/server/documents';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
// Settings → Document clean-up: see recent runs and failures, or run it now.
export const GET = route(async (req) => cleanupStatus(await requireActor(req)));
export const POST = route(async (req) => {
  const a = await requireActor(req);
  requirePerm(a, 'settings.manage');
  return runDocumentCleanup('manual');
});
