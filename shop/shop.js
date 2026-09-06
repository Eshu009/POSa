import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  products: [], byId: new Map(), settings: {},
  cat: '', q: '', sort: 'new',
  cart: load('sf.cart', []),          // [{id, qty}]
};
function load(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } }

// ---------------------------------------------------------------- formatting
const cur = () => state.settings.currency || '₹';
const money = (n) => cur() + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/** Image for a product: explicit URL wins; otherwise <imageBase>/<barcode>.jpg */
function imgSrc(p) {
  if (p.image_url) return p.image_url;
  const b = state.settings.image_base;
  return b ? b.replace(/\/?$/, '/') + p.barcode + '.jpg' : '';
}
const figure = (p, cls = '') => `
  <figure class="arch ${cls}">
    ${imgSrc(p) ? `<img src="${esc(imgSrc(p))}" alt="${esc(p.name)}" loading="lazy" decoding="async"
      onload="this.classList.add('ok')" onerror="this.remove()">` : ''}
    <div class="ph"><svg><use href="#mark"/></svg></div>
  </figure>`;

function toast(msg, bad = false) {
  const d = document.createElement('div');
  d.textContent = msg; if (bad) d.className = 'bad';
  $('#toast').append(d);
  setTimeout(() => d.remove(), bad ? 4200 : 2200);
}

// ---------------------------------------------------------------- data
async function boot() {
  const [p, s] = await Promise.all([
    sb.from('shop_products').select('*').order('id', { ascending: false }),
    sb.from('shop_settings').select('*').maybeSingle(),
  ]);
  $('#loading').hidden = true;
  if (p.error) { toast('Could not load the collection. Please refresh.', true); return; }
  state.products = p.data;
  state.byId = new Map(p.data.map((x) => [x.id, x]));
  state.settings = s.data || {};
  paintChrome();
  paintCats();
  paintNew();
  paintAll();
  paintBagCount();
  const hero = $('#hero-img');
  if (state.settings.image_base) {
    hero.src = state.settings.image_base.replace(/\/?$/, '/') + 'hero.jpg';
    hero.onload = () => hero.classList.add('ok');
    hero.onerror = () => hero.remove();
  }
}

function paintChrome() {
  const s = state.settings;
  if (s.shop_name) { document.title = `${s.shop_name} — Imitation Jewellery`; $('#ftr-name').textContent = s.shop_name; }
  $('#ftr-tag').textContent = s.tagline || 'Adornment for the everyday.';
  $('#ftr-addr').textContent = s.address || '';
  if (s.phone) { const a = $('#ftr-phone'); a.textContent = s.phone; a.href = 'tel:' + s.phone.replace(/\s/g, ''); }
  if (s.whatsapp) { const a = $('#ftr-wa'); a.hidden = false; a.href = waLink(''); }
  if (s.instagram) { const a = $('#ftr-ig'); a.hidden = false; a.href = 'https://instagram.com/' + s.instagram.replace(/^@/, ''); }
}

function waLink(text) {
  const n = (state.settings.whatsapp || '').replace(/\D/g, '');
  const full = n.length === 10 ? '91' + n : n;
  return `https://wa.me/${full}` + (text ? '?text=' + encodeURIComponent(text) : '');
}

// ---------------------------------------------------------------- catalogue
function paintCats() {
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort();
  $('#cats').innerHTML = ['', ...cats].map((c) =>
    `<button class="chip ${c === state.cat ? 'on' : ''}" data-cat="${esc(c)}">${c ? esc(c) : 'All'}</button>`).join('');
}

function visible() {
  let list = state.products;
  if (state.cat) list = list.filter((p) => p.category === state.cat);
  if (state.q) {
    const q = state.q.toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q));
  }
  const by = {
    new: (a, b) => b.id - a.id,
    lo: (a, b) => a.price - b.price,
    hi: (a, b) => b.price - a.price,
    az: (a, b) => a.name.localeCompare(b.name),
  }[state.sort];
  return [...list].sort(by);
}

function card(p, isNew = false) {
  return `
  <article class="card">
    <div class="card-img">
      <div class="card-fig" data-open="${p.id}" role="button" tabindex="0" aria-label="${esc(p.name)}">
        ${figure(p)}
        ${!p.in_stock ? '<span class="tag out">Sold out</span>' : isNew ? '<span class="tag">New</span>' : ''}
      </div>
      <button class="add" data-add="${p.id}" ${p.in_stock ? '' : 'disabled'}>${p.in_stock ? 'Add to bag' : 'Sold out'}</button>
    </div>
    <div class="card-t" data-open="${p.id}">
      <span class="card-cat">${esc(p.category || 'Jewellery')}</span>
      <span class="card-nm">${esc(p.name)}</span>
      <span class="card-pr">${money(p.price)}</span>
    </div>
  </article>`;
}

function paintNew() {
  const list = state.products.filter((p) => p.in_stock).slice(0, 8);
  $('#grid-new').innerHTML = list.map((p) => card(p, true)).join('');
  $('#new').hidden = list.length === 0;
}

function paintAll() {
  const list = visible();
  $('#grid-all').innerHTML = list.map((p) => card(p)).join('');
  $('#empty').hidden = list.length > 0 || state.products.length === 0;
  $('#cat-title').textContent = state.cat || 'Everything';
}

// ---------------------------------------------------------------- drawers
function openDrawer(id) {
  $('#scrim').hidden = false;
  $$('.drawer').forEach((d) => { const on = d.id === id; d.classList.toggle('open', on); d.setAttribute('aria-hidden', String(!on)); });
  document.body.style.overflow = 'hidden';
}
function closeDrawers() {
  $('#scrim').hidden = true;
  $$('.drawer').forEach((d) => { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); });
  document.body.style.overflow = '';
}

function openProduct(id) {
  const p = state.byId.get(id);
  if (!p) return;
  $('#dr-product-body').innerHTML = `
    ${figure(p, 'dr-fig')}
    <p class="dr-cat">${esc(p.category || 'Jewellery')}</p>
    <h3>${esc(p.name)}</h3>
    <p class="dr-price">${money(p.price)}</p>
    <p class="dr-meta"><b>Imitation jewellery</b> — no gold or silver content, which is why it is priced the way it is and why you can wear it daily. Keep it dry and store it in the pouch it arrives in.</p>
    ${p.in_stock ? `
      <div class="dr-row">
        <span class="qty"><button data-q="-1" aria-label="Fewer">&minus;</button><output id="dq">1</output><button data-q="1" aria-label="More">+</button></span>
        <button class="btn btn-fill" style="flex:1" data-add-dr="${p.id}">Add to bag</button>
      </div>` : `<p class="dr-meta" style="color:var(--ruby)">Sold out for now. Message us on WhatsApp and we will tell you when it is back.</p>`}
    ${state.settings.whatsapp ? `<a class="btn btn-line btn-wide" target="_blank" rel="noopener"
        href="${waLink(`Hi, I'm interested in "${p.name}" (${p.barcode}) on ${state.settings.shop_name || 'your website'}.`)}">Ask on WhatsApp</a>` : ''}`;
  openDrawer('dr-product');
}

// ---------------------------------------------------------------- bag
const cartLines = () => state.cart
  .map((l) => ({ ...l, p: state.byId.get(l.id) }))
  .filter((l) => l.p);

function addToCart(id, qty = 1) {
  const p = state.byId.get(id);
  if (!p || !p.in_stock) return;
  const line = state.cart.find((l) => l.id === id);
  if (line) line.qty = Math.min(20, line.qty + qty); else state.cart.push({ id, qty: Math.min(20, qty) });
  save('sf.cart', state.cart);
  paintBagCount();
  toast(`${p.name} added to your bag`);
}
function setQty(id, qty) {
  state.cart = state.cart.map((l) => (l.id === id ? { ...l, qty } : l)).filter((l) => l.qty > 0);
  save('sf.cart', state.cart);
  paintBagCount(); paintBag();
}
function paintBagCount() {
  const n = state.cart.reduce((s, l) => s + l.qty, 0);
  $('#bag-n').hidden = n === 0; $('#bag-n').textContent = n;
}
function totals() {
  const sub = cartLines().reduce((s, l) => s + l.p.price * l.qty, 0);
  const s = state.settings;
  let ship = +s.ship_flat || 0;
  if (+s.ship_free_above > 0 && sub >= +s.ship_free_above) ship = 0;
  return { sub, ship, total: sub + ship };
}

function paintBag() {
  const lines = cartLines();
  const t = totals();
  const s = state.settings;
  $('#dr-bag-body').innerHTML = lines.length ? `
    <div class="dr-h"><h3>Your bag</h3><span>${lines.length} item${lines.length > 1 ? 's' : ''}</span></div>
    ${lines.map((l) => `
      <div class="line">
        ${figure(l.p)}
        <div>
          <div class="line-nm">${esc(l.p.name)}</div>
          <div class="line-sub">${money(l.p.price)} each</div>
          <span class="qty"><button data-lq="-1" data-id="${l.id}">&minus;</button><output>${l.qty}</output><button data-lq="1" data-id="${l.id}">+</button></span>
        </div>
        <div><div class="line-amt">${money(l.p.price * l.qty)}</div><button class="rm" data-rm="${l.id}">Remove</button></div>
      </div>`).join('')}
    <div class="sum">
      <div><span>Subtotal</span><span>${money(t.sub)}</span></div>
      <div><span>Delivery</span><span>${t.ship ? money(t.ship) : 'Free'}</span></div>
      ${+s.ship_free_above > 0 && t.ship ? `<small>Free delivery on orders over ${money(s.ship_free_above)}</small>` : ''}
      <div class="tot"><span>Total</span><span>${money(t.total)}</span></div>
    </div>
    <button class="btn btn-fill btn-wide" data-checkout>Checkout</button>`
  : `<div class="dr-h"><h3>Your bag</h3></div>
     <p class="empty">Nothing in here yet.</p>
     <button class="btn btn-line btn-wide" data-close>Keep browsing</button>`;
}

function paintCheckout() {
  const t = totals();
  const prev = load('sf.customer', {});
  $('#dr-bag-body').innerHTML = `
    <div class="dr-h"><h3>Delivery details</h3><span>${money(t.total)}</span></div>
    <form class="form" id="co">
      <label>Your name <input name="customer_name" required minlength="2" autocomplete="name" value="${esc(prev.customer_name)}"></label>
      <label>Phone <input name="customer_phone" required inputmode="tel" autocomplete="tel" pattern="[0-9 +\\-]{10,}" placeholder="10-digit mobile" value="${esc(prev.customer_phone)}"></label>
      <label>Address <textarea name="address" required minlength="10" rows="3" autocomplete="street-address" placeholder="House, street, landmark">${esc(prev.address)}</textarea></label>
      <div class="two">
        <label>City <input name="city" autocomplete="address-level2" value="${esc(prev.city)}"></label>
        <label>PIN code <input name="pincode" inputmode="numeric" autocomplete="postal-code" maxlength="6" value="${esc(prev.pincode)}"></label>
      </div>
      <label>Email <span style="text-transform:none;letter-spacing:0">(optional)</span> <input name="customer_email" type="email" autocomplete="email" value="${esc(prev.customer_email)}"></label>
      <label>Note for us <span style="text-transform:none;letter-spacing:0">(optional)</span> <input name="note" placeholder="Gift wrap, call before delivery…"></label>
      <div class="pay">
        <label><input type="radio" name="payment_mode" value="cod" checked><span>Cash on delivery<small>Pay when it arrives</small></span></label>
        <label><input type="radio" name="payment_mode" value="razorpay" disabled><span>Pay online<small>UPI, cards — coming soon</small></span></label>
      </div>
      <p class="form-err" id="co-err"></p>
      <button class="btn btn-fill btn-wide" type="submit" id="co-btn">Place order · ${money(t.total)}</button>
      <button class="btn btn-line btn-wide" type="button" data-back>Back to bag</button>
    </form>`;
}

async function placeOrder(form) {
  const btn = $('#co-btn'); const err = $('#co-err');
  btn.disabled = true; err.textContent = '';
  const f = Object.fromEntries(new FormData(form));
  save('sf.customer', { ...f, note: undefined });
  const payload = { ...f, items: state.cart.map((l) => ({ product_id: l.id, qty: l.qty })) };
  const { data, error } = await sb.rpc('place_order', { p: payload });
  btn.disabled = false;
  if (error) { err.textContent = error.message.replace(/^.*?: /, ''); return; }

  state.cart = []; save('sf.cart', []); paintBagCount();
  const s = state.settings;
  const msg = `Hi, I just placed order ${data.order_no} on ${s.shop_name || 'your website'} (${money(data.total)}).`;
  $('#dr-bag-body').innerHTML = `
    <div class="done">
      <svg class="brand-mark"><use href="#mark"/></svg>
      <h3>Thank you, ${esc(f.customer_name.split(' ')[0])}.</h3>
      <p>Your order is with us. Keep this number — we will call ${esc(f.customer_phone)} to confirm before it ships.</p>
      <div class="no">${esc(data.order_no)}</div>
      <p>${money(data.subtotal)} + ${data.shipping ? money(data.shipping) + ' delivery' : 'free delivery'} = <b>${money(data.total)}</b>, ${f.payment_mode === 'cod' ? 'cash on delivery' : 'paid online'}.</p>
      ${s.whatsapp ? `<a class="btn btn-fill btn-wide" target="_blank" rel="noopener" href="${waLink(msg)}">Send us a WhatsApp</a>` : ''}
      <button class="btn btn-line btn-wide" data-close>Done</button>
    </div>`;
}

// ---------------------------------------------------------------- wiring
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-cat],[data-open],[data-add],[data-add-dr],[data-q],[data-lq],[data-rm],[data-checkout],[data-back],[data-close],#bag-btn,#scrim');
  if (!t) return;

  if (t.dataset.cat !== undefined) { state.cat = t.dataset.cat; paintCats(); paintAll(); return; }
  if (t.dataset.add) { e.stopPropagation(); addToCart(+t.dataset.add); return; }
  if (t.dataset.open) { openProduct(+t.dataset.open); return; }
  if (t.dataset.q) { const o = $('#dq'); o.value = Math.max(1, Math.min(20, +o.value + +t.dataset.q)); return; }
  if (t.dataset.addDr) { addToCart(+t.dataset.addDr, +$('#dq').value); closeDrawers(); return; }
  if (t.dataset.lq) { const id = +t.dataset.id; const l = state.cart.find((x) => x.id === id); setQty(id, Math.min(20, l.qty + +t.dataset.lq)); return; }
  if (t.dataset.rm) { setQty(+t.dataset.rm, 0); return; }
  if (t.hasAttribute('data-checkout')) { paintCheckout(); $('#co').addEventListener('submit', (ev) => { ev.preventDefault(); placeOrder(ev.target); }); return; }
  if (t.hasAttribute('data-back')) { paintBag(); return; }
  if (t.id === 'bag-btn') { paintBag(); openDrawer('dr-bag'); return; }
  if (t.hasAttribute('data-close') || t.id === 'scrim') { closeDrawers(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeDrawers();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open][role="button"]')) {
    e.preventDefault(); openProduct(+e.target.dataset.open);
  }
});
$('#q').addEventListener('input', (e) => { state.q = e.target.value.trim(); paintAll(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; paintAll(); });

boot();
