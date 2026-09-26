// Shared period presets for the dashboard and financials (company timezone).
export const PERIODS: [string, string][] = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['this_year', 'This year'], ['last_year', 'Last year'], ['custom', 'Custom range'],
];
export function period(key: string, tz: string): [string, string] {
  const iso = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const d = (y: number, m: number, day: number) => new Date(y, m, day);
  const y = now.getFullYear(), m = now.getMonth(), day = now.getDate();
  const dow = (now.getDay() + 6) % 7; // Monday = 0
  const loc = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  switch (key) {
    case 'today': return [loc(now), loc(now)];
    case 'yesterday': { const t = d(y, m, day - 1); return [loc(t), loc(t)]; }
    case 'this_week': return [loc(d(y, m, day - dow)), loc(d(y, m, day - dow + 6))];
    case 'last_week': return [loc(d(y, m, day - dow - 7)), loc(d(y, m, day - dow - 1))];
    case 'last_month': return [loc(d(y, m - 1, 1)), loc(d(y, m, 0))];
    case 'this_year': return [loc(d(y, 0, 1)), loc(d(y, 11, 31))];
    case 'last_year': return [loc(d(y - 1, 0, 1)), loc(d(y - 1, 11, 31))];
    default: void iso; return [loc(d(y, m, 1)), loc(d(y, m + 1, 0))];
  }
}

