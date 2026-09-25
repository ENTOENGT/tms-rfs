import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/server/auth';
export const POST = async () => {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
};
