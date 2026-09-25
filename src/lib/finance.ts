// All arithmetic in integer fils (1 AED = 100 fils) — no floating-point drift.
// Every amount here EXCLUDES VAT. VAT is computed separately, on revenue only.

export const toFils = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${s}`);
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const fils = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return s.startsWith('-') ? -fils : fils;
};
export const fromFils = (f: number): string => {
  const sign = f < 0 ? '-' : '';
  const a = Math.abs(f);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};

export interface CostSummary { total_cost: string }
export interface CommercialSummary {
  gross_revenue: string;   // sum of selling lines
  discount: string;
  net_revenue: string;     // before VAT — the basis for profit
  vat_rate: string;
  vat_amount: string;
  customer_total: string;  // net + VAT
}
export interface ProfitSummary { gross_profit: string; margin_pct: string | null }

export function summariseCost(costLines: { amount: string | number }[]): CostSummary {
  return { total_cost: fromFils(costLines.reduce((s, l) => s + toFils(l.amount), 0)) };
}

export function summariseCommercial(
  revenueLines: { amount: string | number }[], discount: string | number, vatRate: string | number,
): CommercialSummary {
  const gross = revenueLines.reduce((s, l) => s + toFils(l.amount), 0);
  const disc = toFils(discount);
  if (disc > gross) throw new Error('Discount cannot exceed the selling price');
  const net = gross - disc;
  // VAT rate in basis points keeps it integer: 5% -> 500 bp. Round half-up.
  const bp = Math.round(Number(vatRate) * 100);
  const vat = Math.floor((net * bp + 5000) / 10000);
  return {
    gross_revenue: fromFils(gross), discount: fromFils(disc), net_revenue: fromFils(net),
    vat_rate: String(Number(vatRate)), vat_amount: fromFils(vat), customer_total: fromFils(net + vat),
  };
}

export function summariseProfit(netRevenue: string, totalCost: string): ProfitSummary {
  const net = toFils(netRevenue), cost = toFils(totalCost);
  const profit = net - cost;
  const margin = net === 0 ? null : (Math.round((profit * 10000) / net) / 100).toFixed(2);
  return { gross_profit: fromFils(profit), margin_pct: margin };
}
