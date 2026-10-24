/**
 * Phase 6 — Reports.
 * Every report (screen, print, CSV, Excel) is produced by the same server function, so the
 * confidentiality rules apply identically everywhere:
 *  - columns needing revenue / cost / profit are dropped server-side for users who can't see them
 *  - commercial tables are only joined when needed and allowed
 *  - sorting is only allowed on columns the user can see (no ranking by hidden revenue)
 * Exports are logged in the audit trail (who exported which report, with which filters).
 */
import ExcelJS from 'exceljs';
import { Actor } from './auth';
import { ApiError, audit, bad, forbidden, getSetting, pool, q } from './db';
import { financials } from './financials';
import { fromFils, toFils } from '../lib/finance';
import { jobScope } from './scope';

type ColType = 'text' | 'date' | 'datetime' | 'money' | 'int' | 'pct';
type Need = 'cost' | 'revenue' | 'profit';
interface Col { key: string; label: string; type: ColType; needs?: Need; width?: number; sort?: string }
interface ReportDef { key: string; title: string; description: string; costDescription?: string; kind: 'jobs' | 'group'; cols: Col[]; group?: 'by_driver' | 'by_vehicle' | 'by_customer' | 'by_department'; podPending?: boolean; needsAny?: Need[] }

const JOB_BASE: Col[] = [
  { key: 'job_number', label: 'Job number', type: 'text', width: 13, sort: 't.job_number' },
  { key: 'required_date', label: 'Date', type: 'date', width: 12, sort: 't.required_date' },
];
export const REPORTS: Record<string, ReportDef> = {
  operational: {
    key: 'operational', title: 'Operational report', kind: 'jobs',
    description: 'Every job with route, vehicle, driver, status and POD.',
    cols: [...JOB_BASE,
      { key: 'department_name', label: 'Department', type: 'text', width: 16, sort: 'dep.name' },
      { key: 'slot', label: 'Time slot', type: 'text', width: 12 },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 24, sort: 'c.name' },
      { key: 'boe_number', label: 'BOE', type: 'text', width: 14, sort: 't.boe_number' },
      { key: 'pickup_name', label: 'Pickup', type: 'text', width: 22 },
      { key: 'delivery_name', label: 'Delivery', type: 'text', width: 22 },
      { key: 'vehicle_type', label: 'Vehicle type', type: 'text', width: 12 },
      { key: 'vehicle_number', label: 'Vehicle', type: 'text', width: 13, sort: 've.vehicle_number' },
      { key: 'driver_name', label: 'Driver', type: 'text', width: 18, sort: 'dr.full_name' },
      { key: 'status_name', label: 'Status', type: 'text', width: 16, sort: 's.sort_order' },
      { key: 'pod_status_name', label: 'POD', type: 'text', width: 12 },
      { key: 'actual_delivery_at', label: 'Delivered at', type: 'datetime', width: 17, sort: 'a.actual_delivery_at' }],
  },
  financial: {
    key: 'financial', title: 'Financial report', kind: 'jobs', needsAny: ['cost', 'revenue'],
    description: 'Revenue, cost and profit per job. Transport users get a cost-only version.',
    costDescription: 'Transport cost per job.',
    cols: [...JOB_BASE,
      { key: 'department_name', label: 'Department', type: 'text', width: 16, sort: 'dep.name' },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 24, sort: 'c.name' },
      { key: 'status_name', label: 'Status', type: 'text', width: 16, sort: 's.sort_order' },
      { key: 'net_revenue', label: 'Revenue (ex VAT)', type: 'money', needs: 'revenue', width: 15, sort: 'net' },
      { key: 'vat', label: 'VAT', type: 'money', needs: 'revenue', width: 11 },
      { key: 'total_cost', label: 'Cost', type: 'money', needs: 'cost', width: 13, sort: 'cost.total_cost' },
      { key: 'gross_profit', label: 'Profit', type: 'money', needs: 'profit', width: 13, sort: 'profit' },
      { key: 'margin_pct', label: 'Margin %', type: 'pct', needs: 'profit', width: 10 }],
  },
  department: groupReport('department', 'Department report', 'by_department', 'Department', 'Jobs, revenue, cost and profit per department.'),
  driver: groupReport('driver', 'Driver report', 'by_driver', 'Driver', 'Jobs, revenue, cost and profit per driver.'),
  vehicle: groupReport('vehicle', 'Vehicle report', 'by_vehicle', 'Vehicle', 'Jobs, revenue, cost and profit per vehicle.'),
  customer: groupReport('customer', 'Customer report', 'by_customer', 'Customer', 'Jobs, revenue, cost and profit per customer.'),
  pod_pending: {
    key: 'pod_pending', title: 'POD pending report', kind: 'jobs', podPending: true,
    description: 'Delivered jobs still waiting for a POD (or whose POD was rejected).',
    cols: [...JOB_BASE,
      { key: 'customer_name', label: 'Customer', type: 'text', width: 24, sort: 'c.name' },
      { key: 'driver_name', label: 'Driver', type: 'text', width: 18, sort: 'dr.full_name' },
      { key: 'vehicle_number', label: 'Vehicle', type: 'text', width: 13 },
      { key: 'actual_delivery_at', label: 'Delivered at', type: 'datetime', width: 17, sort: 'a.actual_delivery_at' },
      { key: 'days_waiting', label: 'Days waiting', type: 'int', width: 12, sort: '(now() - a.actual_delivery_at)' },
      { key: 'pod_status_name', label: 'POD', type: 'text', width: 12 },
      { key: 'rejection_reason', label: 'Rejection reason', type: 'text', width: 28 }],
  },
};
function groupReport(key: string, title: string, group: 'by_driver' | 'by_vehicle' | 'by_customer' | 'by_department', label: string, description: string): ReportDef {
  return { key, title, description, kind: 'group', group, needsAny: ['cost', 'revenue'],
    costDescription: `Jobs and transport cost per ${label.toLowerCase()}.`, cols: [
    { key: 'label', label, type: 'text', width: 26 },
    { key: 'jobs', label: 'Jobs', type: 'int', width: 8 },
    { key: 'completed', label: 'Completed', type: 'int', width: 11 },
    { key: 'net_revenue', label: 'Revenue (ex VAT)', type: 'money', needs: 'revenue', width: 16 },
    { key: 'total_cost', label: 'Cost', type: 'money', needs: 'cost', width: 14 },
    { key: 'gross_profit', label: 'Profit', type: 'money', needs: 'profit', width: 14 },
    { key: 'margin_pct', label: 'Margin %', type: 'pct', needs: 'profit', width: 10 }] };
}

const can = (a: Actor, n?: Need) => !n || (n === 'cost' ? a.fin.buyingView : n === 'revenue' ? a.fin.sellingView : a.fin.profitView);
const DATE = /^\d{4}-\d{2}-\d{2}$/, UUID = /^[0-9a-f-]{36}$/i;

export function reportList(actor: Actor) {
  if (!actor.has('reports.view')) throw forbidden();
  return Object.values(REPORTS)
    .filter((r) => !r.needsAny || r.needsAny.some((n) => can(actor, n)))
    .map((r) => ({ key: r.key, title: r.title, kind: r.kind,
      // Describe only what this person will actually see
      description: r.needsAny && !actor.fin.sellingView && r.costDescription ? r.costDescription : r.description }));
}

export interface ReportResult {
  report: { key: string; title: string; kind: string };
  columns: { key: string; label: string; type: ColType; sortable: boolean }[];
  rows: Record<string, unknown>[]; totals: Record<string, unknown> | null;
  total: number; page: number; page_size: number; filters: Record<string, string>;
}

export async function runReport(actor: Actor, key: string, p: Record<string, string>, opts: { all?: boolean } = {}): Promise<ReportResult> {
  if (!actor.has('reports.view')) throw forbidden();
  const def = REPORTS[key];
  if (!def) throw new ApiError(404, 'NOT_FOUND', 'Report not found');
  if (def.needsAny && !def.needsAny.some((n) => can(actor, n))) throw forbidden();
  const cols = def.cols.filter((c) => can(actor, c.needs));
  const colsOut = cols.map((c) => ({ key: c.key, label: c.label, type: c.type, sortable: !!c.sort }));

  if (!def.podPending && (!DATE.test(p.from ?? '') || !DATE.test(p.to ?? ''))) throw bad('Choose a period');
  if (p.from && p.to && p.to < p.from) throw bad('The end date is before the start date');
  const FILTER_KEYS = ['from', 'to', 'q', 'department_id', 'customer_id', 'driver_id', 'vehicle_id', 'status'];
  const filters = Object.fromEntries(Object.entries(p).filter(([k, v]) => v && FILTER_KEYS.includes(k)));

  if (def.kind === 'group') {
    const f: any = await financials(actor, p);
    let rows: any[] = f[def.group!];
    if (p.q?.trim()) rows = rows.filter((r) => r.label.toLowerCase().includes(p.q.trim().toLowerCase()));
    if (p.sort && cols.some((c) => c.key === p.sort)) {
      const k = p.sort, dir = p.dir === 'asc' ? 1 : -1, c = cols.find((x) => x.key === k)!;
      rows = [...rows].sort((a, b) => dir * (c.type === 'text' ? String(a[k]).localeCompare(String(b[k])) : Number(a[k] ?? 0) - Number(b[k] ?? 0)));
    }
    const shaped = rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, r[c.key] ?? null])));
    return { report: { key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped,
      totals: Object.fromEntries(cols.map((c) => [c.key, c.key === 'label' ? 'Total' : (f.totals[c.key] ?? null)])),
      total: shaped.length, page: 1, page_size: shaped.length, filters };
  }

  // ---- job-level reports
  const needCost = cols.some((c) => c.needs === 'cost' || c.needs === 'profit');
  const needRev = cols.some((c) => c.needs === 'revenue' || c.needs === 'profit');
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let where = `where t.deleted_at is null`;
  if (def.podPending) where += ` and s.stage = 'delivered' and t.pod_status in ('pending','rejected')`;
  else where += key === 'financial' ? ` and t.status_code not in ('draft','cancelled')` : '';
  if (p.from) where += ` and t.required_date >= ${add(p.from)}`;
  if (p.to) where += ` and t.required_date <= ${add(p.to)}`;
  where += jobScope(actor, params);
  for (const [k, col] of Object.entries({ department_id: 't.department_id', customer_id: 't.customer_id', driver_id: 'a.driver_id', vehicle_id: 'a.vehicle_id' }))
    if (p[k]) { if (!UUID.test(p[k])) throw bad('Invalid filter'); where += ` and ${col} = ${add(p[k])}`; }
  if (p.status) where += ` and t.status_code = any(${add(p.status.split(','))})`;
  if (p.q?.trim()) where += ` and t.search_text like ${add('%' + p.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%')}`;

  const sortCol = cols.find((c) => c.key === p.sort && c.sort);
  const order = sortCol ? `${sortCol.sort} ${p.dir === 'asc' ? 'asc' : 'desc'} nulls last, t.job_number desc`
    : def.podPending ? 'a.actual_delivery_at asc nulls last' : 't.required_date desc, t.job_number desc';
  const cap = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 100, 1), 500);
  const page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);

  const rows = await q(`select t.job_number, t.required_date, t.slot_from, t.slot_to, c.name customer_name, t.boe_number,
      t.pickup_name, t.delivery_name, vt.name vehicle_type, ve.vehicle_number, dr.full_name driver_name,
      s.name status_name, ps.name pod_status_name, dep.name department_name, a.actual_delivery_at, jp.rejection_reason,
      floor(extract(epoch from (now() - a.actual_delivery_at)) / 86400)::int days_waiting
      ${needCost ? ', cost.total_cost' : ''}
      ${needRev ? ', (rev.gross - coalesce(jc.discount,0)) net, round((rev.gross - coalesce(jc.discount,0)) * coalesce(jc.vat_rate,0) / 100, 2) vat' : ''}
      ${needCost && needRev ? ', (rev.gross - coalesce(jc.discount,0) - cost.total_cost) profit' : ''}
      , count(*) over() _total
    from transport_requests t
    join customers c on c.id = t.customer_id
    join job_statuses s on s.code = t.status_code
    join pod_statuses ps on ps.code = t.pod_status
    left join departments dep on dep.id = t.department_id
    left join transport_assignments a on a.job_id = t.id and a.is_current
    left join drivers dr on dr.id = a.driver_id
    left join vehicles ve on ve.id = a.vehicle_id
    left join vehicle_types vt on vt.id = coalesce(a.vehicle_type_id, t.requested_vehicle_type_id)
    left join job_pod jp on jp.job_id = t.id
    ${needCost ? 'left join lateral (select coalesce(sum(amount),0) total_cost from job_cost_lines where job_id = t.id) cost on true' : ''}
    ${needRev ? `left join job_commercials jc on jc.job_id = t.id
      left join lateral (select coalesce(sum(amount),0) gross from job_revenue_lines where job_id = t.id) rev on true` : ''}
    ${where} order by ${order} limit ${cap} offset ${(page - 1) * cap}`, params);

  const sums: Record<string, number> = {};
  const shaped = rows.map((r) => {
    const v: Record<string, unknown> = {
      ...r, slot: r.slot_from ? `${r.slot_from.slice(0, 5)}${r.slot_to ? '–' + r.slot_to.slice(0, 5) : ''}` : null,
      net_revenue: r.net ?? null, total_cost: r.total_cost ?? null, gross_profit: r.profit ?? null,
      margin_pct: r.net != null && r.profit != null && toFils(r.net) !== 0 ? (Math.round((toFils(r.profit) * 10000) / toFils(r.net)) / 100).toFixed(2) : null,
      days_waiting: r.actual_delivery_at ? r.days_waiting : null,
    };
    const out = Object.fromEntries(cols.map((c) => [c.key, v[c.key] ?? null]));
    for (const c of cols) if (c.type === 'money' && out[c.key] != null) sums[c.key] = (sums[c.key] ?? 0) + toFils(out[c.key] as string);
    return out;
  });
  let totals: Record<string, unknown> | null = null;
  if (cols.some((c) => c.type === 'money')) {
    // Totals over ALL matching rows, not just this page
    const all = !opts.all && Number(rows[0]?._total ?? 0) > rows.length ? await runReport(actor, key, p, { all: true }) : null;
    totals = all?.totals ?? Object.fromEntries(cols.map((c, i) => [c.key, i === 0 ? 'Total' : c.type === 'money' ? fromFils(sums[c.key] ?? 0)
      : c.key === 'margin_pct' && sums.net_revenue ? (Math.round(((sums.gross_profit ?? 0) * 10000) / sums.net_revenue) / 100).toFixed(2) : null]));
  }
  return { report: { key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped, totals,
    total: Number(rows[0]?._total ?? 0), page, page_size: cap, filters };
}

// ------------------------------------------------------------ export
export async function exportReport(actor: Actor, key: string, p: Record<string, string>, format: string) {
  if (!actor.has('reports.export')) throw forbidden('You do not have permission to export reports');
  if (!['csv', 'xlsx'].includes(format)) throw bad('Choose CSV or Excel');
  const r = await runReport(actor, key, p, { all: true });
  if (r.total > 50000) throw bad('Too many rows to export (over 50,000). Narrow the dates or filters.');
  const currency = await getSetting<string>('currency', 'AED');
  const company = await getSetting<string>('company_name', 'Company');
  const tz = await getSetting<string>('timezone', 'Asia/Dubai');
  const period = r.filters.from ? `${r.filters.from} to ${r.filters.to}` : 'All dates';
  const stamp = new Date().toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  const fileBase = `${r.report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${r.filters.from ?? 'all'}${r.filters.to ? '-to-' + r.filters.to : ''}`;

  await audit(pool(), actor, { entity_type: 'report', entity_id: key, action: `Report exported (${format.toUpperCase()})`,
    new_value: `${r.report.title}, ${period}, ${r.total} rows${Object.keys(r.filters).length > 2 ? ', filtered' : ''}`, sensitivity: 'admin' });

  const cell = (c: ReportResult['columns'][number], v: unknown) => {
    if (v == null) return '';
    if (c.type === 'datetime') return new Date(String(v)).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
    return v;
  };
  if (format === 'csv') {
    // Text that starts with = + - @ could run as a formula in Excel; neutralise it (numbers are left alone).
    const esc = (v: unknown, text = true) => {
      let s = String(v ?? '');
      if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const isText = (c: ReportResult['columns'][number]) => !['money', 'pct', 'int'].includes(c.type);
    const lines = [r.columns.map((c) => esc(c.label + (c.type === 'money' ? ` (${currency})` : ''))).join(','),
      ...r.rows.map((row) => r.columns.map((c) => esc(cell(c, row[c.key]), isText(c))).join(','))];
    if (r.totals) lines.push(r.columns.map((c) => esc(r.totals![c.key] ?? '', isText(c))).join(','));
    return { body: Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8'), type: 'text/csv; charset=utf-8', name: `${fileBase}.csv` };
  }
  // Excel: title block, real numbers with formats, frozen header, auto filter
  const wb = new ExcelJS.Workbook();
  wb.creator = company; wb.created = new Date();
  const ws = wb.addWorksheet(r.report.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 5 }] });
  ws.addRow([company]).font = { bold: true, size: 14 };
  ws.addRow([r.report.title]).font = { bold: true, size: 12 };
  ws.addRow([`Period: ${period}`, '', '', `Generated: ${stamp} by ${actor.full_name}`]).font = { color: { argb: 'FF5E6B78' } };
  ws.addRow([]);
  const head = ws.addRow(r.columns.map((c) => c.label + (c.type === 'money' ? ` (${currency})` : '')));
  head.font = { bold: true }; head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E6E1' } }; c.border = { bottom: { style: 'thin' } }; });
  const defCols = REPORTS[key].cols;
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = defCols.find((d) => d.key === c.key)?.width ?? 14;
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'pct') col.numFmt = '0.00"%"';
    if (c.type === 'date') col.numFmt = 'dd-mmm-yyyy';
  });
  const val = (c: ReportResult['columns'][number], v: unknown) => {
    if (v == null) return null;
    if (c.type === 'money' || c.type === 'pct' || c.type === 'int') return Number(v);
    if (c.type === 'date') return new Date(String(v) + 'T00:00:00Z');
    return cell(c, v);
  };
  for (const row of r.rows) ws.addRow(r.columns.map((c) => val(c, row[c.key])));
  if (r.totals) { const t = ws.addRow(r.columns.map((c) => val(c, r.totals![c.key]) ?? (c === r.columns[0] ? 'Total' : null))); t.font = { bold: true };
    t.eachCell((c) => { c.border = { top: { style: 'thin' } }; }); }
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: r.columns.length } };
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { body: buf, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `${fileBase}.xlsx` };
}
