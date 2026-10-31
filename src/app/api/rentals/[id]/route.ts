import { requireActor } from '@/server/auth';
import { approveRental, rejectRental, updateRentalBill } from '@/server/rentals';
import { bad } from '@/server/db';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
// { action: 'approve' | 'reject' | 'withdraw' | 'bill', ... }
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  if (b.action === 'approve') return approveRental(a, params.id, b);
  if (b.action === 'reject') return rejectRental(a, params.id, b);
  if (b.action === 'withdraw') return rejectRental(a, params.id, { ...b, cancel: true, reason: b.reason || 'Withdrawn by requester' });
  if (b.action === 'bill') return updateRentalBill(a, params.id, b);
  throw bad('Unknown action');
});
