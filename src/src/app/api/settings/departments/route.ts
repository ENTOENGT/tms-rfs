import { requireActor } from '@/server/auth';
import { listDepartments, saveDepartment } from '@/server/admin';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listDepartments(await requireActor(req)));
export const POST = route(async (req) => saveDepartment(await requireActor(req), await body(req)));
