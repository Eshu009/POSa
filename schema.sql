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
