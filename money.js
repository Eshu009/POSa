// Pure bill arithmetic. No imports, no DOM — so test.mjs can run it in node.
export const round2 = (n) => Math.round(((+n || 0) + Number.EPSILON) * 100) / 100;

/**
 * @param lines        [{qty, price}]
 * @param discount     number entered by the cashier
 * @param discountPct  true = discount is a %, false = flat amount
 * @param taxPercent   0 for none
 * @param taxIncluded  true = listed prices already contain the tax
 */
export function calcTotals(lines, discount = 0, discountPct = false, taxPercent = 0, taxIncluded = true) {
  const subtotal = round2(lines.reduce((s, l) => s + (+l.qty || 0) * (+l.price || 0), 0));
  let disc = discountPct ? (subtotal * (+discount || 0)) / 100 : (+discount || 0);
  disc = round2(Math.min(Math.max(disc, 0), subtotal));      // never negative, never past the subtotal

  const net = round2(subtotal - disc);
  const r = (+taxPercent || 0) / 100;
  let tax = 0, total = net;
  if (r > 0) {
    if (taxIncluded) tax = round2(net - net / (1 + r));       // carved out of the price
    else { tax = round2(net * r); total = round2(net + tax); }
  }
  return { subtotal, discount: disc, tax, total: round2(total) };
}

/** Cash tendered is the input; whatever is left is on UPI/card. */
export function splitPayment(total, mode, cashEntered = 0) {
  if (mode === 'cash') return { paid_cash: total, paid_online: 0 };
  if (mode === 'upi' || mode === 'card') return { paid_cash: 0, paid_online: total };
  const cash = round2(Math.min(Math.max(+cashEntered || 0, 0), total));
  return { paid_cash: cash, paid_online: round2(total - cash) };
}
