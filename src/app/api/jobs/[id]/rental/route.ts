import { requireActor } from '@/server/auth';
import { requestRental } from '@/server/rentals';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
// Hire a rental truck for this job (approved at once for a Transport Manager, otherwise sent for approval).
export const POST = route(async (req, { params }) => requestRental(await requireActor(req), params.id, await body(req)));
