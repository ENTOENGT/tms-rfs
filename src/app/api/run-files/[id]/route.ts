import { NextResponse } from 'next/server';
import { requireActor } from '@/server/auth';
import { runFileUrl } from '@/server/runs';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => {
  const url = await runFileUrl(await requireActor(req), params.id, new URL(req.url).searchParams.get('view') === '1');
  return NextResponse.redirect(new URL(url, req.url), { status: 302, headers: { 'Cache-Control': 'no-store' } });
});
