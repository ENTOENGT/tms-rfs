/**
 * Phone-app links.
 *
 * A manager presses "Send app link" for a driver or a messenger. We make a one-time link
 * (valid 7 days) that they open on their phone: it shows their name, they choose a password,
 * and they are signed in. The same link also explains how to add the app to the home screen.
 * Pressing the button again makes a new link and switches off any older unused one — this is
 * also how a forgotten password is fixed.
 *
 * Only a hash of the link is stored, so the database never holds a usable link.
 *
 * Who may send:
 *   drivers    → Transport Manager (manages users of the transport department) and Super Admin
 *   messengers → Messenger Manager (manages users of the messengers department) and Super Admin
 * i.e. exactly the people who can manage that person's user account.
 */
import { createHash, randomBytes } from 'crypto';
import { Actor, hashPassword, issueSession, phoneKey, validatePassword } from './auth';
import { ApiError, audit, bad, Db, forbidden, notFound, one, tx } from './db';
import { editableUser, userScope } from './team';

const LINK_DAYS = 7;
const UUID = /^[0-9a-f-]{36}$/i;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const gone = () => new ApiError(410, 'LINK_EXPIRED', 'This link has expired or was already used. Ask your manager to send a new one.');

async function makeLink(c: Db, actor: Actor, user: { id: string; full_name: string }) {
  await c.query('update app_links set expires_at = now() where user_id = $1 and used_at is null and expires_at > now()', [user.id]);
  const token = randomBytes(24).toString('base64url');
  await c.query(`insert into app_links (user_id, token_hash, created_by, expires_at)
    values ($1, $2, $3, now() + ($4 || ' days')::interval)`, [user.id, hash(token), actor.id, String(LINK_DAYS)]);
  await audit(c, actor, { entity_type: 'user', entity_id: user.id, action: 'App link sent', new_value: user.full_name, sensitivity: 'admin' });
  return token;
}

/** No two active accounts may share a mobile number, because the number is used to sign in. */
async function checkMobileFree(c: Db, mobile: string, exceptUser: string | null) {
  const other = await one(`select full_name from users where deleted_at is null and ($2::uuid is null or id <> $2)
      and right(regexp_replace(coalesce(mobile, ''), '\\D', '', 'g'), 9) = $1`, [phoneKey(mobile), exceptUser], c);
  if (other) throw bad(`The mobile number ${mobile} is already used by ${other.full_name}. Each person needs their own number.`);
}

const result = (token: string, u: { full_name: string; mobile: string | null; email: string }) => ({
  path: `/join/${token}`, full_name: u.full_name, mobile: u.mobile, sign_in_with: u.mobile || u.email, valid_days: LINK_DAYS,
});

/** "Send app link" on the Users page — messengers (and any user the caller manages). */
export async function appLinkForUser(actor: Actor, userId: string) {
  const scope = userScope(actor);
  const u = await editableUser(actor, scope, userId);
  if (!u.is_active) throw bad('This account is switched off. Switch it on first.');
  return tx(async (c) => {
    if (u.mobile) await checkMobileFree(c, u.mobile, u.id);
    return result(await makeLink(c, actor, u), u);
  });
}

/** "Send app link" on a driver — creates the driver's login the first time. */
export async function appLinkForDriver(actor: Actor, driverId: string) {
  const scope = userScope(actor);                       // must be able to manage users at all
  if (!scope.all && scope.side !== 'transport') throw forbidden('Only the Transport Manager or Super Admin can send the app to drivers');
  if (!UUID.test(driverId)) throw notFound('Driver');
  return tx(async (c) => {
    const d = await one('select * from drivers where id = $1 and deleted_at is null for update', [driverId], c);
    if (!d) throw notFound('Driver');
    if (d.status === 'inactive') throw bad(`${d.full_name} is marked inactive.`);
    if (phoneKey(d.mobile).length < 9) throw bad(`Add ${d.full_name}'s mobile number first. They sign in with it, and the link is sent to it.`);

    let user: any = d.user_id ? await one('select * from users where id = $1 and deleted_at is null', [d.user_id], c) : null;
    if (user) {
      if (!scope.all) await editableUser(actor, scope, user.id, c);          // still in this manager's department
      if (!user.is_active) throw bad(`${d.full_name}'s app login is switched off. Switch it on in Users first.`);
      await checkMobileFree(c, d.mobile, user.id);
      // keep the login in step with the driver record
      user = await one('update users set full_name = $2, mobile = $3, updated_at = now() where id = $1 returning *', [user.id, d.full_name, d.mobile], c);
    } else {
      await checkMobileFree(c, d.mobile, null);
      const role = await one(`select id from roles where code = 'driver'`, [], c);
      if (!role) throw new ApiError(500, 'SETUP', 'The Driver role is missing. Run database update 007.');
      const dept = scope.all ? await one(`select id from departments where code = 'transport'`, [], c) : { id: scope.deptId };
      const email = d.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) &&
        !(await one('select 1 from users where lower(email) = lower($1) and deleted_at is null', [d.email], c))
        ? String(d.email).toLowerCase() : `driver.${d.id.slice(0, 8)}@drivers.app`;    // placeholder: drivers sign in with their mobile
      user = await one(`insert into users (full_name, email, mobile, password_hash, role_id, department_id, must_change_password)
          values ($1,$2,$3,$4,$5,$6,true) returning *`,
        [d.full_name, email, d.mobile, await hashPassword(randomBytes(24).toString('base64url')), role.id, dept?.id ?? null], c);
      await c.query('update drivers set user_id = $2, updated_at = now() where id = $1', [d.id, user.id]);
      await audit(c, actor, { entity_type: 'user', entity_id: user.id, action: 'User created', new_value: `${d.full_name}, Driver (phone app)`, sensitivity: 'admin' });
    }
    return result(await makeLink(c, actor, user), user);
  });
}

async function liveLink(c: Db, token: string, lock = false) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw gone();
  const l = await one(`select l.id, l.user_id, u.full_name, u.email, u.mobile, u.is_active, r.app_only
      from app_links l join users u on u.id = l.user_id and u.deleted_at is null join roles r on r.id = u.role_id
     where l.token_hash = $1 and l.used_at is null and l.expires_at > now()${lock ? ' for update of l' : ''}`, [hash(token)], c);
  if (!l || !l.is_active) throw gone();
  return l;
}

/** What the link page shows before the password is chosen. No sign-in needed. */
export async function appLinkInfo(token: string) {
  const { pool } = await import('./db');
  const l = await liveLink(pool(), token);
  return { full_name: l.full_name, sign_in_with: l.mobile || l.email, app_only: l.app_only };
}

/** Choose a password from the link → signed in on this phone. The link can't be used again. */
export async function useAppLink(token: string, password: unknown) {
  const pw = validatePassword(password);
  const userId = await tx(async (c) => {
    const l = await liveLink(c, token, true);
    await c.query(`update users set password_hash = $2, must_change_password = false, token_version = token_version + 1,
        failed_logins = 0, locked_until = null, last_login_at = now(), updated_at = now() where id = $1`, [l.user_id, await hashPassword(pw)]);
    await c.query('update app_links set used_at = now() where id = $1', [l.id]);
    const who = await one('select u.id, u.full_name, d.code department_code from users u left join departments d on d.id = u.department_id where u.id = $1', [l.user_id], c);
    await audit(c, who, { entity_type: 'user', entity_id: l.user_id, action: 'Password set from app link', sensitivity: 'admin' });
    return l.user_id as string;
  });
  return issueSession(userId);
}
