/**
 * Phase 5 — financial dashboard.
 * Same confidentiality layers as a single job:
 *  - Revenue / VAT / profit columns are only selected when the caller can see them.
 *  - Response objects are built field by field (cost-only for Transport).
 *  - Grouped results are ranked by cost for cost-only users, so ordering can't hint at revenue.
 * Amounts exclude VAT. Profit = net revenue before VAT − total transport cost.
 * Jobs counted: everything except drafts and cancelled jobs, by required date.
 */
import { Actor } from './auth';
import { bad, forbidden, q } from './db';
import { fromFils, toFils } from '../lib/finance';
import { jobScope } from './scope';

const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function financials(actor: Actor, p: Record<string, string>) {
  const { fin } = actor;
  if (!fin.buyingView && !fin.sellingView) throw forbidden();
  if (!DATE.test(p.from ?? '') || !DATE.test(p.to ?? '')) throw bad('Choose a period');
  if (p.to < p.from) throw bad('The end date is before the start date');

  const params: unknown[] = [p.from, p.to];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let where = `where t.deleted_at is null and t.status_code not in ('draft','cancelled') and t.required_date between $1 and $2`;
  where += jobScope(actor, params);
  const ids: Record<string, string> = {
    department_id: 't.department_id', customer_id: 't.customer_id', driver_id: 'a.driver_id', vehicle_id: 'a.vehicle_id', requested_by: 't.requested_by', assigned_by: 'a.assigned_by',
    vehicle_type_id: 'coalesce(a.vehicle_type_id, t.requested_vehicle_type_id)',
  };
  for (const [k, col] of Object.entries(ids)) if (p[k]) {
    if (!UUID.test(p[k])) throw bad('Invalid filter');
    where += ` and ${col} = ${add(p[k])}`;
  }
  if (p.status) where += ` and t.status_code = any(${add(p.status.split(','))})`;
  if (p.completed_only === '1') where += ` and t.status_code = 'completed'`;
  if (p.job_number) where += ` and t.job_number ilike ${add('%' + p.job_number.trim() + '%')}`;
  if (p.boe) where += ` and t.boe_number ilike ${add('%' + p.boe.trim() + '%')}`;

  const jobs = await q(`
    select t.id, to_char(t.required_date, 'YYYY-MM') as month_key, t.status_code, s.name status_name, s.color status_color, s.sort_order,
      t.customer_id, c.name customer_name, t.department_id, coalesce(dep.name, 'No department') department_name,
      a.driver_id, dr.full_name driver_name, a.vehicle_id, ve.vehicle_number,
      coalesce(a.vehicle_type_id, t.requested_vehicle_type_id) vehicle_type_id, vt.name vehicle_type_name
      ${fin.buyingView ? ', cost.total_cost, cost.base_cost' : ''}
      ${fin.sellingView ? ', (rev.gross - coalesce(jc.discount,0)) net, round((rev.gross - coalesce(jc.discount,0)) * coalesce(jc.vat_rate,0) / 100, 2) vat' : ''}
    from transport_requests t
    join customers c on c.id = t.customer_id
    left join departments dep on dep.id = t.department_id
    join job_statuses s on s.code = t.status_code
    left join transport_assignments a on a.job_id = t.id and a.is_current
    left join drivers dr on dr.id = a.driver_id
    left join vehicles ve on ve.id = a.vehicle_id
    left join vehicle_types vt on vt.id = coalesce(a.vehicle_type_id, t.requested_vehicle_type_id)
    ${fin.buyingView ? `left join lateral (select coalesce(sum(amount),0) total_cost,
        coalesce(sum(amount) filter (where expense_type_code = 'base'),0) base_cost from job_cost_lines where job_id = t.id) cost on true` : ''}
    ${fin.sellingView ? `left join job_commercials jc on jc.job_id = t.id
      left join lateral (select coalesce(sum(amount),0) gross from job_revenue_lines where job_id = t.id) rev on true` : ''}
    ${where}`, params);

  // Aggregate in integer fils — no rounding drift across thousands of jobs.
  type Acc = { key: string; label: string; jobs: number; completed: number; cost: number; base: number; net: number; vat: number; color?: string; order?: number };
  const blank = (key: string, label: string): Acc => ({ key, label, jobs: 0, completed: 0, cost: 0, base: 0, net: 0, vat: 0 });
  const total = blank('all', 'All');
  const groups: Record<string, Map<string, Acc>> = { month: new Map(), status: new Map(), department: new Map(), customer: new Map(), driver: new Map(), vehicle: new Map(), vehicle_type: new Map() };
  const bump = (g: string, key: string, label: string, j: any, extra: Partial<Acc> = {}) => {
    const m = groups[g];
    if (!m.has(key)) m.set(key, { ...blank(key, label), ...extra });
    acc(m.get(key)!, j);
  };
  const acc = (x: Acc, j: any) => {
    x.jobs++; if (j.status_code === 'completed') x.completed++;
    if (fin.buyingView) { x.cost += toFils(j.total_cost); x.base += toFils(j.base_cost); }
    if (fin.sellingView) { x.net += toFils(j.net); x.vat += toFils(j.vat); }
  };
  for (const j of jobs) {
    acc(total, j);
    bump('month', j.month_key, j.month_key, j);
    bump('status', j.status_code, j.status_name, j, { color: j.status_color, order: j.sort_order });
    bump('customer', j.customer_id, j.customer_name, j);
    bump('department', j.department_id ?? 'none', j.department_name, j);
    bump('driver', j.driver_id ?? 'none', j.driver_name ?? 'Unassigned', j);
    bump('vehicle', j.vehicle_id ?? 'none', j.vehicle_number ?? 'Unassigned', j);
    bump('vehicle_type', j.vehicle_type_id ?? 'none', j.vehicle_type_name ?? 'Not specified', j);
  }

  // Fill empty months so the chart has no gaps (up to 36 months).
  const months: string[] = [];
  for (let d = new Date(p.from.slice(0, 7) + '-01T00:00:00Z'); d <= new Date(p.to + 'T00:00:00Z') && months.length < 36; d.setUTCMonth(d.getUTCMonth() + 1))
    months.push(d.toISOString().slice(0, 7));

  // Whitelisted output per access level
  const out = (x: Acc) => {
    const r: Record<string, unknown> = { key: x.key, label: x.label, jobs: x.jobs, completed: x.completed };
    if (x.color) r.color = x.color;
    if (fin.buyingView) {
      r.total_cost = fromFils(x.cost); r.base_cost = fromFils(x.base); r.other_expenses = fromFils(x.cost - x.base);
      r.avg_cost = x.jobs ? fromFils(Math.round(x.cost / x.jobs)) : null;
    }
    if (fin.sellingView) {
      r.net_revenue = fromFils(x.net); r.vat = fromFils(x.vat); r.revenue_incl_vat = fromFils(x.net + x.vat);
      r.avg_revenue = x.jobs ? fromFils(Math.round(x.net / x.jobs)) : null;
    }
    if (fin.profitView) {
      const pr = x.net - x.cost;
      r.gross_profit = fromFils(pr);
      r.margin_pct = x.net ? (Math.round((pr * 10000) / x.net) / 100).toFixed(2) : null;
      r.avg_profit = x.jobs ? fromFils(Math.round(pr / x.jobs)) : null;
    }
    return r;
  };
  const rank = (m: Map<string, Acc>) => [...m.values()].sort((a, b) =>
    (fin.sellingView ? b.net - a.net : fin.buyingView ? b.cost - a.cost : 0) || b.jobs - a.jobs || a.label.localeCompare(b.label)).slice(0, 200).map(out);

  return {
    access: { cost: fin.buyingView, revenue: fin.sellingView, profit: fin.profitView },
    period: { from: p.from, to: p.to },
    totals: out(total),
    by_month: months.map((mo) => out(groups.month.get(mo) ?? blank(mo, mo))),
    by_status: [...groups.status.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(out),
    by_department: rank(groups.department),
    by_customer: rank(groups.customer),
    by_driver: rank(groups.driver),
    by_vehicle: rank(groups.vehicle),
    by_vehicle_type: rank(groups.vehicle_type),
  };
}
