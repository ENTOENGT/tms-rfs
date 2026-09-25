import { NextResponse } from 'next/server';
import { ApiError } from './db';

type Handler = (req: Request, ctx: { params: Record<string, string> }) => Promise<unknown>;

/** Wraps a route: JSON out, consistent errors, no stack traces to the client. */
export function route(fn: Handler) {
  return async (req: Request, ctx: { params: Record<string, string> }) => {
    try {
      const out = await fn(req, ctx);
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) {
      if (e instanceof ApiError)
        return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status });
      if (e?.code === '23505') return NextResponse.json({ error: { code: 'DUPLICATE', message: 'That value already exists' } }, { status: 409 });
      if (e?.code === '23503') return NextResponse.json({ error: { code: 'INVALID_REFERENCE', message: 'A selected item no longer exists' } }, { status: 400 });
      console.error(e);
      return NextResponse.json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong. Try again.' } }, { status: 500 });
    }
  };
}
export const body = async (req: Request) => { try { return await req.json(); } catch { return {}; } };
export const params = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);
