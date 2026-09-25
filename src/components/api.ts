'use client';
export class ApiErr extends Error { constructor(public status: number, public code: string, msg: string, public details?: any) { super(msg); } }

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login'))
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
    if (e.code === 'PASSWORD_CHANGE_REQUIRED' && typeof window !== 'undefined') location.href = '/change-password';
    throw new ApiErr(res.status, e.code ?? 'ERROR', e.message ?? 'Request failed', e.details);
  }
  return data as T;
}

export const fmtMoney = (v: string | null | undefined, cur = 'AED') =>
  v == null ? '—' : `${cur} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtDate = (v?: string | null) =>
  v ? new Date(v.length === 10 ? v + 'T00:00:00' : v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const fmtDateTime = (v?: string | null) =>
  v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
export const slot = (a?: string | null, b?: string | null) => (a ? `${a.slice(0, 5)}${b ? '–' + b.slice(0, 5) : ''}` : '—');
