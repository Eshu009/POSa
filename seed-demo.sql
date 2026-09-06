-- Demo stock for trying the shop and the POS. Paste into Supabase -> SQL Editor -> Run.
-- Safe to re-run: existing barcodes are skipped.
-- To remove later:  delete from products where barcode between '100001' and '100012';

with new_items as (
  insert into products (barcode, name, category, price, cost, stock, low_stock)
  values
    ('100001', 'Oxidised Peacock Jhumka',            'Earrings',  349,  160, 12, 3),
    ('100002', 'Kundan Bridal Choker Set',           'Necklaces', 1499, 720,  3, 3),
    ('100003', 'Antique Temple Maang Tikka',         'Head',      499,  230,  6, 3),
    ('100004', 'Silk Thread Bangles, pair',          'Bangles',   249,   90, 24, 5),
    ('100005', 'Pearl Drop Studs',                   'Earrings',  199,   80,  0, 3),
    ('100006', 'Meenakari Lotus Pendant Chain',      'Necklaces', 699,  320,  8, 3),
    ('100007', 'German Silver Anklets, pair',        'Anklets',   399,  170, 10, 3),
    ('100008', 'AD Stone Tennis Bracelet',           'Bangles',   549,  260,  5, 3),
    ('100009', 'Oxidised Coin Necklace',             'Necklaces', 899,  410,  2, 3),
    ('100010', 'Chandbali Earrings, Ruby',           'Earrings',  459,  210,  7, 3),
    ('100011', 'Gold-plated Chain Necklace, 18 in',  'Necklaces', 1000, 600, 10, 3),
    ('100012', 'Matte Finish Hair Pin Set',          'Head',      149,   55, 30, 5)
  on conflict (barcode) do nothing
  returning id, stock
)
insert into stock_log (product_id, delta, reason, actor)
select id, stock, 'new', 'seed' from new_items where stock > 0;
