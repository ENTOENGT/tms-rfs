'use client';
// Shared bits for the PRO screens.
import { api } from './api';
import { shrinkImage } from './JobFiles';

export const PRIORITY: Record<string, string> = { normal: 'Normal', urgent: 'Urgent', critical: 'Critical' };
export const DIRECTION: Record<string, string> = { import: 'Import', export: 'Export', transit: 'Transit' };
export const proFileUrl = (id: string) => `/api/pro-files/${id}`;
export const proAct = (id: string, action: string, body: Record<string, unknown> = {}) => api(`/api/pro/${id}`, { body: { ...body, action } });

/** Upload one file to a PRO request (or an activity), optionally replacing an older version. Returns the refreshed request. */
export async function uploadPro(id: string, original: File, docType: string, extra: { activity_id?: string; replaces_id?: string } = {}) {
  const file = await shrinkImage(original);
  const mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
  const r = await proAct(id, 'upload-url', { file_name: file.name, mime_type: mime, size: file.size, doc_type: docType, ...extra });
  const put = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: file });
  if (!put.ok) throw new Error(`Upload of ${file.name} failed (${put.status}). Please try again.`);
  return proAct(id, 'upload-confirm', { ticket: r.ticket });
}

export function PriorityFlag({ p }: { p: string }) {
  return p === 'normal' ? null : <span className="flag" style={p === 'critical' ? { background: '#9B2C2C', color: '#fff' } : undefined}>{PRIORITY[p]}</span>;
}
