import { NextResponse } from 'next/server';
import { requireActor } from '@/server/auth';
import { downloadUrl } from '@/server/documents';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
// Permission is checked on every click; the storage link it redirects to expires in 2 minutes.
export const GET = route(async (req, { params }) => {
  const url = await downloadUrl(await requireActor(req), params.id, new URL(req.url).searchParams.get('view') === '1');
  return NextResponse.redirect(new URL(url, req.url), { status: 302, headers: { 'Cache-Control': 'no-store' } });
});
