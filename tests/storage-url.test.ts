import { test } from 'node:test'; import assert from 'node:assert/strict';
import { normalizeSupabaseUrl as n } from '../src/server/storage';
const R = 'https://abcdefghijklmnop.supabase.co';
test('normalises everything people paste', () => {
  for (const v of ['https://abcdefghijklmnop.supabase.co', 'https://abcdefghijklmnop.supabase.co/', ' https://abcdefghijklmnop.supabase.co ',
    'https://abcdefghijklmnop.supabase.co/rest/v1/', 'https://abcdefghijklmnop.supabase.co/storage/v1', 'abcdefghijklmnop.supabase.co',
    '"https://abcdefghijklmnop.supabase.co"', 'https://supabase.com/dashboard/project/abcdefghijklmnop/settings/api',
    'postgresql://postgres.abcdefghijklmnop:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres'])
    assert.equal(n(v), R, v);
  assert.throws(() => n('not a url at all ::'));
});
