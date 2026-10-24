import { Actor } from './auth';

/**
 * Which jobs a user may see. Used by EVERY query that reads jobs, so the rule is the same
 * on screens, searches, dashboards, financials, reports, exports and documents.
 *   jobs.view_all         → every department (Super Admin, Transport, Finance)
 *   jobs.view_department  → jobs of their own department (+ any they requested themselves)
 *   jobs.view_assigned    → only the jobs assigned to them as the driver (phone app)
 *   otherwise             → only the jobs they requested themselves
 * Adds its values to `params` and returns an SQL fragment starting with " and ".
 */
export function jobScope(actor: Actor, params: unknown[], alias = 't'): string {
  if (actor.has('jobs.view_all')) return '';
  params.push(actor.id);
  const me = `$${params.length}`;
  if (actor.has('jobs.view_department') && actor.department_id) {
    params.push(actor.department_id);
    return ` and (${alias}.department_id = $${params.length} or ${alias}.requested_by = ${me})`;
  }
  if (actor.has('jobs.view_assigned'))
    return ` and (${alias}.requested_by = ${me} or exists (select 1 from transport_assignments sa join drivers sd on sd.id = sa.driver_id
      where sa.job_id = ${alias}.id and sa.is_current and sd.user_id = ${me} and sd.deleted_at is null))`;
  return ` and ${alias}.requested_by = ${me}`;
}

/** A driver on the phone app: sees only their own jobs and can only move them along the road. */
export const isDriverOnly = (a: Actor) => a.has('jobs.view_assigned') && !a.has('jobs.view_all') && !a.has('jobs.view_department');
/** May open job screens at all (list/detail). Drivers only reach their own jobs through jobScope. */
export const canViewJobs = (a: Actor) => a.has('jobs.view') || a.has('jobs.view_assigned');
