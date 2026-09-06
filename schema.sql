-- ShopOS schema. Paste this whole file into Supabase -> SQL Editor -> Run.
-- Safe to re-run.

-- ---------- tables ----------
create table if not exists settings (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  constraint settings_single check (id = 1)
);
insert into settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

create table if not exists products (
  id          bigint generated always as identity primary key,
  barcode     text unique not null,
  name        text not null,
  category    text,
  price       numeric(12,2) not null default 0,
  cost        numeric(12,2) not null default 0,
  stock       numeric(12,2) not null default 0,
  low_stock   numeric(12,2) not null default 3,
  active      boolean not null default true,
  image_url   text,
  created_at  timestamptz not null default now()
);
create index if not exists products_name_idx     on products (name);
create index if not exists products_category_idx on products (category);

create sequence if not exists bill_seq start 1;

create table if not exists sales (
  id             bigint generated always as identity primary key,
  bill_no        text unique not null,
  local_ref      text unique,          -- idempotency key from the offline outbox
  created_at     timestamptz not null default now(),
  subtotal       numeric(12,2) not null,
  discount       numeric(12,2) not null default 0,
  tax            numeric(12,2) not null default 0,
  total          numeric(12,2) not null,
  paid_cash      numeric(12,2) not null default 0,
  paid_online    numeric(12,2) not null default 0,
  payment_mode   text not null,        -- cash | upi | card | split
  customer_name  text,
  customer_phone text,
  note           text,
  status         text not null default 'completed',   -- completed | returned
  cashier        text
);
create index if not exists sales_created_idx on sales (created_at desc);
-- a bill is either rung up at the counter or a delivered online order
alter table sales add column if not exists source   text not null default 'counter';
alter table sales add column if not exists order_id bigint;
create unique index if not exists sales_order_uidx on sales (order_id) where order_id is not null;

create table if not exists sale_items (
  id         bigint generated always as identity primary key,
  sale_id    bigint not null references sales(id) on delete cascade,
  product_id bigint references products(id) on delete set null,
  name       text not null,
  barcode    text,
  qty        numeric(12,2) not null,
  price      numeric(12,2) not null,
  total      numeric(12,2) not null
);
create index if not exists sale_items_sale_idx on sale_items (sale_id);

-- every stock change, so you can see where pieces went
create table if not exists stock_log (
  id         bigint generated always as identity primary key,
  product_id bigint references products(id) on delete cascade,
  delta      numeric(12,2) not null,
  reason     text not null,        -- sale | return | purchase | adjust | new
  ref        text,
  actor      text,
  created_at timestamptz not null default now()
);
create index if not exists stock_log_product_idx on stock_log (product_id, created_at desc);

-- daily cash book (opening float, expenses, manual in/out, day close count)
create table if not exists cash_entries (
  id         bigint generated always as identity primary key,
  day        date not null,
  kind       text not null,        -- opening | in | out | close
  amount     numeric(12,2) not null,
  note       text,
  actor      text,
  created_at timestamptz not null default now()
);
create index if not exists cash_entries_day_idx on cash_entries (day);

-- ---------- who is allowed in ----------
-- A login alone is not enough: the account must also be listed here. Rows are
-- added by you in the SQL editor, never through the API. While the table is
-- empty this falls back to "any logged-in user", so a fresh install works
-- before you have populated it and nobody can lock themselves out.
create table if not exists staff (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  note     text,
  role     text not null default 'owner',
  added_at timestamptz not null default now()
);
alter table staff add column if not exists role text not null default 'owner';
alter table staff drop constraint if exists staff_role_chk;
alter table staff add  constraint staff_role_chk check (role in ('owner', 'employee'));

create or replace function is_staff()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then return false; end if;
  if to_regclass('public.staff') is null then return true; end if;
  if not exists (select 1 from staff) then return true; end if;
  return exists (select 1 from staff where user_id = auth.uid());
end $fn$;

-- Owners get Reports (sales figures, cash book, exports) and Setup. Employees
-- sell and manage stock, and that is all.
create or replace function is_owner()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then return false; end if;
  if to_regclass('public.staff') is null then return true; end if;
  if not exists (select 1 from staff) then return true; end if;
  return exists (select 1 from staff where user_id = auth.uid() and role = 'owner');
end $fn$;

-- ---------- one transaction per bill: sale + lines + stock + log ----------
create or replace function create_sale(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sale sales%rowtype;
  it     jsonb;
  v_bill text;
begin
  if not is_staff() then raise exception 'not authorised' using errcode = '42501'; end if;

  -- replay-safe: an offline bill re-sent after reconnect must not double-charge
  select * into v_sale from sales where local_ref = p->>'local_ref';
  if found then
    return jsonb_build_object('id', v_sale.id, 'bill_no', v_sale.bill_no, 'replay', true);
  end if;

  v_bill := to_char(coalesce((p->>'created_at')::timestamptz, now()), 'YYMMDD')
            || '-' || lpad(nextval('bill_seq')::text, 4, '0');

  insert into sales (bill_no, local_ref, created_at, subtotal, discount, tax, total,
                     paid_cash, paid_online, payment_mode, customer_name, customer_phone, note, cashier)
  values (v_bill, p->>'local_ref',
          coalesce((p->>'created_at')::timestamptz, now()),
          (p->>'subtotal')::numeric,
          coalesce((p->>'discount')::numeric, 0),
          coalesce((p->>'tax')::numeric, 0),
          (p->>'total')::numeric,
          coalesce((p->>'paid_cash')::numeric, 0),
          coalesce((p->>'paid_online')::numeric, 0),
          p->>'payment_mode', p->>'customer_name', p->>'customer_phone', p->>'note', p->>'cashier')
  returning * into v_sale;

  for it in select * from jsonb_array_elements(p->'items') loop
    insert into sale_items (sale_id, product_id, name, barcode, qty, price, total)
    values (v_sale.id, nullif(it->>'product_id','')::bigint, it->>'name', it->>'barcode',
            (it->>'qty')::numeric, (it->>'price')::numeric, (it->>'total')::numeric);

    if nullif(it->>'product_id','') is not null then
      update products set stock = stock - (it->>'qty')::numeric
       where id = (it->>'product_id')::bigint;
      insert into stock_log (product_id, delta, reason, ref, actor)
      values ((it->>'product_id')::bigint, -(it->>'qty')::numeric, 'sale', v_bill, p->>'cashier');
    end if;
  end loop;

  return jsonb_build_object('id', v_sale.id, 'bill_no', v_sale.bill_no, 'replay', false);
end $fn$;

-- ---------- undo a bill: put the stock back, mark it returned ----------
create or replace function return_sale(p_sale_id bigint, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare it sale_items%rowtype; v_bill text;
begin
  if not is_owner() then raise exception 'only an owner can return a bill' using errcode = '42501'; end if;

  select bill_no into v_bill from sales where id = p_sale_id and status = 'completed';
  if v_bill is null then
    return jsonb_build_object('ok', false, 'error', 'not found or already returned');
  end if;

  for it in select * from sale_items where sale_id = p_sale_id loop
    if it.product_id is not null then
      update products set stock = stock + it.qty where id = it.product_id;
      insert into stock_log (product_id, delta, reason, ref, actor)
      values (it.product_id, it.qty, 'return', v_bill, p_actor);
    end if;
  end loop;

  update sales set status = 'returned' where id = p_sale_id;
  return jsonb_build_object('ok', true, 'bill_no', v_bill);
end $fn$;

-- ---------- stock adjust helper (keeps the log honest) ----------
create or replace function adjust_stock(p_product_id bigint, p_delta numeric, p_reason text, p_actor text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not is_staff() then raise exception 'not authorised' using errcode = '42501'; end if;

  update products set stock = stock + p_delta where id = p_product_id;
  insert into stock_log (product_id, delta, reason, actor)
  values (p_product_id, p_delta, coalesce(p_reason, 'adjust'), p_actor);
end $fn$;

-- ---------- security: only logged-in staff, full access (single shop) ----------
alter table settings     enable row level security;
alter table products     enable row level security;
alter table sales        enable row level security;
alter table sale_items   enable row level security;
alter table stock_log    enable row level security;
alter table cash_entries enable row level security;
alter table staff        enable row level security;

-- clear whatever is there, so this file stays safe to re-run
do $do$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public'
              and tablename in ('settings','products','sales','sale_items',
                                'stock_log','cash_entries','staff')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $do$;

-- everyone signed in and on the roster can sell
create policy p_products  on products    for all    to authenticated using (is_staff()) with check (is_staff());
create policy p_set_read  on settings    for select to authenticated using (is_staff());
create policy p_staff_see on staff       for select to authenticated using (is_staff());

-- an employee adds stock, so it must be able to write the audit line...
create policy p_log_write on stock_log   for insert to authenticated with check (is_staff());

-- ...but only an owner reads the money and the history
create policy p_set_write on settings    for update to authenticated using (is_owner()) with check (is_owner());
create policy p_sales     on sales       for select to authenticated using (is_owner());
create policy p_saleitems on sale_items  for select to authenticated using (is_owner());
create policy p_log_read  on stock_log   for select to authenticated using (is_owner());
create policy p_cash      on cash_entries for all   to authenticated using (is_owner()) with check (is_owner());

-- an owner changes roles, but cannot demote themselves and strand the shop
create policy p_staff_set on staff for update to authenticated
  using (is_owner() and user_id <> auth.uid()) with check (is_owner());

revoke all on function is_staff()                                  from public, anon;
revoke all on function is_owner()                                  from public, anon;
grant  execute on function is_staff()                              to authenticated;
grant  execute on function is_owner()                              to authenticated;

revoke all on function create_sale(jsonb)                          from public, anon;
revoke all on function return_sale(bigint, text)                   from public, anon;
revoke all on function adjust_stock(bigint, numeric, text, text)   from public, anon;
grant execute on function create_sale(jsonb)                        to authenticated;
grant execute on function return_sale(bigint, text)                 to authenticated;
grant execute on function adjust_stock(bigint, numeric, text, text) to authenticated;


-- ============================================================================
--  ONLINE SHOP  (Silpa's Fashion storefront)
-- ============================================================================

-- what appears on the website
alter table products add column if not exists online boolean not null default true;
create index if not exists products_online_idx on products (online) where online;

-- Views are how the storefront reads: they run as their owner, so anonymous
-- visitors need no policy on the base tables, and they expose only safe
-- columns — never cost price, never the UPI id, never GSTIN.
drop view if exists shop_products;
create view shop_products as
  select id, barcode, name, category, price, image_url, (stock > 0) as in_stock
    from products
   where active and online;
grant select on shop_products to anon, authenticated;

drop view if exists shop_settings;
create view shop_settings as
  select data->>'shopName'  as shop_name,
         data->>'tagline'   as tagline,
         data->>'phone'     as phone,
         data->>'whatsapp'  as whatsapp,
         data->>'instagram' as instagram,
         data->>'address'   as address,
         data->>'imageBase' as image_base,
         data->>'currency'  as currency,
         coalesce((data->>'shipFlat')::numeric, 0)      as ship_flat,
         coalesce((data->>'shipFreeAbove')::numeric, 0) as ship_free_above
    from settings where id = 1;
grant select on shop_settings to anon, authenticated;

create sequence if not exists order_seq start 1;

create table if not exists orders (
  id             bigint generated always as identity primary key,
  order_no       text unique not null,
  created_at     timestamptz not null default now(),
  customer_name  text not null,
  customer_phone text not null,
  customer_email text,
  address        text not null,
  city           text,
  pincode        text,
  note           text,
  subtotal       numeric(12,2) not null,
  shipping       numeric(12,2) not null default 0,
  total          numeric(12,2) not null,
  payment_mode   text not null default 'cod',      -- cod | razorpay
  payment_ref    text,
  payment_status text not null default 'pending',  -- pending | paid | refunded
  status         text not null default 'new',      -- new|confirmed|packed|shipped|delivered|cancelled
  stock_taken    boolean not null default false,
  handled_by     text,
  updated_at     timestamptz not null default now()
);
create index if not exists orders_status_idx on orders (status, created_at desc);
create index if not exists orders_phone_idx  on orders (customer_phone, created_at desc);

-- sales.order_id is declared above orders, so the link is made here
alter table sales drop constraint if exists sales_order_fk;
alter table sales add  constraint sales_order_fk
  foreign key (order_id) references orders(id) on delete set null;

create table if not exists order_items (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references orders(id) on delete cascade,
  product_id bigint references products(id) on delete set null,
  name       text not null,
  barcode    text,
  qty        numeric(12,2) not null,
  price      numeric(12,2) not null,
  total      numeric(12,2) not null
);
create index if not exists order_items_order_idx on order_items (order_id);

-- ---------- a visitor places an order ----------
-- Runs for anon. Every price and line total is recomputed from products;
-- nothing money-related is trusted from the browser.
create or replace function place_order(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  it      jsonb;
  prod    products%rowtype;
  q       numeric;
  v_no    text;
  v_id    bigint;
  v_sub   numeric := 0;
  v_ship  numeric := 0;
  v_name  text;
  v_phone text;
  v_addr  text;
  v_count int;
  s       jsonb;
begin
  v_name  := btrim(coalesce(p->>'customer_name', ''));
  v_phone := regexp_replace(coalesce(p->>'customer_phone', ''), '[^0-9]', '', 'g');
  v_addr  := btrim(coalesce(p->>'address', ''));

  if length(v_name)  < 2  then raise exception 'Please enter your name'; end if;
  if length(v_phone) < 10 then raise exception 'Please enter a valid 10-digit phone number'; end if;
  if length(v_addr)  < 10 then raise exception 'Please enter your full delivery address'; end if;

  v_count := jsonb_array_length(coalesce(p->'items', '[]'::jsonb));
  if v_count = 0  then raise exception 'Your bag is empty'; end if;
  if v_count > 40 then raise exception 'Too many items in one order'; end if;

  -- flood guard: nobody legitimately places 4 orders in 10 minutes
  if (select count(*) from orders
       where customer_phone = v_phone
         and created_at > now() - interval '10 minutes') >= 3 then
    raise exception 'Too many orders from this number just now. Please call the shop.';
  end if;

  select data into s from settings where id = 1;
  v_no := 'SF' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('order_seq')::text, 4, '0');

  insert into orders (order_no, customer_name, customer_phone, customer_email,
                      address, city, pincode, note, subtotal, shipping, total, payment_mode)
  values (v_no, v_name, v_phone,
          nullif(btrim(coalesce(p->>'customer_email', '')), ''),
          v_addr,
          nullif(btrim(coalesce(p->>'city', '')), ''),
          nullif(regexp_replace(coalesce(p->>'pincode', ''), '[^0-9]', '', 'g'), ''),
          nullif(btrim(coalesce(p->>'note', '')), ''),
          0, 0, 0,
          coalesce(nullif(p->>'payment_mode', ''), 'cod'))
  returning id into v_id;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into prod from products
     where id = (it->>'product_id')::bigint and active and online;
    if not found then
      raise exception 'Sorry, one of the items is no longer available. Please refresh and try again.';
    end if;

    q := floor(coalesce((it->>'qty')::numeric, 1));
    if q < 1  then q := 1;  end if;
    if q > 20 then q := 20; end if;

    insert into order_items (order_id, product_id, name, barcode, qty, price, total)
    values (v_id, prod.id, prod.name, prod.barcode, q, prod.price, round(prod.price * q, 2));

    v_sub := v_sub + round(prod.price * q, 2);
  end loop;

  v_ship := coalesce((s->>'shipFlat')::numeric, 0);
  if coalesce((s->>'shipFreeAbove')::numeric, 0) > 0
     and v_sub >= (s->>'shipFreeAbove')::numeric then
    v_ship := 0;
  end if;

  update orders
     set subtotal = round(v_sub, 2),
         shipping = round(v_ship, 2),
         total    = round(v_sub + v_ship, 2)
   where id = v_id;

  return jsonb_build_object('order_no', v_no,
                            'subtotal', round(v_sub, 2),
                            'shipping', round(v_ship, 2),
                            'total',    round(v_sub + v_ship, 2));
end $fn$;

-- ---------- a delivered order becomes a bill ----------
-- Stock was already taken at confirm, so this only writes the ledger rows.
-- Idempotent: a second call returns the existing bill number.
create or replace function record_order_sale(p_order_id bigint, p_actor text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare o orders%rowtype; v_bill text; v_sale_id bigint;
begin
  select * into o from orders where id = p_order_id;
  if not found then return null; end if;

  select bill_no into v_bill from sales where order_id = o.id;
  if found then return v_bill; end if;

  v_bill := to_char(now(), 'YYMMDD') || '-' || lpad(nextval('bill_seq')::text, 4, '0');

  insert into sales (bill_no, local_ref, created_at, subtotal, discount, tax, total,
                     paid_cash, paid_online, payment_mode, customer_name, customer_phone,
                     note, cashier, source, order_id)
  values (v_bill, 'order:' || o.order_no, now(), o.total, 0, 0, o.total,
          case when o.payment_mode = 'cod' then o.total else 0 end,
          case when o.payment_mode = 'cod' then 0 else o.total end,
          o.payment_mode, o.customer_name, o.customer_phone,
          'Online order ' || o.order_no, p_actor, 'online', o.id)
  returning id into v_sale_id;

  insert into sale_items (sale_id, product_id, name, barcode, qty, price, total)
  select v_sale_id, product_id, name, barcode, qty, price, total
    from order_items where order_id = o.id;

  if o.shipping > 0 then
    insert into sale_items (sale_id, product_id, name, barcode, qty, price, total)
    values (v_sale_id, null, 'Delivery charge', null, 1, o.shipping, o.shipping);
  end if;

  return v_bill;
end $fn$;

-- ---------- the shop moves an order along ----------
-- Stock leaves the shelf on 'confirmed', not when the order is placed: a COD
-- order that never gets confirmed must not empty the counter's stock.
create or replace function set_order_status(p_order_id bigint, p_status text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare o orders%rowtype; it order_items%rowtype; v_bill text;
begin
  if not is_staff() then raise exception 'not authorised' using errcode = '42501'; end if;
  if p_status not in ('new','confirmed','packed','shipped','delivered','cancelled') then
    raise exception 'unknown status %', p_status;
  end if;
  if p_status = 'cancelled' and not is_owner() then
    raise exception 'only an owner can cancel an order' using errcode = '42501';
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  if o.status = 'delivered' and p_status <> 'delivered' then
    raise exception 'a delivered order is already a bill — return it from Reports like any other bill';
  end if;

  -- take stock the first time it is confirmed
  if p_status not in ('new', 'cancelled') and not o.stock_taken then
    for it in select * from order_items where order_id = o.id loop
      if it.product_id is not null then
        update products set stock = stock - it.qty where id = it.product_id;
        insert into stock_log (product_id, delta, reason, ref, actor)
        values (it.product_id, -it.qty, 'online order', o.order_no, p_actor);
      end if;
    end loop;
    update orders set stock_taken = true where id = o.id;
  end if;

  -- give it back if a confirmed order is cancelled
  if p_status = 'cancelled' and o.stock_taken then
    for it in select * from order_items where order_id = o.id loop
      if it.product_id is not null then
        update products set stock = stock + it.qty where id = it.product_id;
        insert into stock_log (product_id, delta, reason, ref, actor)
        values (it.product_id, it.qty, 'order cancelled', o.order_no, p_actor);
      end if;
    end loop;
    update orders set stock_taken = false where id = o.id;
  end if;

  -- delivered = money in: the order becomes a bill, so Reports and the cash book see it
  if p_status = 'delivered' then
    v_bill := record_order_sale(o.id, p_actor);
  end if;

  update orders
     set status = p_status, handled_by = p_actor, updated_at = now()
   where id = o.id;

  return jsonb_build_object('ok', true, 'order_no', o.order_no, 'status', p_status, 'bill_no', v_bill);
end $fn$;

-- ---------- security ----------
alter table orders      enable row level security;
alter table order_items enable row level security;

do $do$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public' and tablename in ('orders', 'order_items')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $do$;

-- No anon policy at all: visitors reach orders only through place_order().
create policy p_orders_read on orders      for select to authenticated using (is_staff());
create policy p_oitems_read on order_items for select to authenticated using (is_staff());

revoke all on function record_order_sale(bigint, text)          from public, anon, authenticated;
revoke all on function place_order(jsonb)                       from public;
revoke all on function set_order_status(bigint, text, text)     from public, anon;
grant  execute on function place_order(jsonb)                   to anon, authenticated;
grant  execute on function set_order_status(bigint, text, text) to authenticated;

-- orders delivered before this ledger link existed: give them their bills now
select record_order_sale(id, handled_by) from orders where status = 'delivered';
