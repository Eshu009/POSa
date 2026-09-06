import { sb, store, money, fmtTime, isOwner, loadProducts } from './db.js';
import { $, esc, toast, modal, closeModal, printHTML } from './ui.js';

let orders = [];
let filter = 'new';
let lastNewCount = null;

const NEXT  = { new: 'confirmed', confirmed: 'packed', packed: 'shipped', shipped: 'delivered' };
const LABEL = { new: 'New', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
const VERB  = { confirmed: 'Confirm & take stock', packed: 'Mark packed', shipped: 'Mark shipped', delivered: 'Mark delivered' };

// ------------------------------------------------------------------ data
async function load() {
  let q = sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(200);
  if (filter !== 'all') q = q.eq('status', filter);
  const { data, error } = await q;
  if (error) return toast(error.message, true);
  orders = data;
  paint();
}

/** Called every 30 s from app.js. Updates the tab badge and nudges on new orders. */
export async function pollNew() {
  const { count, error } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'new');
  if (error) return;
  const b = $('#tab-orders-n');
  b.hidden = !count; b.textContent = count;
  if (lastNewCount !== null && count > lastNewCount) {
    toast(`${count - lastNewCount} new online order${count - lastNewCount > 1 ? 's' : ''}`);
    if ($('#scr-orders').classList.contains('active')) load();
  }
  lastNewCount = count;
}

// ------------------------------------------------------------------ paint
function paint() {
  $('#or-list').innerHTML = orders.length ? orders.map((o) => `
    <div class="row ${o.status === 'cancelled' ? 'void' : ''}" data-id="${o.id}">
      <span class="nm">${esc(o.order_no)} <span class="pill st-${o.status}">${LABEL[o.status]}</span>
        <span class="sub">${fmtTime(o.created_at)} · ${esc(o.customer_name)} · ${o.order_items.length} item(s)${o.city ? ' · ' + esc(o.city) : ''}</span>
      </span>
      <b>${money(o.total)}</b>
    </div>`).join('')
    : `<p class="muted pad">No ${filter === 'all' ? '' : LABEL[filter].toLowerCase() + ' '}orders.</p>`;
}

function openOrder(o) {
  const next = NEXT[o.status];
  const wa = o.customer_phone.replace(/\D/g, '');
  modal(`<h3>${esc(o.order_no)} <span class="pill st-${o.status}">${LABEL[o.status]}</span></h3>
    <p class="muted small">${fmtTime(o.created_at)}${o.handled_by ? ' · last touched by ' + esc(o.handled_by) : ''}</p>

    <div class="list">
      <div class="row"><span class="nm">${esc(o.customer_name)}
        <span class="sub">${esc(o.address)}${o.city ? ', ' + esc(o.city) : ''}${o.pincode ? ' — ' + esc(o.pincode) : ''}</span>
        ${o.note ? `<span class="sub">“${esc(o.note)}”</span>` : ''}
      </span></div>
      <div class="bar" style="margin:0">
        <a class="ghost" style="flex:1;display:grid;place-items:center;text-decoration:none" href="tel:${esc(o.customer_phone)}">Call ${esc(o.customer_phone)}</a>
        <a class="ghost" style="flex:1;display:grid;place-items:center;text-decoration:none" target="_blank" rel="noopener"
           href="https://wa.me/${wa.length === 10 ? '91' + wa : wa}?text=${encodeURIComponent(`Hi ${o.customer_name}, this is ${store.settings.shopName} about your order ${o.order_no}.`)}">WhatsApp</a>
      </div>
    </div>

    <div class="list" style="margin-top:10px">${o.order_items.map((i) => {
      const p = store.byId.get(i.product_id);
      const short = p && +p.stock < +i.qty && !o.stock_taken;
      return `<div class="row ${short ? 'low' : ''}">
        <span class="nm">${esc(i.name)}<span class="sub">${esc(i.barcode || '')} · ${+i.qty} × ${money(i.price)}${short ? ` · only ${+p.stock} in stock` : ''}</span></span>
        <b>${money(i.total)}</b></div>`; }).join('')}</div>

    <div class="totals">
      <div><span>Subtotal</span><b>${money(o.subtotal)}</b></div>
      <div><span>Delivery</span><b>${money(o.shipping)}</b></div>
      <div class="grand"><span>TOTAL</span><b>${money(o.total)}</b></div>
      <div><span>Payment</span><b>${o.payment_mode === 'cod' ? 'Cash on delivery' : 'Online'} · ${esc(o.payment_status)}</b></div>
    </div>

    <div class="modal-actions" style="flex-wrap:wrap">
      <button class="ghost" data-a="close">Close</button>
      <button class="ghost" data-a="slip">Packing slip</button>
      ${isOwner() && o.status !== 'cancelled' && o.status !== 'delivered'
        ? '<button class="ghost" data-a="cancel" style="color:var(--bad)">Cancel order</button>' : ''}
      ${next ? `<button class="primary" data-a="next" data-st="${next}" style="flex-basis:100%">${VERB[next]}</button>` : ''}
    </div>`);

  $('#modal-body').onclick = async (e) => {
    const a = e.target.dataset.a;
    if (!a) return;
    if (a === 'close') return closeModal();
    if (a === 'slip') { closeModal(); return printHTML(slipHTML(o)); }
    const status = a === 'cancel' ? 'cancelled' : e.target.dataset.st;
    if (a === 'cancel' && !confirm(`Cancel ${o.order_no}?${o.stock_taken ? ' Stock goes back to the shelf.' : ''}`)) return;
    e.target.disabled = true;
    const { error } = await sb.rpc('set_order_status', {
      p_order_id: o.id, p_status: status, p_actor: store.user?.email?.split('@')[0] || null,
    });
    if (error) { e.target.disabled = false; return toast(error.message, true); }
    closeModal();
    toast(`${o.order_no} → ${LABEL[status]}`);
    await Promise.all([loadProducts(), load(), pollNew()]);
  };
}

function slipHTML(o) {
  const st = store.settings;
  return `<div class="receipt w${st.receiptWidth === 'A5' ? 'A5' : '80mm'}">
    <h2>${esc(st.shopName)}</h2>
    <div class="ctr">PACKING SLIP</div>
    <hr>
    <table>
      <tr><td>Order</td><td class="r">${esc(o.order_no)}</td></tr>
      <tr><td>Placed</td><td class="r">${fmtTime(o.created_at)}</td></tr>
      <tr><td>Payment</td><td class="r">${o.payment_mode === 'cod' ? 'COD ' + money(o.total) : 'PAID'}</td></tr>
    </table>
    <hr>
    <b>DELIVER TO</b><br>
    ${esc(o.customer_name)}<br>
    ${esc(o.address).replace(/\n/g, '<br>')}<br>
    ${o.city ? esc(o.city) + ' ' : ''}${o.pincode ? esc(o.pincode) : ''}<br>
    Ph: ${esc(o.customer_phone)}
    ${o.note ? `<br><i>Note: ${esc(o.note)}</i>` : ''}
    <hr>
    <table>${o.order_items.map((i) => `
      <tr><td colspan="2">${esc(i.name)}</td></tr>
      <tr><td>${esc(i.barcode || '')}</td><td class="r">× ${+i.qty}</td></tr>`).join('')}
    </table>
    <hr>
    <table>
      <tr><td>Items</td><td class="r">${o.order_items.reduce((s, i) => s + +i.qty, 0)}</td></tr>
      <tr class="tot"><td>${o.payment_mode === 'cod' ? 'COLLECT' : 'TOTAL'}</td><td class="r">${money(o.total)}</td></tr>
    </table>
    <div class="ctr">&nbsp;</div>
  </div>`;
}

// ------------------------------------------------------------------ wiring
export function init() {
  $('#or-filter').onclick = (e) => {
    const b = e.target.closest('button[data-st]');
    if (!b) return;
    filter = b.dataset.st;
    $('#or-filter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    load();
  };
  $('#or-list').onclick = (e) => {
    const row = e.target.closest('[data-id]');
    if (row) openOrder(orders.find((o) => o.id === +row.dataset.id));
  };
  $('#or-refresh').onclick = load;
}

export async function show() {
  await loadProducts();
  load();
}
