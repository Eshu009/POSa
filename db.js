import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';
import { round2 } from './money.js';

/** False until config.js is filled in; keeps createClient from throwing on boot. */
export const configured = !/PASTE_YOUR/.test(CONFIG.SUPABASE_URL || '');
export const sb = createClient(
  configured ? CONFIG.SUPABASE_URL : 'https://unconfigured.supabase.co',
  configured ? CONFIG.SUPABASE_ANON_KEY : 'unconfigured',
);

// ---------------------------------------------------------------- shared state
export const store = {
  user: null,
  settings: {},
  products: [],
  byBarcode: new Map(),
  byId: new Map(),
};

export const DEFAULT_SETTINGS = {
  shopName: 'My Jewellery Shop',
  address: '',
  phone: '',
  gstin: '',
  upiId: '',
  currency: '₹',
  taxPercent: 0,
  taxIncluded: true,
  lowStock: 3,
  receiptWidth: '58mm',
  footer: 'Thank you! Visit again.',
};

// ---------------------------------------------------------------- little utils
export { round2 };
export const cur = () => store.settings.currency || '₹';
export const money = (n) => cur() + (Math.round((+n || 0) * 100) / 100).toFixed(2);

/** Local calendar day (not UTC) — the shop's day is what matters for reports. */
export const today = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Start/end ISO timestamps of a local calendar day, for range queries. */
export function dayRange(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  return [new Date(y, m - 1, d).toISOString(), new Date(y, m - 1, d + 1).toISOString()];
}

export const fmtTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const LS = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } },
};

// ---------------------------------------------------------------- settings
export async function loadSettings() {
  const cached = LS.get('shopos.settings', null);
  store.settings = { ...DEFAULT_SETTINGS, ...(cached || {}) };
  const { data, error } = await sb.from('settings').select('data').eq('id', 1).single();
  if (!error && data) {
    store.settings = { ...DEFAULT_SETTINGS, ...data.data };
    LS.set('shopos.settings', store.settings);
  }
  return store.settings;
}

export async function saveSettings(patch) {
  store.settings = { ...store.settings, ...patch };
  LS.set('shopos.settings', store.settings);
  // upsert, not update: an update against a missing row succeeds while saving nothing
  const { error } = await sb.from('settings').upsert({ id: 1, data: store.settings });
  if (error) throw error;
  return store.settings;
}

// ---------------------------------------------------------------- products
function indexProducts() {
  store.byBarcode = new Map(store.products.map((p) => [String(p.barcode), p]));
  store.byId = new Map(store.products.map((p) => [p.id, p]));
}

/** Whole catalogue in memory: a small shop has hundreds of SKUs, so scanning
 *  is instant and the sell screen keeps working if the network hiccups. */
export async function loadProducts() {
  store.products = LS.get('shopos.products', []);
  indexProducts();
  const { data, error } = await sb
    .from('products').select('*').order('name');   // inactive rows too, so barcodes stay unique
  if (!error && data) {
    store.products = data;
    indexProducts();
    LS.set('shopos.products', data);
  }
  return store.products;
}

/** Only sellable items. The map itself keeps deleted ones for uniqueness checks. */
export function findByBarcode(code) {
  const p = store.byBarcode.get(String(code).trim());
  return p && p.active ? p : undefined;
}

export const activeProducts = () => store.products.filter((p) => p.active);

export function searchProducts(q, limit = 60) {
  q = q.trim().toLowerCase();
  const src = activeProducts();
  if (!q) return src.slice(0, limit);
  return src
    .filter((p) => p.name.toLowerCase().includes(q) ||
                   String(p.barcode).includes(q) ||
                   (p.category || '').toLowerCase().includes(q))
    .slice(0, limit);
}

/** Barcode value = 6 digits. Numeric-only keeps cheap laser scanners happy. */
export function nextBarcode() {
  const used = new Set(store.products.map((p) => String(p.barcode)));
  let n = 100000 + store.products.length;
  while (used.has(String(n))) n++;
  return String(n);
}

// ---------------------------------------------------------------- offline outbox
// A bill must never be lost because the wifi blinked. Failed sales are queued
// locally and replayed; create_sale() dedupes on local_ref so no double billing.
const OUTBOX = 'shopos.outbox';
export const outbox = {
  all: () => LS.get(OUTBOX, []),
  size: () => outbox.all().length,
  push(payload) { const q = outbox.all(); q.push(payload); LS.set(OUTBOX, q); },
  remove(ref) { LS.set(OUTBOX, outbox.all().filter((p) => p.local_ref !== ref)); },
};

export async function flushOutbox() {
  if (!navigator.onLine) return 0;
  let sent = 0;
  for (const payload of outbox.all()) {
    const { error } = await sb.rpc('create_sale', { p: payload });
    if (error) break;          // still down — try again on the next tick
    outbox.remove(payload.local_ref);
    sent++;
  }
  if (sent) await loadProducts();
  return sent;
}

/** Records the sale. Returns { bill_no, offline }. Never throws on network loss. */
export async function createSale(payload) {
  payload.local_ref ||= `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  payload.created_at ||= new Date().toISOString();

  if (navigator.onLine) {
    const { data, error } = await sb.rpc('create_sale', { p: payload });
    if (!error) {
      // keep the local cache honest without a full refetch
      for (const it of payload.items) {
        const p = store.byId.get(Number(it.product_id));
        if (p) p.stock = round2(p.stock - it.qty);
      }
      LS.set('shopos.products', store.products);
      return { bill_no: data.bill_no, offline: false };
    }
  }
  outbox.push(payload);
  for (const it of payload.items) {
    const p = store.byId.get(Number(it.product_id));
    if (p) p.stock = round2(p.stock - it.qty);
  }
  LS.set('shopos.products', store.products);
  return { bill_no: 'OFFLINE-' + payload.local_ref.slice(-6), offline: true };
}
