// Local file storage for development and automated tests ONLY.
// Disabled unless STORAGE_DRIVER=local and Supabase storage is not configured.
import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { localPath, localWrite, verifyLocalSig } from '@/server/storage';
export const dynamic = 'force-dynamic';
const enabled = () => process.env.STORAGE_DRIVER === 'local' && !process.env.SUPABASE_URL;
const check = (req: Request, action: 'put' | 'get') => {
  const u = new URL(req.url);
  const key = u.searchParams.get('key') ?? '';
  const ok = enabled() && verifyLocalSig(key, action, Number(u.searchParams.get('exp')), u.searchParams.get('sig') ?? '');
  return { ok, key, name: u.searchParams.get('name') ?? 'file', inline: u.searchParams.get('inline') === '1' };
};
export async function PUT(req: Request) {
  const { ok, key } = check(req, 'put');
  if (!ok) return new NextResponse('Forbidden', { status: 403 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) return new NextResponse('Too large', { status: 413 });
  await localWrite(key, buf, req.headers.get('content-type') ?? 'application/octet-stream');
  return NextResponse.json({ Key: key });
}
export async function GET(req: Request) {
  const { ok, key, name, inline } = check(req, 'get');
  if (!ok) return new NextResponse('Forbidden', { status: 403 });
  try {
    const [buf, type] = await Promise.all([readFile(localPath(key)), readFile(localPath(key) + '.type', 'utf8')]);
    return new NextResponse(buf, { headers: { 'content-type': type, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"` } });
  } catch { return new NextResponse('Not found', { status: 404 }); }
}
