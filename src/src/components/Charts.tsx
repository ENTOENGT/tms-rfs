'use client';
// Small dependency-free charts. Each has a text alternative (title/aria + values) for accessibility.

export const COLORS = { revenue: '#E8A808', cost: '#8E949B', profit: '#2F7D55', loss: '#9B2C2C' };
const short = (n: number) => {
  const a = Math.abs(n);
  return (n < 0 ? '-' : '') + (a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `${Math.round(a)}`);
};
const monthLabel = (ym: string) => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

export interface Series { key: string; label: string; color: string }

/** Grouped vertical bars per month. */
export function MonthChart({ rows, series, currency }: { rows: any[]; series: Series[]; currency: string }) {
  const W = 760, H = 260, L = 48, B = 28, T = 12, R = 8;
  const vals = rows.flatMap((r) => series.map((s) => Number(r[s.key] ?? 0)));
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  // Round the scale up to a "nice" number (1, 2, 2.5, 5 × 10ⁿ) so gridlines read cleanly.
  const nice = (v: number) => { const p = Math.pow(10, Math.floor(Math.log10(v))); return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p; };
  const step = nice((max - min) / 5);
  const niceMax = Math.ceil(max / step) * step, niceMin = Math.floor(min / step) * step;
  const span = niceMax - niceMin || 1;
  const y = (v: number) => T + (H - T - B) * (1 - (v - niceMin) / span);
  const gw = (W - L - R) / Math.max(rows.length, 1);
  const bw = Math.min(22, (gw * 0.8) / series.length);
  const ticks = Array.from({ length: Math.round(span / step) + 1 }, (_, i) => niceMin + step * i);
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, marginBottom: 6 }}>
        {series.map((s) => <span key={s.key}><span style={{ display: 'inline-block', width: 10, height: 10, background: s.color, borderRadius: 2, marginRight: 5 }} />{s.label}</span>)}
        <span className="muted" style={{ marginLeft: 'auto' }}>{currency}, before VAT</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${series.map((s) => s.label).join(', ')} by month`}>
        {ticks.map((t, i) => <g key={i}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#9aa0a6' : '#e3e1dc'} />
          <text x={L - 6} y={y(t) + 4} fontSize="11" textAnchor="end" fill="#6a7784">{short(t)}</text>
        </g>)}
        {rows.map((r, i) => {
          const x0 = L + gw * i + (gw - bw * series.length) / 2;
          return <g key={r.key}>
            {series.map((s, k) => {
              const v = Number(r[s.key] ?? 0);
              const top = Math.min(y(v), y(0)), h = Math.max(1, Math.abs(y(v) - y(0)));
              return <rect key={s.key} x={x0 + k * bw} y={top} width={bw - 2} height={h} rx="2" fill={s.key === 'gross_profit' && v < 0 ? COLORS.loss : s.color}>
                <title>{`${monthLabel(r.key)} — ${s.label}: ${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`}</title></rect>;
            })}
            {(rows.length <= 14 || i % 2 === 0) && <text x={L + gw * i + gw / 2} y={H - 8} fontSize="11" textAnchor="middle" fill="#6a7784">{monthLabel(r.key)}</text>}
          </g>;
        })}
      </svg>
    </div>
  );
}

/** Ranked horizontal bars, e.g. revenue by customer. Shows top N and totals the rest as "Others". */
export function BarList({ rows, metric, color, format, top = 8, empty = 'No data for this period' }: {
  rows: any[]; metric: string; color: string | ((r: any) => string); format: (v: number) => string; top?: number; empty?: string;
}) {
  const sorted = [...rows].filter((r) => Number(r[metric] ?? 0) !== 0).sort((a, b) => Number(b[metric]) - Number(a[metric]));
  const shown = sorted.slice(0, top);
  const rest = sorted.slice(top).reduce((s, r) => s + Number(r[metric]), 0);
  const items = rest ? [...shown, { key: '_others', label: `Others (${sorted.length - top})`, [metric]: rest }] : shown;
  const max = Math.max(...items.map((r) => Math.abs(Number(r[metric]))), 1);
  if (!items.length) return <p className="muted small" style={{ margin: 0 }}>{empty}</p>;
  return (
    <div role="list">
      {items.map((r) => {
        const v = Number(r[metric]);
        return (
          <div role="listitem" key={r.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 34%) 1fr auto', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 13 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</span>
            <span style={{ background: '#efede8', borderRadius: 3, height: 14, position: 'relative' }}>
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(2, (Math.abs(v) / max) * 100)}%`, borderRadius: 3,
                background: v < 0 ? COLORS.loss : typeof color === 'function' ? color(r) : color }} />
            </span>
            <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', minWidth: 70 }}>{format(v)}</span>
          </div>
        );
      })}
    </div>
  );
}
