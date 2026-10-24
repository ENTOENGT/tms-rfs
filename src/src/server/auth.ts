import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { ApiError, audit, forbidden, one, q } from './db';
import { financialAccess, FinancialAccess, Perm, Side } from '../lib/permissions';

export const SESSION_COOKIE = 'tms_session';
const SESSION_HOURS = 12;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ characters)');
  return new TextEncoder().encode(s);
}
export async function signSession(userId: string, version: number) {
  return new SignJWT({ v: version }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
    .setIssuedAt().setExpirationTime(`${SESSION_HOURS}h`).sign(secret());
}
export async function verifySession(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret());
    return { userId: payload.sub as string, version: payload.v as number };
  } catch { return null; }
}
export const cookieOptions = {
  httpOnly: true, sameSite: 'lax' as const, path: '/',
  secure: process.env.NODE_ENV === 'production', maxAge: SESSION_HOURS * 3600,
};

export interface Actor {
  id: string; full_name: string; email: string;
  role_code: string; role_name: string; role_is_manager: boolean;
  department_id: string | null; department_code: string | null; department_name: string | null; department_side: Side | null;
  must_change_password: boolean; isSuperAdmin: boolean;
  perms: Set<Perm>; fin: FinancialAccess;
  has(p: Perm): boolean;
}

export async function loadActor(userId: string, version?: number): Promise<Actor | null> {
  const u = await one(
    `select u.id, u.full_name, u.email, u.token_version, u.must_change_password, u.is_active,
            r.code role_code, r.name role_name, r.is_manager role_is_manager,
            d.id department_id, d.code department_code, d.name department_name, d.side department_side
       from users u join roles r on r.id = u.role_id left join departments d on d.id = u.department_id
      where u.id = $1 and u.deleted_at is null`, [userId]);
  if (!u || !u.is_active) return null;
  if (version !== undefined && u.token_version !== version) return null;
  // One rule set, kept in the database function user_has_perm (migration 005):
  // role + per-user exceptions, Super Admin = everything, and selling price can never
  // reach a Transport or Messenger department.
  const rows = await q<{ code: Perm }>('select code from permissions where user_has_perm($1, code)', [u.id]);
  const perms = new Set(rows.map((r) => r.code));
  const has = (p: Perm) => perms.has(p);
  return {
    id: u.id, full_name: u.full_name, email: u.email, role_code: u.role_code, role_name: u.role_name,
    role_is_manager: u.role_is_manager, department_id: u.department_id, department_code: u.department_code,
    department_name: u.department_name, department_side: u.department_side,
    must_change_password: u.must_change_password, isSuperAdmin: u.role_code === 'super_admin', perms, has, fin: financialAccess(has),
  };
}

/** Resolve the caller from the session cookie. Every API route starts here. */
export async function requireActor(req: Request, opts: { allowPasswordChange?: boolean } = {}): Promise<Actor> {
  const cookie = req.headers.get('cookie') ?? '';
  const token = cookie.split(/;\s*/).find((c) => c.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
  const sess = token ? await verifySession(decodeURIComponent(token)) : null;
  const actor = sess ? await loadActor(sess.userId, sess.version) : null;
  if (!actor) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in');
  if (actor.must_change_password && !opts.allowPasswordChange)
    throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Set a new password to continue');
  return actor;
}

export function requirePerm(actor: Actor, ...anyOf: Perm[]) {
  if (!anyOf.some((p) => actor.has(p))) throw forbidden();
}

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw))
    throw new ApiError(400, 'WEAK_PASSWORD', 'Password needs at least 10 characters, including a letter and a number');
  return pw;
}
export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);

const MAX_FAILS = 5, LOCK_MINUTES = 15;
export async function login(email: string, password: string) {
  const fail = new ApiError(401, 'INVALID_LOGIN', 'Email or password is incorrect');
  if (!email || !password) throw fail;
  const u = await one(
    `select u.id, u.full_name, u.password_hash, u.is_active, u.token_version, u.failed_logins, u.locked_until, d.code department_code
       from users u left join departments d on d.id = u.department_id
      where lower(u.email) = lower($1) and u.deleted_at is null`, [email.trim()]);
  if (!u) { await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv'); throw fail; }
  if (u.locked_until && new Date(u.locked_until) > new Date())
    throw new ApiError(423, 'LOCKED', `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`);
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) {
    await q(`update users set failed_logins = failed_logins + 1,
               locked_until = case when failed_logins + 1 >= $2 then now() + ($3 || ' minutes')::interval end
             where id = $1`, [u.id, MAX_FAILS, String(LOCK_MINUTES)]);
    throw fail;
  }
  if (!u.is_active) throw new ApiError(403, 'DISABLED', 'This account is disabled. Contact your administrator.');
  await q('update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1', [u.id]);
  const { pool } = await import('./db');
  await audit(pool(), { id: u.id, full_name: u.full_name, department_code: u.department_code },
    { entity_type: 'user', entity_id: u.id, action: 'Signed in', sensitivity: 'admin' });
  return signSession(u.id, u.token_version);
}
