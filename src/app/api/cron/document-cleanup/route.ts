import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { runDocumentCleanup } from '@/server/documents';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
/**
 * Called every hour by the Netlify scheduled function (netlify/functions/document-cleanup.mjs).
 * Protected by a key derived from SESSION_SECRET, so no new setting is needed and nobody else can trigger it.
 */
export async function POST(req: Request) {
  const want = createHmac('sha256', process.env.SESSION_SECRET || '').update('document-cleanup').digest('hex');
  const got = req.headers.get('x-cron-key') ?? '';
  if (!process.env.SESSION_SECRET || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json(await runDocumentCleanup('schedule'));
}
