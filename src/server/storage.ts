/**
 * File storage for POD and job documents.
 *
 * Production: a PRIVATE Supabase Storage bucket. The browser uploads straight to
 * Supabase using a one-time signed upload link (so large phone photos don't pass
 * through our server), and downloads use signed links that expire after 2 minutes —
 * issued only after the server has checked the user may see that document.
 *
 * Development/tests: set STORAGE_DRIVER=local to keep files on disk in ./.uploads.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { mkdir, readFile, stat as fsStat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { StorageClient } from '@supabase/storage-js';
import { ApiError } from './db';

export const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'tms-documents';

export interface UploadTarget { url: string; method: 'PUT'; headers: Record<string, string> }
export interface FileStore {
  driver: 'supabase' | 'local';
  createUpload(key: string, contentType: string): Promise<UploadTarget>;
  stat(key: string): Promise<{ size: number; contentType: string | null } | null>;
  downloadUrl(key: string, fileName: string): Promise<string>;
  remove(key: string): Promise<void>;
}

// ------------------------------------------------------------ supabase
/**
 * Accepts whatever was pasted into SUPABASE_URL and returns just "https://<project>.supabase.co".
 * Handles: extra paths (/rest/v1, /storage/v1), the dashboard link, the database connection
 * string, missing https://, quotes and spaces. Anything else must be a plain web address.
 */
export function normalizeSupabaseUrl(raw: string): string {
  let s = raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
  const dash = s.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1].toLowerCase()}.supabase.co`;
  if (/^postgres(ql)?:\/\//i.test(s)) {                     // database connection string pasted by mistake
    const user = s.match(/^postgres(?:ql)?:\/\/postgres\.([a-z0-9]+)[:@]/i);
    const direct = s.match(/@db\.([a-z0-9]+)\.supabase\.co/i);
    const ref = user?.[1] ?? direct?.[1];
    if (ref) return `https://${ref.toLowerCase()}.supabase.co`;
    throw new ApiError(500, 'STORAGE_URL_INVALID', 'SUPABASE_URL contains a database connection string. Use the Project URL instead (https://….supabase.co).');
  }
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u: URL;
  try { u = new URL(s); } catch {
    throw new ApiError(500, 'STORAGE_URL_INVALID', 'SUPABASE_URL is not a valid web address. It should look like https://abcdefghij.supabase.co');
  }
  const host = u.hostname.replace(/^db\./i, '');
  return `https://${host}`;
}

function supabaseStore(rawUrl: string, key: string): FileStore {
  const origin = normalizeSupabaseUrl(rawUrl);
  const base = origin + '/storage/v1';
  // Legacy service_role keys are JWTs (eyJ…) and go in both headers; newer sb_secret_… keys go in apikey only.
  const k = key.trim().replace(/^['"]+|['"]+$/g, '').trim();
  const headers: Record<string, string> = k.startsWith('eyJ') ? { apikey: k, Authorization: `Bearer ${k}` } : { apikey: k };
  const bucket = () => new StorageClient(base, headers).from(BUCKET);
  const fail = (what: string, e: any): never => {
    // The project address is not secret; showing it makes wrong settings obvious.
    throw new ApiError(502, 'STORAGE_ERROR', `File storage error while ${what}: ${e?.message ?? e} (storage address used: ${origin})`);
  };
  return {
    driver: 'supabase',
    async createUpload(k, contentType) {
      const { data, error } = await bucket().createSignedUploadUrl(k);
      if (error || !data) fail('preparing the upload', error);
      return { url: data!.signedUrl, method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'false' } };
    },
    async stat(k) {
      const { data, error } = await bucket().info(k);
      if (error || !data) return null;
      const d: any = data;
      return { size: Number(d.size ?? d.metadata?.size ?? 0), contentType: d.contentType ?? d.metadata?.mimetype ?? null };
    },
    async downloadUrl(k, fileName) {
      const { data, error } = await bucket().createSignedUrl(k, 120, { download: fileName });
      if (error || !data) fail('preparing the download', error);
      return data!.signedUrl;
    },
    async remove(k) {
      const { error } = await bucket().remove([k]);
      if (error) fail('deleting', error);
    },
  };
}

// ------------------------------------------------------------ local (dev/tests only)
const LOCAL_DIR = path.resolve(process.env.LOCAL_UPLOAD_DIR || '.uploads');
function localSig(k: string, action: 'put' | 'get', exp: number) {
  return createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(`${action}:${k}:${exp}`).digest('base64url');
}
export function verifyLocalSig(k: string, action: 'put' | 'get', exp: number, sig: string) {
  if (!k || k.includes('..') || Date.now() > exp) return false;
  const a = Buffer.from(localSig(k, action, exp)), b = Buffer.from(sig || '');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const localPath = (k: string) => path.join(LOCAL_DIR, k);
function localStore(): FileStore {
  const link = (k: string, action: 'put' | 'get', extra = '') => {
    const exp = Date.now() + 10 * 60 * 1000;
    return `/api/dev-storage?key=${encodeURIComponent(k)}&action=${action}&exp=${exp}&sig=${localSig(k, action, exp)}${extra}`;
  };
  return {
    driver: 'local',
    async createUpload(k, contentType) { return { url: link(k, 'put'), method: 'PUT', headers: { 'content-type': contentType } }; },
    async stat(k) {
      try {
        const s = await fsStat(localPath(k));
        const ct = await readFile(localPath(k) + '.type', 'utf8').catch(() => null);
        return { size: s.size, contentType: ct };
      } catch { return null; }
    },
    async downloadUrl(k, fileName) { return link(k, 'get', `&name=${encodeURIComponent(fileName)}`); },
    async remove(k) { await unlink(localPath(k)).catch(() => {}); await unlink(localPath(k) + '.type').catch(() => {}); },
  };
}
export async function localWrite(k: string, body: Buffer, contentType: string) {
  await mkdir(path.dirname(localPath(k)), { recursive: true });
  await writeFile(localPath(k), body);
  await writeFile(localPath(k) + '.type', contentType);
}

export function fileStore(): FileStore {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return supabaseStore(url, key);
  if (process.env.STORAGE_DRIVER === 'local') return localStore();
  throw new ApiError(503, 'STORAGE_NOT_CONFIGURED',
    'File uploads are not set up yet. An administrator needs to add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify.');
}
