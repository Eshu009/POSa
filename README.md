# ShopOS — POS for a small jewellery shop

Barcode-based billing, stock tracking and a daily cash book. Installs on a phone
or tablet like an app, keeps working when the wifi drops, and costs nothing to run.

No build step, no npm, no server of your own. It is plain HTML/JS files plus a
free Supabase database.

---

## Setup — about 20 minutes, once

### 1. Create the database (free)

1. Go to <https://supabase.com>, sign up, **New project**.
2. Pick a name and a strong database password. Choose the region closest to your shop.
3. Wait ~2 minutes for it to finish provisioning.

### 2. Create the tables

1. In the project, open **SQL Editor** → **New query**.
2. Open `schema.sql` from this folder, copy the whole file, paste it in, press **Run**.
3. It should say *Success*. Safe to run again if you ever need to.

### 3. Point the app at your database

1. In Supabase go to **Project Settings → API** (or **Data API**).
2. Copy the **Project URL** and the **anon / public** key (newer projects call it the *publishable* key, `sb_publishable_…` — either works).
3. Open `config.js` and paste them in:

```js
export const CONFIG = {
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi....',
};
```

The anon key is *meant* to be public. The `schema.sql` you ran turns on Row Level
Security, so nothing in the database can be read or written without signing in.

### 4. Create logins for your staff

Supabase → **Authentication → Users → Add user**. Create one for yourself and one
for each employee (email + password, tick *Auto Confirm User*). Two or three is fine.

There is no sign-up screen in the app on purpose — but Supabase allows public
sign-up by default, so **turn it off**: **Authentication → Sign In / Providers →
Email** → switch off *Allow new users to sign up*.

Without that, anyone who finds your site address can register an account and read
and write your stock and sales. Do this before you put the site online.

### 5. Put it online (free)

Any static host works. Easiest, no account, no git:

- Go to <https://app.netlify.com/drop> and drag the whole `shopos` folder onto the page.
- You get an HTTPS address like `https://shiny-name-1234.netlify.app`.

HTTPS matters: the camera scanner and the "install as app" feature only work on HTTPS.

Alternatives, all free: Cloudflare Pages, GitHub Pages, Vercel.

To publish a change later, drag the folder onto Netlify Drop again (use the same
site from your Netlify dashboard so the address stays the same).

### 6. Install it on the counter device

Open the address in **Chrome** on the phone/tablet → menu **⋮** → **Add to Home screen**
(or **Install app**). You get an icon, full screen, no browser bars. On a Windows
counter PC, use Chrome or Edge → address-bar **Install** icon.

### 7. Fill in your shop details

Open the app, sign in, go to **Setup**:

- Shop name, address, phone — these print on the bill.
- **UPI ID** — turns on the pay-by-QR screen. Leave blank to skip it.
- **Tax %** — set 0 if you are not GST registered. If you are, imitation jewellery
  is normally 3%; leave *Prices already include tax* ticked if your labelled price
  is the final price the customer pays.
- **Receipt width** — 58 mm for the common small thermal printer, A5 for a normal printer.

---

## Daily use

### Adding stock

**Items → + Item.** A barcode number is generated for you. Fill in name, price and
how many pieces you have.

To restock an existing item, open it and use **Adjust stock** (`+12`, reason
"new lot from supplier"). Every change is logged with who did it, so you can see
later where pieces went.

### Printing barcode labels

**Items → Print labels.** It lists your items with a sticker count already filled
in from the stock number. Adjust, tick whether to print the price, press **Print**.

Print onto A4 sticker sheets — 3 labels per row. For jewellery, a hang tag or a
"butterfly" label wrapped around the earring post works better than sticking
directly onto the piece.

One barcode is **per design, not per piece**. Ten identical jhumkas share barcode
100001; you print ten identical stickers.

### Selling

Three ways to put an item in the cart, all on the **Sell** screen:

1. **A USB or bluetooth barcode scanner** — plug it in and scan. It behaves like a
   keyboard, types the code and presses Enter. This is by far the fastest and the
   most reliable. A basic 1D laser scanner costs about ₹1,000–1,500 and is the one
   upgrade actually worth buying.
2. **The 📷 button** — uses the phone camera. Works, but slower, and struggles with
   small or curved labels.
3. **Type part of the name** and tap the item. Use this when a label is damaged.

Then: adjust quantity, set a discount (tap the **₹** button to switch to %),
override a rate if you bargained, pick Cash / UPI / Card / Split, press **Charge**.
The bill prints and stock is deducted.

If you picked UPI and set a UPI ID, a QR appears first — the customer scans it with
any UPI app, you confirm once the money lands.

### Cash book

**Reports** shows the day: bills, gross, discount, net, cash vs online, pieces sold.

Below it, the cash book:

- Morning: add an **Opening cash** entry for the float in the drawer.
- During the day: add **Expense / cash out** for tea, auto, courier, anything taken out.
- Closing: count the drawer, add a **Closing count** entry. The app shows
  **Expected in drawer** and whether you are short or in excess.

### Returns

**Reports → Bills → tap the bill → Return.** Stock goes back and the bill is
struck through. Returned bills are excluded from the day's totals.

### Backups

**Reports → Full JSON backup** downloads everything. Do it weekly and keep it in
Google Drive. Supabase keeps its own backups, but yours costs nothing.

---

## When the internet goes down

The app keeps billing. Sales are queued on the device and a badge in the header
shows how many are waiting. They upload by themselves when the connection returns
— a queued bill cannot be charged twice, that is enforced in the database.

While offline you can sell but not add new items, and the offline bill shows a
temporary number until it syncs.

**Do not sign out with bills still queued** — the app warns you. Wait for the badge
to clear.

---

## Turning this into a real .apk later

Not needed for daily use — the installed PWA behaves like an app. If you want a
`.apk` file (to sideload, or to put on the Play Store):

1. Go to <https://www.pwabuilder.com>, paste your site address.
2. Choose **Android → Generate**. Download the package.

Free. The code stays exactly the same.

---

## The online shop, later

The website reads from the same `products` table this POS writes to, so stock stays
in one place. It needs one extra piece: a policy that lets the public *read* products
(not write), plus an orders table. Nothing in the current schema blocks that.

---

## Files

| File | What it is |
|---|---|
| `schema.sql` | Run once in Supabase. Tables, the bill transaction, security rules. |
| `config.js` | Your Supabase URL and publishable key. The only file you edit. |
| `index.html` | All four screens. |
| `app.js` | Login, tabs, settings, offline sync. |
| `ui.js` | Shared helpers: dialogs, printing, camera scanning. |
| `db.js` | Supabase queries, product cache, the offline bill queue. |
| `money.js` | Bill arithmetic. Pure functions, no DOM. |
| `sell.js` | Cart, checkout, receipt. |
| `items.js` | Stock, barcodes, label sheet. |
| `reports.js` | Day summary, cash book, exports. |
| `sw.js` | Makes it work offline. |
| `test.mjs` | `node test.mjs` — checks the bill maths. |

---

## Notes

- **Cost.** Supabase free tier is 500 MB of database — that is decades of bills for
  a shop this size. Netlify's free tier is far more traffic than you will use.
  A free Supabase project pauses after a week with *zero* activity; a shop that
  bills daily never hits this. If you close for a long holiday, just open the app
  once, or un-pause it from the dashboard.
- **Prices are editable at the counter** on purpose — bargaining is normal. The
  original price stays on the item; only that bill changes.
- **Selling below zero stock is allowed** (you get a warning). Better a bill that
  goes through than a customer waiting while you fix a count.
