import { NextResponse } from 'next/server';
import { requireActor, issueSession, SESSION_COOKIE } from '@/server/auth';
import { changeOwnPassword } from '@/server/admin';
import { route, body } from '@/server/http';
export const POST = route(async (req) => {
  const a = await requireActor(req, { allowPasswordChange: true });
  await changeOwnPassword(a, await body(req));
  const s = await issueSession(a.id);                 // other sessions are signed out (token version moved on)
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, s.token, s.options);
  return res;
});
