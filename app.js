import { sb, store, configured, loadSettings, saveSettings, loadProducts, loadRole, isOwner,
         loadStaff, setStaffRole, flushOutbox, outbox, DEFAULT_SETTINGS } from './db.js';
import * as sell from './sell.js';
import * as items from './items.js';
import * as reports from './reports.js';
import * as orders from './orders.js';
import { $, $$, esc, toast } from './ui.js';

// ------------------------------------------------------------------ routing
const SCREENS = { sell, items, orders, reports, settings: { show: fillSettings } };
const OWNER_ONLY = ['reports', 'settings'];

export function go(name) {
  if (OWNER_ONLY.includes(name) && !isOwner()) name = 'sell';
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.scr === name));
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'scr-' + name));
  $('main').scrollTop = 0;
  SCREENS[name]?.show?.();
}

function applyRole() {
  $$('#tabs button').forEach((b) => {
    if (OWNER_ONLY.includes(b.dataset.scr)) b.hidden = !isOwner();
  });
}

// ------------------------------------------------------------------ settings screen
const ST_KEYS = Object.keys(DEFAULT_SETTINGS);
function fillSettings() {
  for (const k of ST_KEYS) {
    const el = $('#st-' + k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!store.settings[k];
    else el.value = store.settings[k] ?? '';
  }
  fillStaff();
}
async function fillStaff() {
  const box = $('#st-staff');
  if (!box) return;
  const rows = await loadStaff();
  box.innerHTML = rows.length ? rows.map((r) => `
    <div class="row">
      <span class="nm">${esc(r.note || r.user_id.slice(0, 8))}
        <span class="sub">${r.user_id === store.user.id ? 'you' : ''}</span>
      </span>
      <select data-uid="${r.user_id}" style="width:auto"
        ${r.user_id === store.user.id ? 'disabled title="You cannot change your own role"' : ''}>
        <option value="owner"    ${r.role === 'owner'    ? 'selected' : ''}>Owner</option>
        <option value="employee" ${r.role === 'employee' ? 'selected' : ''}>Employee</option>
      </select>
    </div>`).join('')
    : '<p class="muted small">Roster is empty — every login is treated as an owner. Run the enrol SQL from the README.</p>';

  box.onchange = async (e) => {
    const sel = e.target.closest('select[data-uid]');
    if (!sel) return;
    try {
      await setStaffRole(sel.dataset.uid, sel.value);
      toast('Role updated');
    } catch (err) {
      toast(err.message, true);
      fillStaff();
    }
  };
}

function wireSettings() {
  $('#st-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of ST_KEYS) {
      const el = $('#st-' + k);
      if (!el) continue;
      patch[k] = el.type === 'checkbox' ? el.checked
               : el.type === 'number' ? (+el.value || 0)
               : el.value.trim();
    }
    try {
      await saveSettings(patch);
      $('#hdr-shop').textContent = store.settings.shopName;
      $('#st-msg').textContent = 'Saved.';
      toast('Settings saved');
    } catch (err) {
      $('#st-msg').textContent = 'Could not save: ' + err.message;
    }
  });
}

// ------------------------------------------------------------------ connection
function paintStatus() {
  $('#hdr-offline').hidden = navigator.onLine;
  const n = outbox.size();
  $('#hdr-queue').hidden = n === 0;
  $('#hdr-queue').textContent = n ? `${n} bill${n > 1 ? 's' : ''} to sync` : '';
}
async function trySync() {
  orders.pollNew();
  const n = await flushOutbox();
  if (n) { toast(`${n} offline bill${n > 1 ? 's' : ''} synced`); if (isOwner()) reports.show?.(); }
  paintStatus();
}

// ------------------------------------------------------------------ boot
async function startApp(user) {
  store.user = user;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#hdr-user').textContent = user.email.split('@')[0];

  await Promise.all([loadSettings(), loadProducts(), loadRole()]);
  $('#hdr-shop').textContent = store.settings.shopName;
  $('#hdr-user').textContent = user.email.split('@')[0] + (isOwner() ? '' : ' · staff');
  document.title = store.settings.shopName + ' · POS';

  applyRole();
  sell.init(); items.init(); orders.init(); reports.init(); wireSettings();
  $$('#tabs button').forEach((b) => (b.onclick = () => go(b.dataset.scr)));
  $('#btn-logout').onclick = async () => {
    if (outbox.size() && !confirm('There are unsynced bills. Sign out anyway?')) return;
    await sb.auth.signOut();
    location.reload();
  };

  go('sell');
  paintStatus();
  trySync();
  addEventListener('online', trySync);
  addEventListener('offline', paintStatus);
  setInterval(trySync, 30000);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-form button');
  btn.disabled = true; $('#li-err').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('#li-email').value.trim(), password: $('#li-pass').value,
  });
  btn.disabled = false;
  if (error) { $('#li-err').textContent = error.message; return; }
  startApp(data.user);
});

(async function boot() {
  if (!configured) {
    $('#li-err').textContent = 'Setup step 3 is missing: open config.js and paste your Supabase URL and anon key.';
    $$('#login-form input, #login-form button').forEach((el) => (el.disabled = true));
    return;
  }
  const { data } = await sb.auth.getSession();
  if (data.session) startApp(data.session.user);
  if ('serviceWorker' in navigator) {          // rejected harmlessly on http
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
