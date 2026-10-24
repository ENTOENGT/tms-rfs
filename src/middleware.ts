import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

// Page guard only. API routes authorise themselves on every request.
export async function middleware(req: NextRequest) {
  const token = req.cookies.get('tms_session')?.value;
  let ok = false;
  if (token && process.env.SESSION_SECRET) {
    try { await jwtVerify(token, new TextEncoder().encode(process.env.SESSION_SECRET)); ok = true; } catch {}
  }
  if (!ok) {
    const url = new URL('/login', req.url);
    if (req.nextUrl.pathname !== '/') url.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
// /join = the one-time app link (no sign-in yet); manifest and app icons are needed before sign-in to install the app.
export const config = { matcher: ['/((?!api|login|join|_next|favicon.ico|brand/|icon|apple-icon|app-icon|manifest.webmanifest).*)'] };
