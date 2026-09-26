import { Actor } from './auth';
import { q } from './db';

export async function allowedTransitions(actor: Actor, job: { status_code: string }) {
  const rows = await q(`select tr.to_code code, s.name, s.stage from status_transitions tr join job_statuses s on s.code = tr.to_code
    where tr.from_code = $1 and s.is_active order by s.sort_order`, [job.status_code]);
  // "Assigned" is reached through the Assign dialog, not a plain status button
  return rows.filter((r) => canMove(actor, job.status_code, r.code, r.stage) &&
    !(r.code === 'assigned' && ['requested', 'pending_assignment'].includes(job.status_code)));
}
export function canMove(actor: Actor, from: string, to: string, toStage: string) {
  if (actor.isSuperAdmin) return true;
  if (to === 'cancelled') return actor.has('jobs.cancel');
  if (from === 'draft' && to === 'pending_assignment') return actor.has('jobs.create');
  if (to === 'pending_assignment') return actor.has('jobs.assign_driver') || actor.has('jobs.assign_vehicle');
  if (from === 'dispatched' && to === 'assigned') return actor.has('jobs.override_conflicts');
  void toStage;
  return actor.has('jobs.update_status');
}

