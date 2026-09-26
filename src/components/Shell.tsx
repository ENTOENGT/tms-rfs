'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { api, fmtDateTime } from './api';

export interface Me {
  id: string; full_name: string; email: string; role: string; role_code: string; department: string | null;
  permissions: string[];
  financial_access: { buyingView: boolean; buyingEdit: boolean; sellingView: boolean; sellingEdit: boolean; profitView: boolean };
}
const MeCtx = createContext<{ me: Me; can: (p: string) => boolean; lk: any; reloadLookups: () => void } | null>(null);
export const useMe = () => useContext(MeCtx)!;

const NAV: { href: string; label: string; perm?: string; phase?: number }[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/requests', label: 'Transport requests', perm: 'jobs.view' },
  { href: '/jobs', label: 'Jobs', perm: 'jobs.view' },
  { href: '/drivers', label: 'Drivers', perm: 'jobs.view' },
  { href: '/vehicles', label: 'Vehicles', perm: 'jobs.view' },
  { href: '/customers', label: 'Customers', perm: 'jobs.view' },
  { href: '/locations', label: 'Locations', perm: 'jobs.view' },
  { href: '/financials', label: 'Financials', phase: 5 },
  { href: '/reports', label: 'Reports', phase: 6 },
  { href: '/documents', label: 'Documents', phase: 4 },
];
const ADMIN: { href: string; label: string; perm: string; phase?: number }[] = [
  { href: '/users', label: 'Users', perm: 'users.manage' },
  { href: '/roles', label: 'Roles & permissions', perm: 'roles.manage' },
  { href: '/settings', label: 'Settings', perm: 'settings.manage' },
];

function Bell() {
  const [n, setN] = useState<{ unread: number; rows: any[] }>({ unread: 0, rows: [] });
  const [open, setOpen] = useState(false);
  const load = () => api('/api/notifications').then(setN).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  return (
    <div className="bell" style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => { setOpen(!open); if (!open && n.unread) api('/api/notifications', { body: {} }).then(load); }}>
        Notifications {n.unread > 0 && <span className="dot">{n.unread}</span>}
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          {n.rows.length === 0 && <div style={{ padding: 12 }} className="muted">You're all caught up.</div>}
          {n.rows.map((r) => (
            <Link key={r.id} href={r.job_id ? `/jobs/${r.job_id}` : '#'} className={r.read_at ? '' : 'unread'} onClick={() => setOpen(false)}>
              {r.title}<div className="muted small">{fmtDateTime(r.created_at)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [lk, setLk] = useState<any>(null);
  const [q, setQ] = useState('');
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    api<Me & { must_change_password: boolean }>('/api/auth/me').then((m) => {
      if (m.must_change_password) { location.href = '/change-password'; return; }
      setMe(m);
      api('/api/lookups').then(setLk);
    });
  }, []);
  if (!me || !lk) return <div className="page muted">Loading…</div>;
  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => { await api('/api/auth/logout', { body: {} }); location.href = '/login'; };
  const link = (i: { href: string; label: string; phase?: number }) => (
    <Link key={i.href} href={i.href} className={path.startsWith(i.href) ? 'on' : ''}>
      {i.label}{i.phase && <span className="soon">Phase {i.phase}</span>}
    </Link>
  );
  const adminLinks = ADMIN.filter((i) => can(i.perm));
  return (
    <MeCtx.Provider value={{ me, can, lk, reloadLookups: () => api('/api/lookups').then(setLk) }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <img src="/brand/logo-on-dark.png" alt="Reliance Freight Systems LLC" width={184} height={44} />
            <small>Transport Management · {me.department ?? me.role}</small>
          </div>
          <nav className="nav">
            {NAV.filter((i) => !i.perm || can(i.perm)).map(link)}
            {adminLinks.length > 0 && <div className="group">Administration</div>}
            {adminLinks.map(link)}
          </nav>
        </aside>
        <div className="main">
          <header className="top">
            <form className="search" onSubmit={(e) => { e.preventDefault(); router.push(`/jobs?q=${encodeURIComponent(q)}`); }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search job no., BOE, driver, vehicle, customer, email subject…" aria-label="Search jobs" />
            </form>
            <Bell />
            <div className="who">{me.full_name}<small>{me.role}</small></div>
            <button className="btn small" onClick={logout}>Sign out</button>
          </header>
          {children}
        </div>
      </div>
    </MeCtx.Provider>
  );
}
