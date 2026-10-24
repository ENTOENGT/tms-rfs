import { NextResponse } from 'next/server';
import { login, SESSION_COOKIE, cookieOptions } from '@/server/auth';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const POST = route(async (req) => {
  const b = await body(req);
  const token = await login(String(b.email ?? ''), String(b.password ?? ''));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, cookieOptions);
  return res;
});
