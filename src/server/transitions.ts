import { Actor } from './auth';
import { q } from './db';
import { isDriverOnly } from './scope';

/** The only steps a driver can take from the phone. */
export const DRIVER_STEPS = ['dispatched', 'picked_up', 'in_transit', 'delivered'];

export async function allowedTransitions(actor: Actor, job: { status_code: string; pod_status?: string }) {
  const rows = await q(`select tr.to_code code, s.name, s.stage from status_transitions tr join job_statuses s on s.code = tr.to_code
    where tr.from_code = $1 and s.is_active order by s.sort_order`, [job.status_code]);
  // "Assigned" is reached through the Assign dialog, not a plain status button
  const podOk = ['uploaded', 'verified', 'not_required'].includes(job.pod_status ?? '');
  return rows.filter((r) => canMove(actor, job.status_code, r.code, r.stage) &&
    // "Assigned" is reached through the Assign dialog, not a plain status button
    !(r.code === 'assigned' && ['requested', 'pending_assignment'].includes(job.status_code)) &&
    // POD statuses follow the POD itself (upload → POD Received, reject → POD Pending)
    !['pod_pending', 'pod_received'].includes(r.code) &&
    // Completing needs the POD (or "not required") — don't offer a button that would fail
    !(r.code === 'completed' && !podOk));
}
export function canMove(actor: Actor, from: string, to: string, toStage: string) {
  if (actor.isSuperAdmin) return true;
  if (isDriverOnly(actor)) return DRIVER_STEPS.includes(to) && actor.has('jobs.update_status');
  if (to === 'cancelled') return actor.has('jobs.cancel');
  if (from === 'draft' && to === 'pending_assignment') return actor.has('jobs.create');
  if (to === 'pending_assignment') return actor.has('jobs.assign_driver') || actor.has('jobs.assign_vehicle');
  if (from === 'dispatched' && to === 'assigned') return actor.has('jobs.override_conflicts');
  void toStage;
  return actor.has('jobs.update_status');
}

