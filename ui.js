// DOM + overlay helpers. Imported by every screen; imports nothing of ours,
// so there is no module cycle.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg, bad = false) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (bad) d.className = 'bad';
  $('#toast').append(d);
  setTimeout(() => d.remove(), bad ? 4500 : 2200);
}

export function modal(html) {
  const dlg = $('#modal');
  $('#modal-body').innerHTML = html;
  dlg.showModal();
  return dlg;
}
export const closeModal = () => $('#modal').close();

/** Renders html into the hidden print area and fires the browser print dialog. */
export async function printHTML(html, after) {
  const area = $('#print-area');
  area.innerHTML = html;
  if (after) await after(area);         // e.g. draw the barcode SVGs
  const done = () => { area.innerHTML = ''; removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => print(), 80);
}

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const csv = (rows) => rows
  .map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
  .join('\r\n');

// ------------------------------------------------------------------ camera scan
let detector;
async function getDetector() {
  if (detector !== undefined) return detector;
  try {
    if (!('BarcodeDetector' in window)) {
      const m = await import('https://cdn.jsdelivr.net/npm/barcode-detector@2/dist/es/pure.min.js');
      window.BarcodeDetector = m.BarcodeDetector;
    }
    const formats = ['code_128', 'ean_13', 'ean_8', 'code_39', 'upc_a', 'upc_e', 'itf', 'qr_code'];
    try { detector = new window.BarcodeDetector({ formats }); }
    catch { detector = new window.BarcodeDetector(); }
  } catch { detector = null; }
  return detector;
}

/** Opens the camera; resolves with the first barcode seen, or null if cancelled. */
export async function scanBarcode() {
  const det = await getDetector();
  if (!det) {
    toast('This browser cannot scan with the camera. Use a USB scanner or type the code.', true);
    return null;
  }
  const dlg = $('#scanner'), video = $('#scan-video');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
    });
  } catch {
    toast('Camera blocked. Allow camera access for this site.', true);
    return null;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  dlg.showModal();

  return new Promise((resolve) => {
    let stopped = false;
    const finish = (code) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      if (dlg.open) dlg.close();
      resolve(code);
    };
    const timer = setInterval(async () => {
      try {
        const hits = await det.detect(video);
        if (hits.length) { navigator.vibrate?.(60); finish(hits[0].rawValue); }
      } catch { /* frame not ready yet */ }
    }, 180);
    $('#scan-close').onclick = () => finish(null);
    dlg.addEventListener('close', () => finish(null), { once: true });
  });
}
