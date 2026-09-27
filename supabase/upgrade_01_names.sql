-- =====================================================================
-- Shami Cosmetics — upgrade 01: customer-name validation (for installs made before this change)
--
-- Only for a project where the OLD 01–04 were already run. A fresh install doesn't need it
-- (the same definitions are in 01_schema.sql and 03_functions.sql).
-- Idempotent (create or replace only). Run it, then run 02b_grants.sql.
-- =====================================================================

create or replace function normalize_person_name(input text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(input, ''),
    '[\s   -     　﻿]+', ' ', 'g'));
$$;

create or replace function is_valid_person_name(input text)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.char_length(n) between 2 and 60
     and n ~ '^[A-Za-zÀ-ÖØ-öø-ɏء-غـ-ٰٟ-ۓ ''’-]+$'
     and n ~ '[A-Za-zÀ-ÖØ-öø-ɏء-غف-يٱ-ۓ]'
  from (select public.normalize_person_name(input) as n) s;
$$;

create or replace function profiles_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  new.full_name := nullif(normalize_person_name(new.full_name), '');
  if new.full_name is not null and not is_valid_person_name(new.full_name) then
    raise exception 'INVALID_NAME';
  end if;
  if new.phone is not null and btrim(new.phone) <> '' then
    new.phone := normalize_phone(new.phone);
    if new.phone is null then raise exception 'INVALID_PHONE'; end if;
  else
    new.phone := null;
  end if;
  return new;
end $$;

create or replace function addresses_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  new.full_name := normalize_person_name(new.full_name);
  if not is_valid_person_name(new.full_name) then raise exception 'INVALID_NAME'; end if;
  new.phone := normalize_phone(new.phone);
  if new.phone is null then raise exception 'INVALID_PHONE'; end if;
  if tg_op = 'INSERT' and not exists (select 1 from addresses a where a.user_id = new.user_id) then
    new.is_default := true;
  end if;
  if new.is_default then
    update addresses a set is_default = false
    where a.user_id = new.user_id and a.id <> new.id and a.is_default;
  end if;
  return new;
end $$;

create or replace function place_order(payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_payload   jsonb := payload;
  v_settings  settings%rowtype;
  v_name      text;
  v_phone     text;
  v_gov_id    integer;
  v_area      text;
  v_details   text;
  v_notes     text;
  v_method    text;
  v_code      text;
  v_items     jsonb;
  v_cart      jsonb;
  v_err       text;
  v_coupon_id bigint;
  v_order     orders%rowtype;
begin
  if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'INVALID_CART';
  end if;

  v_name    := normalize_person_name(v_payload ->> 'customer_name');
  v_phone   := normalize_phone(v_payload ->> 'phone');
  v_area    := btrim(coalesce(v_payload ->> 'area', ''));
  v_details := btrim(coalesce(v_payload ->> 'address_details', ''));
  v_notes   := nullif(btrim(coalesce(v_payload ->> 'notes', '')), '');
  v_method  := v_payload ->> 'payment_method';
  v_code    := nullif(upper(btrim(western_digits(v_payload ->> 'coupon_code'))), '');
  v_items   := v_payload -> 'items';

  select * into v_settings from settings where id;
  if not coalesce(v_settings.store_open, false) then
    raise exception 'STORE_CLOSED';
  end if;

  -- Field validation
  if not is_valid_person_name(v_name) then raise exception 'INVALID_NAME'; end if;
  if v_phone is null then raise exception 'INVALID_PHONE'; end if;
  if coalesce(v_payload ->> 'governorate_id', '') !~ '^[0-9]{1,4}$' then raise exception 'INVALID_GOVERNORATE'; end if;
  v_gov_id := (v_payload ->> 'governorate_id')::integer;
  if char_length(v_area) not between 2 and 80 or char_length(v_details) not between 3 and 300 then
    raise exception 'INVALID_ADDRESS';
  end if;
  if char_length(coalesce(v_notes, '')) > 500 then raise exception 'TEXT_TOO_LONG'; end if;
  if v_method is null or v_method not in ('cod', 'cliq') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if v_method = 'cliq' and (v_settings.cliq_alias is null or v_settings.cliq_account_name is null) then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;

  -- Rate limit: max 3 orders per phone per hour (serialized per phone so parallel requests can't slip through)
  perform pg_advisory_xact_lock(hashtextextended('place_order:' || v_phone, 0));
  if (select count(*) from orders o where o.phone = v_phone and o.created_at > now() - interval '1 hour') >= 3 then
    raise exception 'RATE_LIMITED';
  end if;

  -- Lock variant rows (in id order → no deadlocks) and the coupon row, then price.
  perform 1 from product_variants pv
  where pv.id in (select n.variant_id from _normalize_cart_items(v_items) n)
  order by pv.id
  for update;

  if v_code is not null then
    select c.id into v_coupon_id from coupons c where c.code = v_code for update;
  end if;

  v_cart := _price_cart(v_items, v_gov_id, v_code, v_phone);

  select l ->> 'error' into v_err
  from jsonb_array_elements(v_cart -> 'items') l
  where l ->> 'error' is not null
  limit 1;
  if v_err is not null then raise exception '%', v_err; end if;
  if v_cart ->> 'governorate_error' is not null then raise exception '%', v_cart ->> 'governorate_error'; end if;
  if v_cart -> 'coupon' ->> 'error' is not null then raise exception '%', v_cart -> 'coupon' ->> 'error'; end if;

  -- Order + snapshots
  insert into orders (
    user_id, customer_name, phone, governorate_id, governorate_name, area, address_details, notes,
    payment_method, payment_status,
    subtotal, bundle_discount, coupon_id, coupon_code, coupon_discount, delivery_fee, total, applied_offers)
  select
    auth.uid(), v_name, v_phone, g.id, g.name_ar, v_area, v_details, v_notes,
    v_method::payment_method,
    case when v_method = 'cliq' then 'awaiting_transfer' else 'unpaid' end::payment_status,
    (v_cart ->> 'subtotal')::numeric, (v_cart ->> 'bundle_discount')::numeric,
    v_coupon_id, case when v_coupon_id is not null then v_code end,
    (v_cart ->> 'coupon_discount')::numeric, (v_cart ->> 'delivery_fee')::numeric,
    (v_cart ->> 'total')::numeric, v_cart -> 'bundles'
  from governorates g
  where g.id = v_gov_id
  returning * into v_order;

  insert into order_items (order_id, variant_id, product_id, product_name_ar, product_name_en,
                           variant_label, sku, unit_price, quantity, line_total)
  select v_order.id, (l ->> 'variant_id')::bigint, (l ->> 'product_id')::bigint,
         l ->> 'product_name_ar', l ->> 'product_name_en', l ->> 'variant_label', l ->> 'sku',
         (l ->> 'unit_price')::numeric, (l ->> 'quantity')::integer, (l ->> 'line_total')::numeric
  from jsonb_array_elements(v_cart -> 'items') l;

  -- Stock (logged by trigger). CHECK (stock >= 0) is the last line of defence.
  perform _set_stock_context('order', v_order.id, null);
  begin
    update product_variants pv
    set stock = pv.stock - (l ->> 'quantity')::integer
    from jsonb_array_elements(v_cart -> 'items') l
    where pv.id = (l ->> 'variant_id')::bigint;
  exception when check_violation then
    raise exception 'OUT_OF_STOCK';
  end;
  perform _set_stock_context(null, null, null);

  if v_coupon_id is not null then
    update coupons c set used_count = c.used_count + 1 where c.id = v_coupon_id;
  end if;

  insert into order_status_history (order_id, from_status, to_status, changed_by, by_customer)
  values (v_order.id, null, 'new', auth.uid(), true);

  return jsonb_build_object(
    'order_number',   v_order.order_number,
    'public_token',   v_order.public_token,
    'total',          v_order.total,
    'payment_method', v_order.payment_method,
    'payment_status', v_order.payment_status);
end $$;

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, full_name, phone)
  values (new.id,
          -- invalid metadata is dropped (never block sign-up); the customer can fix it in the account page
          case when is_valid_person_name(new.raw_user_meta_data ->> 'full_name')
               then normalize_person_name(new.raw_user_meta_data ->> 'full_name') end,
          normalize_phone(new.raw_user_meta_data ->> 'phone'))
  on conflict (id) do nothing;
  return new;
end $$;
