import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/server/auth';
import { appLinkInfo, useAppLink } from '@/server/applink';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
// Opened from the link on the phone — no sign-in yet. The link itself is the proof.
export const GET = route(async (_req, { params }) => appLinkInfo(params.token));
export const POST = route(async (req, { params }) => {
  const s = await useAppLink(params.token, (await body(req)).password);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, s.token, s.options);
  return res;
});
