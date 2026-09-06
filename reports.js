import { sb, store, money, today, dayRange, fmtTime, loadProducts } from './db.js';
import { round2 } from './money.js';
import { $, esc, toast, modal, closeModal, printHTML, download, csv } from './ui.js';
import { receiptHTML } from './sell.js';

let day = today();
let sales = [];
let cash = [];

const KIND = { opening: 'Opening cash', in: 'Cash in', out: 'Cash out', close: 'Closing count' };
const sum = (arr, f) => round2(arr.reduce((s, x) => s + (+f(x) || 0), 0));
const live = () => sales.filter((s) => s.status === 'completed');

// ------------------------------------------------------------------ load
async function load() {
  const [from, to] = dayRange(day);
  const [s, c] = await Promise.all([
    sb.from('sales').select('*, sale_items(*)')
      .gte('created_at', from).lt('created_at', to).order('created_at', { ascending: false }),
    sb.from('cash_entries').select('*').eq('day', day).order('created_at'),
  ]);
  if (s.error || c.error) { toast((s.error || c.error).message, true); return; }
  sales = s.data; cash = c.data;
  paint();
}

// ------------------------------------------------------------------ paint
function paint() {
  const ok = live();
  const gross = sum(ok, (x) => x.subtotal);
  const disc = sum(ok, (x) => x.discount);
  const net = sum(ok, (x) => x.total);
  const cashSales = sum(ok, (x) => x.paid_cash);
  const online = sum(ok, (x) => x.paid_online);
  const pieces = sum(ok, (x) => sum(x.sale_items, (i) => i.qty));

  const card = (label, val, hi) =>
    `<div class="c ${hi ? 'hi' : ''}"><span class="muted small">${label}</span><b>${val}</b></div>`;
  $('#rp-summary').innerHTML =
    card('Bills', ok.length) +
    card('Pieces sold', pieces) +
    card('Gross', money(gross)) +
    card('Discount', money(disc)) +
    card('Net sales', money(net), true) +
    card('Cash', money(cashSales)) +
    card('UPI / Card', money(online));

  paintCash(cashSales);
  paintBills();
  paintLow();
}

function paintCash(cashSales) {
  const kind = (k) => cash.filter((e) => e.kind === k);
  const opening = sum(kind('opening'), (e) => e.amount);
  const inn = sum(kind('in'), (e) => e.amount);
  const out = sum(kind('out'), (e) => e.amount);
  const counted = kind('close').at(-1)?.amount;
  const expected = round2(opening + cashSales + inn - out);
  const variance = counted == null ? null : round2(+counted - expected);

  const line = (k, v, cls = '') => `<div class="row ${cls}"><span class="nm">${k}</span><b>${v}</b></div>`;
  $('#rp-cash').innerHTML = `<div class="list">
    ${line('Opening cash', money(opening))}
    ${line('+ Cash sales', money(cashSales))}
    ${inn ? line('+ Other cash in', money(inn)) : ''}
    ${out ? line('&minus; Expenses / cash out', money(out)) : ''}
    ${line('<b>Expected in drawer</b>', money(expected))}
    ${counted != null ? line('Counted at close', money(counted)) : ''}
    ${variance != null ? line(variance === 0 ? 'Tallies' : (variance > 0 ? 'Excess' : 'Short'),
        money(Math.abs(variance)), variance === 0 ? '' : 'low') : ''}
    ${cash.map((e) => `<div class="row" data-cash="${e.id}">
        <span class="nm">${KIND[e.kind] || esc(e.kind)}<span class="sub">${esc(e.note || '')} · ${esc(e.actor || '')} · ${fmtTime(e.created_at)}</span></span>
        <b>${money(e.amount)}</b>
        <button class="x" data-del="${e.id}">&times;</button>
      </div>`).join('')}
  </div>`;
}

function paintBills() {
  $('#rp-bills').innerHTML = sales.length ? sales.map((s) => `
    <div class="row ${s.status === 'returned' ? 'void' : ''}" data-bill="${s.id}">
      <span class="nm">${esc(s.bill_no)}
        <span class="sub">${fmtTime(s.created_at)} · ${s.sale_items.length} item(s) · ${esc(s.payment_mode)}${s.customer_name ? ' · ' + esc(s.customer_name) : ''}</span>
      </span>
      <b>${money(s.total)}</b>
    </div>`).join('')
    : '<p class="muted pad">No bills on this day.</p>';
}

function paintLow() {
  const low = store.products.filter((p) => p.active && +p.stock <= (+p.low_stock || 0));
  $('#rp-low').innerHTML = low.length ? low.map((p) => `
    <div class="row low"><span class="nm">${esc(p.name)}<span class="sub">${esc(p.barcode)}</span></span>
      <b>${+p.stock} left</b></div>`).join('')
    : '<p class="muted pad">Everything is above its alert level.</p>';
}

// ------------------------------------------------------------------ bill detail
function openBill(s) {
  modal(`<h3>${esc(s.bill_no)} ${s.status === 'returned' ? '(returned)' : ''}</h3>
    <p class="muted small">${fmtTime(s.created_at)} · ${esc(s.cashier || '')}
      ${s.customer_name ? ' · ' + esc(s.customer_name) + ' ' + esc(s.customer_phone || '') : ''}</p>
    <div class="list">${s.sale_items.map((i) => `<div class="row">
      <span class="nm">${esc(i.name)}<span class="sub">${+i.qty} x ${money(i.price)}</span></span>
      <b>${money(i.total)}</b></div>`).join('')}</div>
    <div class="totals">
      <div><span>Subtotal</span><b>${money(s.subtotal)}</b></div>
      ${+s.discount ? `<div><span>Discount</span><b>-${money(s.discount)}</b></div>` : ''}
      ${+s.tax ? `<div><span>Tax</span><b>${money(s.tax)}</b></div>` : ''}
      <div class="grand"><span>TOTAL</span><b>${money(s.total)}</b></div>
    </div>
    <div class="modal-actions">
      <button class="ghost" data-a="cancel">Close</button>
      ${s.status === 'completed' ? '<button class="ghost" data-a="return" style="color:var(--bad)">Return</button>' : ''}
      <button class="primary" data-a="print">Reprint</button>
    </div>`);

  $('#modal-body').onclick = async (e) => {
    const a = e.target.dataset.a;
    if (!a) return;
    if (a === 'cancel') return closeModal();
    if (a === 'print') {
      closeModal();
      return printHTML(receiptHTML({ ...s, items: s.sale_items }));
    }
    if (a === 'return') {
      if (!confirm(`Return bill ${s.bill_no}? Stock goes back and the bill is voided.`)) return;
      const { data, error } = await sb.rpc('return_sale', {
        p_sale_id: s.id, p_actor: store.user?.email?.split('@')[0] || null,
      });
      if (error || !data?.ok) return toast(error?.message || data?.error || 'Could not return', true);
      closeModal(); await loadProducts(); await load(); toast('Bill returned');
    }
  };
}

// ------------------------------------------------------------------ exports
function exportSales() {
  const rows = [['Bill', 'Date', 'Item', 'Qty', 'Rate', 'Amount', 'Bill total', 'Payment', 'Status', 'Cashier']];
  for (const s of sales) {
    for (const i of s.sale_items) {
      rows.push([s.bill_no, s.created_at, i.name, i.qty, i.price, i.total, s.total, s.payment_mode, s.status, s.cashier]);
    }
  }
  download(`sales-${day}.csv`, csv(rows), 'text/csv');
}

function exportItems() {
  const rows = [['Barcode', 'Name', 'Category', 'Price', 'Cost', 'Stock', 'Alert at']];
  for (const p of store.products) rows.push([p.barcode, p.name, p.category, p.price, p.cost, p.stock, p.low_stock]);
  download('items.csv', csv(rows), 'text/csv');
}

async function exportBackup() {
  toast('Building backup…');
  const [p, s, i, c, l] = await Promise.all([
    sb.from('products').select('*'),
    sb.from('sales').select('*'),
    sb.from('sale_items').select('*'),
    sb.from('cash_entries').select('*'),
    sb.from('stock_log').select('*'),
  ]);
  const err = [p, s, i, c, l].find((r) => r.error);
  if (err) return toast(err.error.message, true);
  download(`shopos-backup-${today()}.json`, JSON.stringify({
    exported_at: new Date().toISOString(), settings: store.settings,
    products: p.data, sales: s.data, sale_items: i.data, cash_entries: c.data, stock_log: l.data,
  }, null, 2), 'application/json');
}

// ------------------------------------------------------------------ wiring
export function init() {
  $('#rp-day').value = day;
  $('#rp-day').onchange = (e) => { day = e.target.value || today(); load(); };
  const shift = (n) => {
    const [y, m, d] = day.split('-').map(Number);
    day = today(new Date(y, m - 1, d + n));
    $('#rp-day').value = day;
    load();
  };
  $('#rp-prev').onclick = () => shift(-1);
  $('#rp-next').onclick = () => shift(1);
  $('#rp-refresh').onclick = () => { loadProducts().then(load); };

  $('#cb-add').onclick = async () => {
    const amount = +$('#cb-amt').value;
    if (!(amount > 0)) return toast('Enter an amount', true);
    const { error } = await sb.from('cash_entries').insert({
      day, kind: $('#cb-kind').value, amount,
      note: $('#cb-note').value.trim() || null,
      actor: store.user?.email?.split('@')[0] || null,
    });
    if (error) return toast(error.message, true);
    $('#cb-amt').value = ''; $('#cb-note').value = '';
    load();
  };

  $('#rp-cash').onclick = async (e) => {
    const id = e.target.dataset.del;
    if (!id || !confirm('Delete this cash entry?')) return;
    const { error } = await sb.from('cash_entries').delete().eq('id', id);
    if (error) return toast(error.message, true);
    load();
  };

  $('#rp-bills').onclick = (e) => {
    const row = e.target.closest('[data-bill]');
    if (row) openBill(sales.find((s) => s.id === +row.dataset.bill));
  };

  $('#ex-sales').onclick = exportSales;
  $('#ex-items').onclick = exportItems;
  $('#ex-backup').onclick = exportBackup;
}

export function show() { load(); }
