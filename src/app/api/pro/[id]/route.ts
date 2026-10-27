import { requireActor } from '@/server/auth';
import { addProNote, assignPro, confirmProUpload, getPro, requestProUpload, saveActivity, saveCharge, saveContainer, setProStatus, updatePro } from '@/server/pro';
import { bad } from '@/server/db';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getPro(await requireActor(req), params.id));
export const PATCH = route(async (req, { params }) => updatePro(await requireActor(req), params.id, await body(req)));
// One door for every change on a request; each action checks its own permission.
const ACTIONS: Record<string, (a: any, id: string, b: any) => Promise<unknown>> = {
  status: setProStatus, assign: assignPro, container: saveContainer, activity: saveActivity, charge: saveCharge, note: addProNote,
  'upload-url': requestProUpload, 'upload-confirm': confirmProUpload,
};
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  const fn = ACTIONS[String(b.action ?? '')];
  if (!fn) throw bad('Unknown action');
  return fn(a, params.id, b);
});
