# Silpa's Fashion — the storefront

A static website that sells what the POS stocks. Same database, no server of its
own, works on any basic web hosting (cPanel, shared hosting, a subdomain).

## Put it online

1. In your hosting panel, open **File Manager** (or connect over FTP).
2. Go to the folder your subdomain points at — usually `public_html/shop` or
   `shop.yourdomain.in/`.
3. Upload everything in this `shop/` folder: `index.html`, `shop.css`, `shop.js`,
   `config.js`, `mark.svg`.
4. Open the subdomain. Products appear the moment the database has any marked
   *Show on the website*.

It needs **HTTPS**. Most hosts give you a free Let's Encrypt certificate under
*SSL/TLS* — turn it on for the subdomain. Without it, browsers block the request
to the database.

To update later, upload the changed file again. There is no build step.

## Photos

Make a folder on the same hosting, for example `img/`, and set its full URL in
the POS under **Setup → Online shop → Image folder URL**:

```
https://shop.yourdomain.in/img/
```

Then name each photo after the item's **barcode** and upload it there:

```
img/100001.jpg      <- the item whose barcode is 100001
img/100002.jpg
img/hero.jpg        <- the big picture at the top of the site (optional)
```

That is the whole system. No URLs to paste per item, nothing to type in the POS.
If a photo is missing the site shows a tasteful placeholder instead of a broken
image, so upload as you go.

- **Size**: 1000 × 1250 px (4:5 portrait) is ideal. Square works too.
- **Weight**: under 300 KB each. Any phone can do this — use *Squoosh* or the
  "resize" option in your gallery app.
- **Background**: the frames are arched; a plain light or dark background looks
  best. Shoot on a cloth, not a busy table.
- **Hero**: `hero.jpg` — one strong lifestyle shot, 1200 × 1500 px.

If one item needs a photo from somewhere else entirely, paste a full URL into
its *Image URL* field in the POS; that wins over the folder rule.

## What the POS controls

Everything on the site comes from the POS — there is nothing to edit here:

| On the site | Set in the POS |
|---|---|
| Which items appear | Items → each item → *Show on the website* (on by default). Out-of-stock items show as *Sold out*. |
| Prices, names, categories | Items |
| Shop name, address, phone, WhatsApp, Instagram, tagline | Setup |
| Delivery charge, free-delivery threshold | Setup → Online shop |
| Photos | the `img/` folder, named by barcode |

## Orders

A customer checks out → the order appears in **POS → Orders** within 30 seconds,
with a badge on the tab. From there:

1. **Confirm** — call the customer (their number is one tap away), then confirm.
   This is the moment stock leaves the shelf.
2. **Packed → Shipped → Delivered.** Print a packing slip from the same screen.
3. **Cancel** — owner only. If the order was already confirmed, stock goes back.

Payment is cash-on-delivery for now. Razorpay slots into `payment_mode` /
`payment_ref` / `payment_status` on the order — those columns are already there.

## What the browser can and cannot do

The site talks to the database with the public key. That key can:

- read `shop_products` — id, name, category, price, in-stock flag, image. **Never cost price.**
- read `shop_settings` — the handful of fields listed above. **Never the UPI id or GSTIN.**
- call `place_order()` — which recomputes every price from the database, ignores
  whatever the browser claims, and refuses more than 3 orders from one phone number
  in 10 minutes.

It cannot read orders, sales, stock levels, the cash book, or anything else.
