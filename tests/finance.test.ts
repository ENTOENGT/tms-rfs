import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseCost, summariseCommercial, summariseProfit, toFils } from '../src/lib/finance';

test('spec worked example (section 30)', () => {
  const cost = summariseCost([{ amount: '250' }, { amount: '20' }, { amount: '10' }, { amount: '5' }]);
  assert.equal(cost.total_cost, '285.00');
  const c = summariseCommercial([{ amount: '400' }], '0', '5');
  assert.deepEqual([c.net_revenue, c.vat_amount, c.customer_total], ['400.00', '20.00', '420.00']);
  const p = summariseProfit(c.net_revenue, cost.total_cost);
  assert.deepEqual(p, { gross_profit: '115.00', margin_pct: '28.75' });
});
test('profit uses revenue before VAT, never VAT-inclusive', () => {
  const c = summariseCommercial([{ amount: '500' }], '0', '5');
  assert.equal(summariseProfit(c.net_revenue, '300').gross_profit, '200.00');
  assert.equal(summariseProfit(c.net_revenue, '300').margin_pct, '40.00');
});
test('no float drift on awkward decimals', () => {
  const cost = summariseCost([{ amount: '0.10' }, { amount: '0.20' }]);
  assert.equal(cost.total_cost, '0.30');
  const c = summariseCommercial([{ amount: '33.33' }], '0', '5');
  assert.equal(c.vat_amount, '1.67'); // 1.6665 rounds half-up
});
test('discount applied before VAT and cannot exceed selling', () => {
  const c = summariseCommercial([{ amount: '400' }, { amount: '50' }], '30', '5');
  assert.deepEqual([c.net_revenue, c.vat_amount, c.customer_total], ['420.00', '21.00', '441.00']);
  assert.throws(() => summariseCommercial([{ amount: '10' }], '11', '5'));
});
test('zero revenue gives null margin, losses are negative', () => {
  assert.equal(summariseProfit('0.00', '100').margin_pct, null);
  assert.deepEqual(summariseProfit('100.00', '150.00'), { gross_profit: '-50.00', margin_pct: '-50.00' });
});
test('rejects malformed amounts', () => {
  assert.throws(() => toFils('12.345'));
  assert.throws(() => toFils('1e3'));
});
