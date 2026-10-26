// Netlify scheduled function: every hour, ask the app to delete request documents older than 30 days.
// Netlify runs this automatically on the published site — nothing to start by hand.
// The app checks the key (made from SESSION_SECRET) before doing anything.
import { createHmac } from 'node:crypto';

export default async () => {
  const site = process.env.URL;
  const key = createHmac('sha256', process.env.SESSION_SECRET || '').update('document-cleanup').digest('hex');
  const res = await fetch(`${site}/api/cron/document-cleanup`, { method: 'POST', headers: { 'x-cron-key': key } });
  const text = await res.text();
  console.log('Document clean-up', res.status, text.slice(0, 300));
  return new Response(text, { status: res.status });
};

export const config = { schedule: '@hourly' };
