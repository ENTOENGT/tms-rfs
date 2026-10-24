import { Actor } from './auth';

/**
 * Which jobs a user may see. Used by EVERY query that reads jobs, so the rule is the same
 * on screens, searches, dashboards, financials, reports, exports and documents.
 *   jobs.view_all         → every department (Super Admin, Transport, Finance)
 *   jobs.view_department  → jobs of their own department (+ any they requested themselves)
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
  return ` and ${alias}.requested_by = ${me}`;
}
