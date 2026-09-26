import { requireActor } from '@/server/auth';
import { updateMaster, deleteMaster } from '@/server/masters';
import { route, body } from '@/server/http';
export const PATCH = route(async (req, { params: p }) => updateMaster(await requireActor(req), p.entity, p.id, await body(req)));
export const DELETE = route(async (req, { params: p }) => deleteMaster(await requireActor(req), p.entity, p.id));
