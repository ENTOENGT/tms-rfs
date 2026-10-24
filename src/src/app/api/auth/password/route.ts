import { NextResponse } from 'next/server';
import { requireActor, signSession, SESSION_COOKIE, cookieOptions } from '@/server/auth';
import { changeOwnPassword } from '@/server/admin';
import { route, body } from '@/server/http';
export const POST = route(async (req) => {
  const a = await requireActor(req, { allowPasswordChange: true });
  const v = await changeOwnPassword(a, await body(req));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await signSession(a.id, v), cookieOptions); // other sessions are signed out
  return res;
});
