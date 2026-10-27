import { NextResponse } from 'next/server';
import { requireActor } from '@/server/auth';
import { proFileUrl } from '@/server/pro';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';   // storage links must always be fresh
// Permission is checked on every click; ?view=1 opens it in the browser, otherwise it downloads.
export const GET = route(async (req, { params }) => {
  const url = await proFileUrl(await requireActor(req), params.id, new URL(req.url).searchParams.get('view') === '1');
  return NextResponse.redirect(new URL(url, req.url), { status: 302, headers: { 'Cache-Control': 'no-store' } });
});
