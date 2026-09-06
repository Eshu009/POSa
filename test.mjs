// Bill arithmetic self-check:  node test.mjs
import assert from 'node:assert/strict';
import { calcTotals, splitPayment, round2 } from './money.js';

const L = (qty, price) => ({ qty, price });

// plain bill, no discount, no tax
assert.deepEqual(calcTotals([L(2, 150), L(1, 99)]),
  { subtotal: 399, discount: 0, tax: 0, total: 399 });

// flat discount
assert.deepEqual(calcTotals([L(2, 150)], 50),
  { subtotal: 300, discount: 50, tax: 0, total: 250 });

// percentage discount
assert.deepEqual(calcTotals([L(1, 250)], 10, true),
  { subtotal: 250, discount: 25, tax: 0, total: 225 });

// a discount can never exceed the bill or go negative
assert.equal(calcTotals([L(1, 100)], 500).total, 0);
assert.equal(calcTotals([L(1, 100)], -20).discount, 0);
assert.equal(calcTotals([L(1, 100)], 300, true).discount, 100);

// tax carved out of an inclusive price: total is unchanged, tax is shown
{
  const t = calcTotals([L(1, 103)], 0, false, 3, true);
  assert.equal(t.total, 103);
  assert.equal(t.tax, 3);
}

// tax added on top of an exclusive price
{
  const t = calcTotals([L(1, 100)], 0, false, 3, false);
  assert.equal(t.tax, 3);
  assert.equal(t.total, 103);
}

// discount is applied before tax
{
  const t = calcTotals([L(1, 200)], 100, false, 5, false);
  assert.equal(t.tax, 5);
  assert.equal(t.total, 105);
}

// classic float trap: 0.1 + 0.2 style drift must not leak into a bill
assert.equal(calcTotals([L(3, 0.1)]).subtotal, 0.3);
assert.equal(round2(1.005), 1.01);

// payment splits always add up to the total
for (const mode of ['cash', 'upi', 'card', 'split']) {
  const p = splitPayment(250, mode, 100);
  assert.equal(round2(p.paid_cash + p.paid_online), 250, mode);
}
assert.deepEqual(splitPayment(250, 'split', 100), { paid_cash: 100, paid_online: 150 });
assert.deepEqual(splitPayment(250, 'split', 999), { paid_cash: 250, paid_online: 0 });
assert.deepEqual(splitPayment(250, 'split', -5), { paid_cash: 0, paid_online: 250 });

console.log('money.js OK');
