import { sb, store, money, cur, loadProducts, searchProducts, nextBarcode, activeProducts } from './db.js';
import { $, $$, esc, toast, modal, closeModal, printHTML } from './ui.js';

let lowOnly = false;

// ------------------------------------------------------------------ JsBarcode
let jsbLoaded;
const loadJsBarcode = () => (jsbLoaded ||= new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
  s.onload = res;
  s.onerror = () => rej(new Error('Could not load the barcode library — you need internet the first time.'));
  document.head.append(s);
}));

const drawBarcodes = (root, opts = {}) =>
  $$('svg[data-code]', root).forEach((el) => {
    try {
      window.JsBarcode(el, el.dataset.code, {
        format: 'CODE128', displayValue: true, margin: 0,
        width: 1.6, height: 34, fontSize: 11, textMargin: 1, ...opts,
      });
    } catch { /* skip a bad code rather than kill the whole sheet */ }
  });

// ------------------------------------------------------------------ list
function visible() {
  const list = searchProducts($('#it-search').value, 1000);
  return lowOnly ? list.filter((p) => +p.stock <= (+p.low_stock || 0)) : list;
}

function render() {
  const list = visible();
  $('#it-count').textContent = `${list.length} of ${activeProducts().length} items`;
  $('#it-list').innerHTML = list.length ? list.map((p) => `
    <div class="row ${+p.stock <= (+p.low_stock || 0) ? 'low' : ''}" data-id="${p.id}">
      <span class="nm">${esc(p.name)}
        <span class="sub">${esc(p.barcode)}${p.category ? ' · ' + esc(p.category) : ''}</span>
      </span>
      <span class="r"><b>${money(p.price)}</b><span class="sub">stock ${+p.stock}</span></span>
    </div>`).join('')
    : '<p class="muted pad">No items. Tap <b>+ Item</b> to add your first one.</p>';
}

// ------------------------------------------------------------------ add / edit
function form(p, preset) {
  const v = (k, d = '') => esc(p?.[k] ?? d);
  return `<h3>${p ? 'Edit item' : 'New item'}</h3>
    <label>Name <input id="f-name" value="${v('name')}" required></label>
    <div class="grid2">
      <label>Category <input id="f-category" value="${v('category')}" list="cats"></label>
      <label>Barcode <input id="f-barcode" value="${v('barcode', preset || nextBarcode())}" inputmode="numeric"></label>
    </div>
    <div class="grid2">
      <label>Selling price ${cur()} <input id="f-price" type="number" min="0" step="1" value="${v('price', 0)}" inputmode="decimal"></label>
      <label>Cost price ${cur()} <input id="f-cost" type="number" min="0" step="1" value="${v('cost', 0)}" inputmode="decimal"></label>
    </div>
    <div class="grid2">
      <label>${p ? 'Stock (use Adjust below)' : 'Opening stock'}
        <input id="f-stock" type="number" step="1" value="${v('stock', 0)}" ${p ? 'disabled' : ''} inputmode="decimal"></label>
      <label>Alert when stock &le; <input id="f-low_stock" type="number" min="0" step="1"
        value="${v('low_stock', store.settings.lowStock)}" inputmode="decimal"></label>
    </div>
    <datalist id="cats">${[...new Set(store.products.map((x) => x.category).filter(Boolean))]
      .map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    ${p ? `<div class="bar">
      <input id="f-adj" type="number" step="1" placeholder="+5 or -2" inputmode="decimal">
      <input id="f-adjnote" placeholder="Reason (new stock, damaged...)">
      <button class="ghost" data-a="adjust">Adjust stock</button>
    </div>` : ''}
    <p class="err" id="f-err"></p>
    <div class="modal-actions">
      <button class="ghost" data-a="cancel">Cancel</button>
      ${p ? '<button class="ghost" data-a="labels">Labels</button>' : ''}
      ${p ? '<button class="ghost" data-a="delete" style="color:var(--bad)">Delete</button>' : ''}
      <button class="primary" data-a="save">Save</button>
    </div>`;
}

function readForm() {
  const g = (k) => $('#f-' + k).value;
  return {
    name: g('name').trim(),
    category: g('category').trim() || null,
    barcode: g('barcode').trim(),
    price: +g('price') || 0,
    cost: +g('cost') || 0,
    low_stock: +g('low_stock') || 0,
  };
}

function openItem(p, preset) {
  modal(form(p, preset));
  $('#modal-body').onclick = async (e) => {
    const a = e.target.dataset.a;
    if (!a) return;
    const err = (m) => ($('#f-err').textContent = m);

    if (a === 'cancel') return closeModal();

    if (a === 'labels') { closeModal(); return openLabels([p]); }

    if (a === 'delete') {
      if (!confirm(`Remove "${p.name}"? Past bills keep it.`)) return;
      const { error } = await sb.from('products').update({ active: false }).eq('id', p.id);
      if (error) return err(error.message);
      closeModal(); await loadProducts(); render(); toast('Item removed');
      return;
    }

    if (a === 'adjust') {
      const delta = +$('#f-adj').value;
      if (!delta) return err('Enter how many to add (+) or remove (-)');
      const { error } = await sb.rpc('adjust_stock', {
        p_product_id: p.id, p_delta: delta,
        p_reason: $('#f-adjnote').value.trim() || 'adjust',
        p_actor: store.user?.email?.split('@')[0] || null,
      });
      if (error) return err(error.message);
      closeModal(); await loadProducts(); render();
      toast(`Stock ${delta > 0 ? '+' : ''}${delta}`);
      return;
    }

    if (a === 'save') {
      const f = readForm();
      if (!f.name) return err('Name is required');
      if (!f.barcode) return err('Barcode is required');
      const clash = store.byBarcode.get(f.barcode);
      if (clash && clash.id !== p?.id) return err(`Barcode already used by "${clash.name}"`);

      if (p) {
        const { error } = await sb.from('products').update(f).eq('id', p.id);
        if (error) return err(error.message);
      } else {
        const stock = +$('#f-stock').value || 0;
        const { data, error } = await sb.from('products').insert({ ...f, stock }).select().single();
        if (error) return err(error.message);
        if (stock) await sb.from('stock_log').insert({
          product_id: data.id, delta: stock, reason: 'new',
          actor: store.user?.email?.split('@')[0] || null,
        });
      }
      closeModal(); await loadProducts(); render(); toast('Saved');
    }
  };
}

// ------------------------------------------------------------------ label sheet
function openLabels(list) {
  if (!list.length) return toast('Nothing to print', true);
  modal(`<h3>Print barcode labels</h3>
    <p class="muted small">How many stickers per item. Defaults to the stock count.</p>
    <div class="list" style="max-height:46vh;overflow:auto">
      ${list.map((p) => `<div class="row">
        <span class="nm">${esc(p.name)}<span class="sub">${esc(p.barcode)} · ${money(p.price)}</span></span>
        <input type="number" min="0" max="200" step="1" style="width:80px"
               data-lbl="${p.id}" value="${Math.max(1, Math.min(200, Math.round(+p.stock) || 1))}">
      </div>`).join('')}
    </div>
    <label class="chk"><input type="checkbox" id="lbl-price" checked> Print the price on the sticker</label>
    <div class="modal-actions">
      <button class="ghost" data-a="cancel">Cancel</button>
      <button class="primary" data-a="print">Print</button>
    </div>`);

  $('#modal-body').onclick = async (e) => {
    const a = e.target.dataset.a;
    if (a === 'cancel') return closeModal();
    if (a !== 'print') return;

    const showPrice = $('#lbl-price').checked;
    const cells = [];
    for (const inp of $$('[data-lbl]')) {
      const p = store.byId.get(+inp.dataset.lbl);
      const n = Math.max(0, Math.min(200, +inp.value || 0));
      for (let i = 0; i < n; i++) {
        cells.push(`<div class="label">
          <div class="ln">${esc(p.name)}</div>
          <svg data-code="${esc(p.barcode)}"></svg>
          ${showPrice ? `<div class="lp">${money(p.price)}</div>` : ''}
        </div>`);
      }
    }
    if (!cells.length) return toast('All quantities are zero', true);
    if (cells.length > 400) return toast('Too many labels at once — max 400', true);

    try { await loadJsBarcode(); } catch (err) { return toast(err.message, true); }
    closeModal();
    printHTML(`<div class="labels">${cells.join('')}</div>`, drawBarcodes);
  };
}

// ------------------------------------------------------------------ wiring
export function init() {
  $('#it-search').addEventListener('input', render);
  $('#it-lowonly').addEventListener('change', (e) => { lowOnly = e.target.checked; render(); });
  $('#btn-new-item').onclick = () => openItem(null);
  $('#btn-labels').onclick = () => openLabels(visible());
  $('#it-list').onclick = (e) => {
    const row = e.target.closest('.row[data-id]');
    if (row) openItem(store.byId.get(+row.dataset.id));
  };

  // scanning an unknown code on the Items tab jumps straight to "new item"
  $('#it-search').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = $('#it-search').value.trim();
    if (!code) return;
    const hit = store.byBarcode.get(code);
    if (hit) return openItem(hit);
    if (/^\d{4,}$/.test(code) && confirm(`No item has barcode ${code}. Add it now?`)) openItem(null, code);
  });
}

export async function show() {
  await loadProducts();
  render();
}
