// Shared by server and UI. The UI uses these only to hide buttons —
// the server is the authority and never sends what a user may not see.
export type Perm =
  | 'jobs.view' | 'jobs.view_all' | 'jobs.view_department' | 'jobs.create' | 'jobs.edit' | 'jobs.edit_assigned'
  | 'jobs.edit_completed' | 'jobs.delete' | 'jobs.cancel' | 'jobs.backdate'
  | 'jobs.assign_driver' | 'jobs.assign_vehicle' | 'jobs.override_conflicts' | 'jobs.update_status'
  | 'pod.upload' | 'pod.verify' | 'documents.upload' | 'documents.view_commercial'
  | 'finance.buying.view' | 'finance.buying.edit' | 'finance.selling.view'
  | 'finance.selling.edit' | 'finance.profit.view'
  | 'reports.view' | 'reports.export'
  | 'drivers.manage' | 'vehicles.manage' | 'customers.manage' | 'locations.manage'
  | 'users.manage' | 'roles.manage' | 'settings.manage' | 'audit.view'
  | 'users.manage_department' | 'roles.manage_department'
  | 'runs.view_all' | 'runs.view_department' | 'runs.create' | 'runs.cancel' | 'runs.assign' | 'runs.update_status';

export type Side = 'admin' | 'operations' | 'transport' | 'messenger' | 'finance';

export interface FinancialAccess {
  buyingView: boolean; buyingEdit: boolean;
  sellingView: boolean; sellingEdit: boolean;
  profitView: boolean;
}

/** Derived rules close the inference gaps a flat permission list would leave open. */
export function financialAccess(has: (p: Perm) => boolean): FinancialAccess {
  const sellingView = has('finance.selling.view');
  const buyingView = has('finance.buying.view');
  return {
    buyingView,
    buyingEdit: buyingView && has('finance.buying.edit'),
    sellingView,
    sellingEdit: sellingView && has('finance.selling.edit'),
    // Profit = revenue − cost, so profit plus either side reveals the other.
    // Only someone who can already see both sides gets to see profit.
    profitView: sellingView && buyingView && has('finance.profit.view'),
  };
}
