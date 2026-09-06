import { store, money, cur, fmtTime, findByBarcode, searchProducts, createSale, loadProducts } from './db.js';
import { calcTotals, splitPayment, round2 } from './money.js';
import { $, $$, esc, toast, modal, closeModal, printHTML, scanBarcode } from './ui.js';

let cart = [];            // [{product_id, name, barcode, qty, price, stock}]
let discPct = false;
let mode = 'cash';

// ------------------------------------------------------------------ cart ops
function add(p) {
  const line = cart.find((l) => l.product_id === p.id);
  if (line) line.qty = round2(line.qty + 1);
  else cart.push({ product_id: p.id, name: p.name, barcode: p.barcode, qty: 1, price: +p.price, stock: +p.stock });
  if (p.stock <= 0) toast(`${p.name} shows 0 in stock`, true);
  render();
}
const setQty = (i, q) => { q = round2(q); if (q <= 0) cart.splice(i, 1); else cart[i].qty = q; render(); };

export function clearCart() {
  cart = []; discPct = false; mode = 'cash';
  $('#t-disc').value = 0;
  $('#t-disc-mode').textContent = cur();
  $('#cu-name').value = ''; $('#cu-phone').value = '';
  $('#pay-cash').value = '';
  $$('#pay-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'cash'));
  $('#split-row').hidden = true;
  render();
}

function totals() {
  const s = store.settings;
  return calcTotals(cart, +$('#t-disc').value, discPct, s.taxPercent, s.taxIncluded);
}

// ------------------------------------------------------------------ rendering
function render() {
  const body = $('#cart-body');
  body.innerHTML = cart.map((l, i) => `
    <div class="ci">
      <div class="ci-top">
        <span class="nm">${esc(l.name)}<span class="sub">${esc(l.barcode)}</span></span>
        <button class="x" data-a="del" data-i="${i}">&times;</button>
      </div>
      <div class="ci-bot">
        <span class="qty">
          <button data-a="dec" data-i="${i}">&minus;</button>
          <input data-a="qty" data-i="${i}" type="number" min="0" step="1" value="${l.qty}" inputmode="decimal">
          <button data-a="inc" data-i="${i}">+</button>
        </span>
        <span class="rate">${cur()}<input data-a="price" data-i="${i}" type="number"
          min="0" step="1" value="${l.price}" inputmode="decimal"></span>
        <b class="amt">${money(l.qty * l.price)}</b>
      </div>
    </div>`).join('');
  $('#cart-empty').hidden = cart.length > 0;

  const t = totals();
  $('#t-sub').textContent = money(t.subtotal);
  $('#t-tax-row').hidden = !(store.settings.taxPercent > 0);
  $('#t-tax-label').textContent = `Tax ${store.settings.taxPercent}%` +
    (store.settings.taxIncluded ? ' (incl.)' : '');
  $('#t-tax').textContent = money(t.tax);
  $('#t-total').textContent = money(t.total);
  if (mode === 'split') $('#pay-online').value = round2(t.total - (+$('#pay-cash').value || 0));
}

function renderResults(list, q) {
  $('#results').innerHTML = list.length
    ? list.map((p) => `
        <button class="row" data-id="${p.id}">
          <span class="nm">${esc(p.name)}
            <span class="sub">${esc(p.barcode)}${p.category ? ' · ' + esc(p.category) : ''} · stock ${+p.stock}</span>
          </span>
          <b>${money(p.price)}</b>
        </button>`).join('')
    : `<p class="muted pad">No item matches “${esc(q)}”.</p>`;
}

// ------------------------------------------------------------------ checkout
async function charge() {
  if (!cart.length) return toast('Cart is empty', true);
  const t = totals();
  if (t.total <= 0) return toast('Total is zero', true);

  if (mode === 'upi' && store.settings.upiId) {
    const ok = await upiQR(t.total);
    if (!ok) return;
  }

  const pay = splitPayment(t.total, mode, +$('#pay-cash').value);
  const payload = {
    ...t, ...pay,
    payment_mode: mode,
    customer_name: $('#cu-name').value.trim() || null,
    customer_phone: $('#cu-phone').value.trim() || null,
    cashier: store.user?.email?.split('@')[0] || null,
    items: cart.map((l) => ({
      product_id: l.product_id, name: l.name, barcode: l.barcode,
      qty: l.qty, price: l.price, total: round2(l.qty * l.price),
    })),
  };

  const btn = $('#btn-charge');
  btn.disabled = true;
  const res = await createSale(payload);
  btn.disabled = false;

  toast(res.offline ? 'Saved offline — will sync automatically' : 'Bill ' + res.bill_no);
  printHTML(receiptHTML({ ...payload, bill_no: res.bill_no, created_at: payload.created_at }));
  clearCart();
  $('#scan').focus();
}

/** Shows a UPI QR the customer scans. Resolves true when the cashier confirms. */
async function upiQR(amount) {
  const s = store.settings;
  const link = 'upi://pay?' + new URLSearchParams({
    pa: s.upiId, pn: s.shopName, am: amount.toFixed(2), cu: 'INR', tn: 'Bill',
  });
  let inner = `<p class="small" style="word-break:break-all">${esc(link)}</p>`;
  try {
    const { default: qrcode } = await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');
    const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
    inner = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  } catch { /* offline or blocked — the raw link still works if typed */ }

  modal(`<div class="qrbox"><h3>${money(amount)}</h3>${inner}
    <p class="muted small">Customer scans with any UPI app</p></div>
    <div class="modal-actions">
      <button class="ghost" data-a="cancel">Cancel</button>
      <button class="primary" data-a="ok">Payment received</button>
    </div>`);
  return new Promise((resolve) => {
    $('#modal-body').onclick = (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      closeModal();
      resolve(a === 'ok');
    };
  });
}

// ------------------------------------------------------------------ receipt
export function receiptHTML(s) {
  const st = store.settings;
  const n = (v) => +v || 0;
  const line = (l) => `<tr><td colspan="3">${esc(l.name)}</td></tr>
    <tr><td>${n(l.qty)} x ${n(l.price).toFixed(2)}</td><td></td><td class="r">${n(l.total).toFixed(2)}</td></tr>`;
  const row = (k, v) => `<tr><td colspan="2">${k}</td><td class="r">${v}</td></tr>`;
  const payLabel = { cash: 'Cash', upi: 'UPI', card: 'Card', split: 'Cash + Online' }[s.payment_mode] || s.payment_mode;

  return `<div class="receipt w${st.receiptWidth}">
    <h2>${esc(st.shopName)}</h2>
    ${st.address ? `<div class="ctr">${esc(st.address).replace(/\n/g, '<br>')}</div>` : ''}
    ${st.phone ? `<div class="ctr">Ph: ${esc(st.phone)}</div>` : ''}
    ${st.gstin ? `<div class="ctr">GSTIN: ${esc(st.gstin)}</div>` : ''}
    <hr>
    <table>
      <tr><td>Bill ${esc(s.bill_no)}</td><td class="r">${esc(s.cashier || '')}</td></tr>
      <tr><td colspan="2">${fmtTime(s.created_at)}</td></tr>
      ${s.customer_name ? `<tr><td colspan="2">${esc(s.customer_name)} ${esc(s.customer_phone || '')}</td></tr>` : ''}
    </table>
    <hr>
    <table>${s.items.map(line).join('')}</table>
    <hr>
    <table>
      ${row('Subtotal', n(s.subtotal).toFixed(2))}
      ${n(s.discount) ? row('Discount', '-' + n(s.discount).toFixed(2)) : ''}
      ${n(s.tax) ? row(`Tax ${st.taxPercent}%${st.taxIncluded ? ' (incl)' : ''}`, n(s.tax).toFixed(2)) : ''}
      <tr class="tot"><td colspan="2">TOTAL</td><td class="r">${cur()}${n(s.total).toFixed(2)}</td></tr>
      ${row('Paid by', payLabel)}
      ${s.payment_mode === 'split'
        ? row('Cash / Online', `${n(s.paid_cash).toFixed(2)} / ${n(s.paid_online).toFixed(2)}`) : ''}
    </table>
    <hr>
    <div class="ctr">${esc(st.footer || '')}</div>
    ${s.status === 'returned' ? '<div class="ctr"><b>*** RETURNED ***</b></div>' : ''}
    <div class="ctr">&nbsp;</div>
  </div>`;
}

// ------------------------------------------------------------------ wiring
export function init() {
  const scan = $('#scan');

  // A USB / bluetooth scanner is just a keyboard: it types the code then Enter.
  scan.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = scan.value.trim();
    if (!v) return;
    const p = findByBarcode(v);
    if (p) { add(p); scan.value = ''; renderResults(searchProducts(''), ''); }
    else {
      const hits = searchProducts(v);
      if (hits.length === 1) { add(hits[0]); scan.value = ''; renderResults(searchProducts(''), ''); }
      else renderResults(hits, v);
    }
  });
  scan.addEventListener('input', () => renderResults(searchProducts(scan.value), scan.value));

  $('#btn-cam').onclick = async () => {
    const code = await scanBarcode();
    if (!code) return;
    const p = findByBarcode(code);
    p ? add(p) : toast('No item with barcode ' + code, true);
  };

  $('#results').onclick = (e) => {
    const btn = e.target.closest('.row');
    if (!btn) return;
    add(store.byId.get(+btn.dataset.id));
    $('#scan').value = '';
    renderResults(searchProducts(''), '');
    $('#scan').focus();
  };

  $('#cart-body').addEventListener('click', (e) => {
    const { a, i } = e.target.dataset;
    if (a === 'inc') setQty(+i, cart[+i].qty + 1);
    if (a === 'dec') setQty(+i, cart[+i].qty - 1);
    if (a === 'del') setQty(+i, 0);
  });
  $('#cart-body').addEventListener('change', (e) => {
    const { a, i } = e.target.dataset;
    if (a === 'qty') setQty(+i, +e.target.value);
    if (a === 'price') { cart[+i].price = Math.max(0, +e.target.value || 0); render(); }
  });

  $('#t-disc').addEventListener('input', render);
  $('#t-disc-mode').onclick = () => {
    discPct = !discPct;
    $('#t-disc-mode').textContent = discPct ? '%' : cur();
    render();
  };
  $('#pay-cash').addEventListener('input', render);

  $('#pay-mode').onclick = (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    $$('#pay-mode button').forEach((x) => x.classList.toggle('on', x === b));
    $('#split-row').hidden = mode !== 'split';
    render();
  };

  $('#btn-clear').onclick = () => cart.length && confirm('Clear the cart?') && clearCart();
  $('#btn-charge').onclick = charge;

  $('#t-disc-mode').textContent = cur();
  render();
}

export function show() {
  loadProducts().then(() => renderResults(searchProducts($('#scan').value), $('#scan').value));
  setTimeout(() => $('#scan').focus(), 50);
}
