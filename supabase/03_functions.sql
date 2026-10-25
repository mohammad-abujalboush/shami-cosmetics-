-- =====================================================================
-- Shami Cosmetics — 03 functions (RPC API)
-- Run after 02_rls.sql.
--
-- * Every function is SECURITY DEFINER with SET search_path = public.
-- * Every error is RAISE EXCEPTION '<CODE>' where CODE is a key of strings.errors
--   in /assets/js/strings.ar.js. The frontend maps it to Arabic.
-- * Prices, discounts, delivery and totals are computed ONLY here (_price_cart).
-- * Public RPCs use plain parameter names (what supabase.rpc() sends) and
--   #variable_conflict use_column; parameters are copied into v_ locals first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internal helpers (not callable by clients — see grants at the bottom)
-- ---------------------------------------------------------------------

-- Validates the cart payload [{variant_id, qty}] and merges duplicate variants.
create or replace function _normalize_cart_items(p_items jsonb)
returns table (variant_id bigint, qty integer)
language plpgsql immutable security definer set search_path = public as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_CART';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_CART';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where not coalesce(
      jsonb_typeof(e) = 'object'
      and (e ->> 'variant_id') ~ '^[0-9]{1,18}$'
      and case when (e ->> 'qty') ~ '^[0-9]{1,3}$' then (e ->> 'qty')::integer >= 1 else false end,
      false)
  ) then
    raise exception 'INVALID_CART';
  end if;

  return query
    select (e ->> 'variant_id')::bigint, sum((e ->> 'qty')::integer)::integer
    from jsonb_array_elements(p_items) e
    group by 1;

  if exists (
    select 1 from jsonb_array_elements(p_items) e
    group by (e ->> 'variant_id') having sum((e ->> 'qty')::integer) > 999
  ) then
    raise exception 'INVALID_CART';
  end if;
end $$;

-- Transaction-local context read by the log_stock_movement trigger.
create or replace function _set_stock_context(p_reason text, p_order_id uuid, p_note text)
returns void language sql security definer set search_path = public as $$
  select set_config('app.stock_reason', coalesce(p_reason, ''), true),
         set_config('app.stock_order_id', coalesce(p_order_id::text, ''), true),
         set_config('app.stock_note', coalesce(p_note, ''), true);
$$;

create or replace function _can_transition(p_from order_status, p_to order_status)
returns boolean language sql immutable security definer set search_path = public as $$
  select (p_from::text, p_to::text) in (
    ('new', 'confirmed'), ('new', 'cancelled'),
    ('confirmed', 'with_courier'), ('confirmed', 'cancelled'),
    ('with_courier', 'delivered'), ('with_courier', 'returned'), ('with_courier', 'cancelled'),
    ('delivered', 'returned')
  );
$$;

-- ---------------------------------------------------------------------
-- _price_cart — the single source of truth for pricing.
-- Order: subtotal → bundle discount → coupon discount → delivery (0 if threshold met) → total.
-- Lines with an error are excluded from all totals. Never raises for coupon/stock problems;
-- it reports them so the cart can show them. place_order turns them into exceptions.
-- VOLATILE on purpose: inside place_order it must see rows as of *after* the FOR UPDATE locks.
-- ---------------------------------------------------------------------
create or replace function _price_cart(p_items jsonb, p_governorate_id integer, p_coupon_code text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_settings        settings%rowtype;
  v_lines           jsonb;
  v_has_errors      boolean;
  v_subtotal        numeric(10,3);
  v_bundle          numeric(10,3);
  v_bundles         jsonb;
  v_code            text := nullif(upper(btrim(western_digits(p_coupon_code))), '');
  v_coupon          coupons%rowtype;
  v_coupon_found    boolean := false;
  v_coupon_error    text;
  v_coupon_discount numeric(10,3) := 0;
  v_base            numeric(10,3);
  v_used            integer;
  v_gov             governorates%rowtype;
  v_gov_error       text;
  v_fee             numeric(10,3);
  v_free            boolean := false;
  v_goods           numeric(10,3);
  v_methods         jsonb := '["cod"]';
begin
  select * into v_settings from settings where id;

  -- 1. Lines (prices always from the database)
  with req as (
    select * from _normalize_cart_items(p_items)
  ),
  lines as (
    select r.variant_id as req_variant_id, r.qty,
           v.id as vid, v.product_id, v.label, v.sku, v.price, v.compare_at_price, v.stock,
           (v.active and p.active and c.active) as sellable,
           p.name_ar, p.name_en, p.slug, p.category_id,
           (select i.path from product_images i where i.product_id = p.id order by i.sort, i.id limit 1) as image_path
    from req r
    left join product_variants v on v.id = r.variant_id
    left join products p on p.id = v.product_id
    left join categories c on c.id = p.category_id
  )
  select jsonb_agg(jsonb_build_object(
           'variant_id',       l.req_variant_id,
           'product_id',       l.product_id,
           'product_slug',     l.slug,
           'product_name_ar',  l.name_ar,
           'product_name_en',  l.name_en,
           'variant_label',    l.label,
           'sku',              l.sku,
           'image_path',       l.image_path,
           'category_id',      l.category_id,
           'unit_price',       l.price,
           'compare_at_price', l.compare_at_price,
           'quantity',         l.qty,
           'available_stock',  case when l.sellable then l.stock else 0 end,
           'line_total',       coalesce(l.price * l.qty, 0),
           'error', case
                      when l.vid is null then 'VARIANT_NOT_FOUND'
                      when not l.sellable then 'VARIANT_INACTIVE'
                      when l.stock = 0 then 'OUT_OF_STOCK'
                      when l.qty > l.stock then 'INSUFFICIENT_STOCK'
                    end
         ) order by l.req_variant_id)
  into v_lines
  from lines l;

  select coalesce(bool_or(l ->> 'error' is not null), false),
         coalesce(sum((l ->> 'line_total')::numeric) filter (where l ->> 'error' is null), 0)
  into v_has_errors, v_subtotal
  from jsonb_array_elements(v_lines) l;

  -- 2. Bundle offers: eligible units sorted by price DESC, grouped into sets of N,
  --    each full set costs bundle_price; the rest stay at full price.
  with valid as (
    select (l ->> 'variant_id')::bigint as vid, (l ->> 'category_id')::bigint as cat,
           (l ->> 'unit_price')::numeric as price, (l ->> 'quantity')::integer as qty
    from jsonb_array_elements(v_lines) l
    where l ->> 'error' is null
  ),
  units as (
    select v.cat, v.price,
           row_number() over (partition by v.cat order by v.price desc, v.vid) as rn
    from valid v
    cross join lateral generate_series(1, v.qty)
  ),
  running as (
    select o.id, o.name_ar, o.category_id, o.quantity as n, o.bundle_price,
           (select count(*) from units u where u.cat = o.category_id) / o.quantity as sets
    from offers o
    where o.active and now() >= o.starts_at and now() < o.ends_at
  ),
  disc as (
    select r.*,
           greatest(0, (select coalesce(sum(u.price), 0) from units u
                        where u.cat = r.category_id and u.rn <= r.sets * r.n)
                       - r.sets * r.bundle_price) as discount
    from running r
    where r.sets > 0
  )
  select coalesce(sum(d.discount), 0),
         coalesce(jsonb_agg(jsonb_build_object(
                    'offer_id', d.id, 'name_ar', d.name_ar, 'quantity', d.n,
                    'bundle_price', d.bundle_price, 'sets', d.sets, 'discount', d.discount
                  ) order by d.id) filter (where d.discount > 0), '[]'::jsonb)
  into v_bundle, v_bundles
  from disc d;

  v_base := v_subtotal - v_bundle;

  -- 3. Coupon (applied after bundles, never below zero)
  if v_code is not null then
    select * into v_coupon from coupons c where c.code = v_code;
    v_coupon_found := found;
    if not v_coupon_found then
      v_coupon_error := 'COUPON_NOT_FOUND';
    elsif not v_coupon.active then
      v_coupon_error := 'COUPON_INACTIVE';
    elsif v_coupon.starts_at is not null and now() < v_coupon.starts_at then
      v_coupon_error := 'COUPON_NOT_STARTED';
    elsif v_coupon.ends_at is not null and now() >= v_coupon.ends_at then
      v_coupon_error := 'COUPON_EXPIRED';
    elsif v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses then
      v_coupon_error := 'COUPON_USAGE_LIMIT';
    elsif not v_coupon.combinable_with_offers and v_bundle > 0 then
      v_coupon_error := 'COUPON_NOT_COMBINABLE';
    elsif v_base < v_coupon.min_order then
      v_coupon_error := 'COUPON_MIN_ORDER';
    end if;

    if v_coupon_error is null and v_coupon.max_per_phone is not null and p_phone is not null then
      select count(*) into v_used
      from orders o
      where o.coupon_id = v_coupon.id and o.phone = p_phone and o.status <> 'cancelled';
      if v_used >= v_coupon.max_per_phone then
        v_coupon_error := 'COUPON_PHONE_LIMIT';
      end if;
    end if;

    if v_coupon_error is null then
      if v_coupon.type = 'percent' then
        v_coupon_discount := round(v_base * v_coupon.value / 100, 3);
        if v_coupon.max_discount is not null then
          v_coupon_discount := least(v_coupon_discount, v_coupon.max_discount);
        end if;
      else
        v_coupon_discount := v_coupon.value;
      end if;
      v_coupon_discount := greatest(0, least(v_coupon_discount, v_base));
    end if;
  end if;

  v_goods := v_base - v_coupon_discount;

  -- 4. Delivery
  if p_governorate_id is not null then
    select * into v_gov from governorates g where g.id = p_governorate_id and g.active;
    if not found then
      v_gov_error := 'INVALID_GOVERNORATE';
    else
      v_fee := v_gov.delivery_fee;
      if v_settings.free_delivery_threshold is not null and v_goods >= v_settings.free_delivery_threshold then
        v_fee := 0;
        v_free := true;
      end if;
    end if;
  end if;

  if v_settings.cliq_alias is not null and v_settings.cliq_account_name is not null then
    v_methods := '["cod", "cliq"]';
  end if;

  return jsonb_build_object(
    'items',                   coalesce(v_lines, '[]'::jsonb),
    'has_errors',              v_has_errors,
    'subtotal',                v_subtotal,
    'bundle_discount',         v_bundle,
    'bundles',                 v_bundles,
    'coupon',                  case when v_code is null then null else jsonb_build_object(
                                 'code', v_code,
                                 'type', case when v_coupon_found then v_coupon.type end,
                                 'value', case when v_coupon_found then v_coupon.value end,
                                 'discount', v_coupon_discount,
                                 'error', v_coupon_error) end,
    'coupon_discount',         v_coupon_discount,
    'governorate_id',          p_governorate_id,
    'governorate_error',       v_gov_error,
    'delivery_fee',            v_fee,  -- null until a governorate is chosen
    'free_delivery_threshold', v_settings.free_delivery_threshold,
    'free_delivery_applied',   v_free,
    'total',                   v_goods + coalesce(v_fee, 0),
    'store_open',              coalesce(v_settings.store_open, false),
    'payment_methods',         v_methods
  );
end $$;

-- Order status change with every rule enforced; used by staff and customer functions.
create or replace function _apply_status_change(
  p_order_id uuid, p_new order_status, p_note text, p_restock boolean, p_actor uuid, p_by_customer boolean)
returns orders language plpgsql security definer set search_path = public as $$
declare
  v_order   orders%rowtype;
  v_old     order_status;
  v_old_pay payment_status;
  v_new_pay payment_status;
begin
  select * into v_order from orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  v_old := v_order.status;
  v_old_pay := v_order.payment_status;

  if not _can_transition(v_old, p_new) then
    raise exception 'INVALID_TRANSITION';
  end if;
  if p_new = 'with_courier' and v_order.payment_method = 'cliq' and v_order.payment_status <> 'paid' then
    raise exception 'PAYMENT_NOT_VERIFIED';
  end if;

  -- Cancelled → always restock. Returned → restock only when asked (returned cosmetics may not be resellable).
  if p_new = 'cancelled' or (p_new = 'returned' and coalesce(p_restock, false)) then
    perform 1 from product_variants pv
    where pv.id in (select oi.variant_id from order_items oi where oi.order_id = v_order.id)
    order by pv.id
    for update;

    perform _set_stock_context(case when p_new = 'cancelled' then 'cancel' else 'return' end, v_order.id, p_note);
    update product_variants pv
    set stock = pv.stock + x.qty
    from (
      select oi.variant_id, sum(oi.quantity)::integer as qty
      from order_items oi
      where oi.order_id = v_order.id and oi.variant_id is not null
      group by oi.variant_id
    ) x
    where pv.id = x.variant_id;
    perform _set_stock_context(null, null, null);
  end if;

  -- A cancelled order releases its coupon use.
  if p_new = 'cancelled' and v_order.coupon_id is not null then
    update coupons c set used_count = greatest(c.used_count - 1, 0) where c.id = v_order.coupon_id;
  end if;

  -- Payment follow-ups: COD is paid on delivery; any paid order (CliQ, or COD returned after
  -- delivery) that is cancelled or returned now owes the customer a refund (the owner settles
  -- it with mark_refunded).
  v_new_pay := case
    when p_new = 'delivered' and v_order.payment_method = 'cod' then 'paid'
    when p_new in ('cancelled', 'returned') and v_old_pay = 'paid' then 'refund_due'
    else v_old_pay
  end;

  update orders o
  set status         = p_new,
      delivered_at   = case when p_new = 'delivered' then now() else o.delivered_at end,
      cancelled_at   = case when p_new = 'cancelled' then now() else o.cancelled_at end,
      payment_status = v_new_pay,
      paid_at        = case when p_new = 'delivered' and o.payment_method = 'cod' then now() else o.paid_at end
  where o.id = v_order.id
  returning * into v_order;

  insert into order_status_history (order_id, from_status, to_status, note, changed_by, by_customer, payment_from, payment_to)
  values (v_order.id, v_old, p_new, p_note, p_actor, coalesce(p_by_customer, false),
          case when v_new_pay is distinct from v_old_pay then v_old_pay end,
          case when v_new_pay is distinct from v_old_pay then v_new_pay end);

  return v_order;
end $$;

-- Safe, limited order view for the customer (success page, tracking, account).
create or replace function _order_public_json(p_order_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'order_number',     o.order_number,
    'public_token',     o.public_token,
    'status',           o.status,
    'payment_method',   o.payment_method,
    'payment_status',   o.payment_status,
    'created_at',       o.created_at,
    'customer_name',    o.customer_name,
    'phone',            o.phone,
    'governorate_name', o.governorate_name,
    'area',             o.area,
    'address_details',  o.address_details,
    'notes',            o.notes,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'variant_id', i.variant_id, 'product_id', i.product_id,
               'product_name_ar', i.product_name_ar, 'product_name_en', i.product_name_en,
               'variant_label', i.variant_label, 'unit_price', i.unit_price,
               'quantity', i.quantity, 'line_total', i.line_total) order by i.id), '[]'::jsonb)
      from order_items i where i.order_id = o.id),
    'subtotal',         o.subtotal,
    'bundle_discount',  o.bundle_discount,
    'applied_offers',   o.applied_offers,
    'coupon_code',      o.coupon_code,
    'coupon_discount',  o.coupon_discount,
    'delivery_fee',     o.delivery_fee,
    'total',            o.total,
    'history', (
      select coalesce(jsonb_agg(jsonb_build_object('status', h.to_status, 'at', h.created_at)
                                order by h.created_at, h.id), '[]'::jsonb)
      from order_status_history h
      where h.order_id = o.id and h.from_status is distinct from h.to_status),  -- skip payment-only rows
    'payment_proof_submitted', (o.payment_proof_path is not null or o.payment_reference is not null),
    'can_cancel',       o.status = 'new',
    'can_upload_proof', o.payment_method = 'cliq' and o.payment_status = 'awaiting_transfer'
                        and o.status not in ('cancelled', 'returned')
                        and (select count(*) from storage.objects so
                             where so.bucket_id = 'payment-proofs' and so.name like o.public_token::text || '/%') < 3,
    'review_submitted', exists (select 1 from reviews r where r.order_id = o.id),
    'can_review',       o.status = 'delivered' and not exists (select 1 from reviews r where r.order_id = o.id),
    -- CliQ transfer details only while the CliQ order is unpaid.
    'cliq', case
              when o.payment_method = 'cliq'
               and o.payment_status in ('awaiting_transfer', 'awaiting_verification')
               and o.status not in ('cancelled', 'returned')
              then jsonb_build_object(
                     'alias', s.cliq_alias,
                     'account_name', s.cliq_account_name,
                     'amount', o.total,
                     'window_hours', s.cliq_window_hours)
            end
  )
  from orders o
  cross join settings s
  where o.id = p_order_id and s.id;
$$;

-- ---------------------------------------------------------------------
-- Public: pricing & checkout
-- ---------------------------------------------------------------------

-- calculate_cart({ items: [{variant_id, qty}], governorate_id?, coupon_code?, phone? })
create or replace function calculate_cart(items jsonb, governorate_id integer default null,
                                          coupon_code text default null, phone text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_items   jsonb   := items;
  v_gov_id  integer := governorate_id;
  v_code    text    := coupon_code;
  v_phone   text    := normalize_phone(phone);
begin
  return _price_cart(v_items, v_gov_id, v_code, v_phone);
end $$;

-- place_order({ items, customer_name, phone, governorate_id, area, address_details, notes?,
--               payment_method: 'cod'|'cliq', coupon_code? })
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

-- ---------------------------------------------------------------------
-- Public: order lookup, CliQ proof, cancellation, reviews
-- ---------------------------------------------------------------------
create or replace function get_order_by_token(token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_token uuid := token;
  v_id    uuid;
begin
  select o.id into v_id from orders o where o.public_token = v_token;
  if v_id is null then raise exception 'ORDER_NOT_FOUND'; end if;
  return _order_public_json(v_id);
end $$;

-- Brute-force guard for order-number + phone lookups. Returns the order id, or NULL after
-- recording a failed attempt. Raises RATE_LIMITED once an order number has 10 failed attempts
-- within the last hour (successful lookups don't count). Callers must RETURN (not raise) on NULL,
-- otherwise the recorded failure would be rolled back with the exception.
create or replace function _lookup_order_by_number(p_order_number text, p_phone text)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_number text := upper(btrim(western_digits(p_order_number)));
  v_id     uuid;
begin
  if v_number ~ '^[0-9]+$' then v_number := 'SH-' || v_number; end if;
  perform pg_advisory_xact_lock(hashtextextended('order_lookup:' || v_number, 0));

  if (select count(*) from order_lookup_failures f
      where f.order_number = v_number and f.created_at > now() - interval '1 hour') >= 10 then
    raise exception 'RATE_LIMITED';
  end if;

  select o.id into v_id from orders o where o.order_number = v_number and o.phone = p_phone;
  if v_id is null then
    insert into order_lookup_failures (order_number) values (v_number);
    delete from order_lookup_failures f where f.created_at < now() - interval '1 day';  -- housekeeping
  end if;
  return v_id;
end $$;

-- Accepts "SH-10001", "sh-10001" or "10001", and any phone format normalize_phone understands.
-- Not found → returns {"error": "ORDER_NOT_FOUND"} (not raised, so the failed attempt is kept).
create or replace function track_order(order_number text, phone text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_number text := order_number;
  v_phone  text := normalize_phone(phone);
  v_id     uuid;
begin
  if v_phone is null then raise exception 'INVALID_PHONE'; end if;
  v_id := _lookup_order_by_number(v_number, v_phone);
  if v_id is null then return jsonb_build_object('error', 'ORDER_NOT_FOUND'); end if;
  return _order_public_json(v_id);
end $$;

-- Call AFTER uploading the receipt to payment-proofs/<public_token>/<file>. Either file or reference is enough.
create or replace function attach_payment_proof(token uuid, file_path text default null, reference text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_token uuid := token;
  v_path  text := nullif(btrim(coalesce(file_path, '')), '');
  v_ref   text := nullif(btrim(western_digits(reference)), '');
  v_order orders%rowtype;
begin
  select * into v_order from orders o where o.public_token = v_token for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.payment_method <> 'cliq' then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if v_order.status in ('cancelled', 'returned') then raise exception 'ORDER_CANCELLED'; end if;
  if v_order.payment_status = 'paid' then raise exception 'ALREADY_PAID'; end if;
  if v_order.payment_status = 'awaiting_verification' then raise exception 'RECEIPT_ALREADY_UPLOADED'; end if;
  if v_path is null and v_ref is null then raise exception 'PROOF_REQUIRED'; end if;
  if char_length(coalesce(v_ref, '')) > 64 then raise exception 'TEXT_TOO_LONG'; end if;
  if v_path is not null and (
       v_path not like v_token::text || '/%'
       or not exists (select 1 from storage.objects so where so.bucket_id = 'payment-proofs' and so.name = v_path)
     ) then
    raise exception 'INVALID_PROOF';
  end if;

  update orders o
  set payment_proof_path   = coalesce(v_path, o.payment_proof_path),
      payment_reference    = coalesce(v_ref, o.payment_reference),
      payment_status       = 'awaiting_verification',
      payment_submitted_at = now()
  where o.id = v_order.id;

  return _order_public_json(v_order.id);
end $$;

-- Guest cancellation (tracking page): order number + phone, only while status = new.
-- Same brute-force guard as track_order; not found → returns {"error": "ORDER_NOT_FOUND"}.
create or replace function cancel_own_order(order_number text, phone text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_number text := order_number;
  v_phone  text := normalize_phone(phone);
  v_id     uuid;
  v_order  orders%rowtype;
begin
  if v_phone is null then raise exception 'INVALID_PHONE'; end if;
  v_id := _lookup_order_by_number(v_number, v_phone);
  if v_id is null then return jsonb_build_object('error', 'ORDER_NOT_FOUND'); end if;
  select * into v_order from orders o where o.id = v_id for update;
  if v_order.status <> 'new' then raise exception 'CANNOT_CANCEL'; end if;
  perform _apply_status_change(v_order.id, 'cancelled', null, true, auth.uid(), true);
  return _order_public_json(v_order.id);
end $$;

-- Logged-in customer cancellation, only while status = new.
create or replace function cancel_my_order(order_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_order_id uuid := order_id;
  v_order    orders%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHORIZED'; end if;
  select * into v_order from orders o where o.id = v_order_id and o.user_id = auth.uid() for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'new' then raise exception 'CANNOT_CANCEL'; end if;
  perform _apply_status_change(v_order.id, 'cancelled', null, true, auth.uid(), true);
  return _order_public_json(v_order.id);
end $$;

-- One review per delivered order; starts as pending until staff approve it.
create or replace function submit_review(order_token uuid, rating integer, body text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_token  uuid    := order_token;
  v_rating integer := rating;
  v_body   text    := nullif(btrim(coalesce(body, '')), '');
  v_order  orders%rowtype;
begin
  select * into v_order from orders o where o.public_token = v_token;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'delivered' then raise exception 'ORDER_NOT_DELIVERED'; end if;
  if v_rating is null or v_rating not between 1 and 5 then raise exception 'INVALID_RATING'; end if;
  if char_length(coalesce(v_body, '')) > 1000 then raise exception 'TEXT_TOO_LONG'; end if;
  if exists (select 1 from reviews r where r.order_id = v_order.id) then raise exception 'REVIEW_EXISTS'; end if;

  begin
    insert into reviews (order_id, rating, body, display_name, governorate_name)
    values (v_order.id, v_rating, v_body, split_part(btrim(v_order.customer_name), ' ', 1), v_order.governorate_name);
  exception when unique_violation then
    raise exception 'REVIEW_EXISTS';
  end;

  return jsonb_build_object('status', 'pending');
end $$;

-- Approved reviews for a product (reviews belong to orders, which guests can't read).
-- Returns { count, average, reviews: [{ rating, body, display_name, governorate_name, created_at }] }.
create or replace function product_reviews(product_id bigint, max_rows integer default 10)
returns jsonb language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_product_id bigint  := product_id;
  v_limit      integer := least(greatest(coalesce(max_rows, 10), 1), 50);
begin
  return (
    with r as (
      select rv.id, rv.rating, rv.body, rv.display_name, rv.governorate_name, rv.created_at
      from reviews rv
      where rv.status = 'approved'
        and exists (select 1 from order_items oi where oi.order_id = rv.order_id and oi.product_id = v_product_id)
    )
    select jsonb_build_object(
      'count',   (select count(*) from r),
      'average', (select round(avg(r.rating), 1) from r),
      'reviews', (select coalesce(jsonb_agg(to_jsonb(x) - 'id' order by x.created_at desc, x.id desc), '[]'::jsonb)
                  from (select * from r order by r.created_at desc, r.id desc limit v_limit) x))
  );
end $$;

-- Skin quiz: active soap products ranked by matching tags (top 3).
create or replace function quiz_recommend(tags text[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tags text[] := (normalize_tags(coalesce(tags, '{}'::text[])))[1:20];
begin
  return (
    select coalesce(jsonb_agg(to_jsonb(r) order by r.match_count desc, r.in_stock desc, r.is_bestseller desc, r.sort, r.id), '[]'::jsonb)
    from (
      select p.id, p.slug, p.name_ar, p.name_en, p.description_ar, p.tags, p.is_bestseller, p.sort,
             (select count(*) from unnest(p.tags) t where t = any (v_tags))::integer as match_count,
             (select min(v.price) from product_variants v where v.product_id = p.id and v.active) as from_price,
             (select v.id from product_variants v where v.product_id = p.id and v.active and v.stock > 0
              order by v.price, v.sort, v.id limit 1) as default_variant_id,
             exists (select 1 from product_variants v where v.product_id = p.id and v.active and v.stock > 0) as in_stock,
             (select i.path from product_images i where i.product_id = p.id order by i.sort, i.id limit 1) as image_path
      from products p
      join categories c on c.id = p.category_id
      where c.key = 'soap' and product_is_visible(p.id)
      order by match_count desc, in_stock desc, p.is_bestseller desc, p.sort, p.id
      limit 3
    ) r
  );
end $$;

-- ---------------------------------------------------------------------
-- Staff / owner
-- ---------------------------------------------------------------------
create or replace function update_order_status(order_id uuid, new_status text, note text default null,
                                               restock boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_order_id uuid    := order_id;
  v_status   text    := new_status;
  v_note     text    := nullif(btrim(coalesce(note, '')), '');
  v_restock  boolean := coalesce(restock, false);
  v_order    orders%rowtype;
begin
  if not is_staff() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_status is null or v_status not in (select unnest(enum_range(null::order_status))::text) then
    raise exception 'INVALID_TRANSITION';
  end if;
  if char_length(coalesce(v_note, '')) > 1000 then raise exception 'TEXT_TOO_LONG'; end if;

  v_order := _apply_status_change(v_order_id, v_status::order_status, v_note, v_restock, auth.uid(), false);
  return jsonb_build_object('status', v_order.status, 'payment_status', v_order.payment_status);
end $$;

-- Owner only. paid = true confirms the CliQ transfer; false rejects the proof so the
-- customer can upload again. Money confirmed for an order that is already cancelled/returned
-- becomes refund_due. Every change is logged in order_status_history (payment-only row).
create or replace function verify_payment(order_id uuid, paid boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_order_id uuid    := order_id;
  v_paid     boolean := paid;
  v_order    orders%rowtype;
  v_old_pay  payment_status;
  v_new_pay  payment_status;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into v_order from orders o where o.id = v_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.payment_method <> 'cliq' then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  v_old_pay := v_order.payment_status;

  if coalesce(v_paid, false) then
    if v_old_pay = 'paid' then raise exception 'ALREADY_PAID'; end if;
    if v_old_pay not in ('awaiting_transfer', 'awaiting_verification') then
      raise exception 'INVALID_TRANSITION';
    end if;
    v_new_pay := case when v_order.status in ('cancelled', 'returned') then 'refund_due' else 'paid' end;
    update orders o
    set payment_status = v_new_pay, paid_at = now(), payment_verified_by = auth.uid()
    where o.id = v_order.id
    returning * into v_order;
  else
    -- Can't un-verify once the parcel may already be with the courier.
    if v_old_pay not in ('awaiting_verification', 'paid') or v_order.status not in ('new', 'confirmed') then
      raise exception 'INVALID_TRANSITION';
    end if;
    v_new_pay := 'awaiting_transfer';
    update orders o
    set payment_status = v_new_pay, paid_at = null, payment_verified_by = auth.uid()
    where o.id = v_order.id
    returning * into v_order;
  end if;

  insert into order_status_history (order_id, from_status, to_status, changed_by, payment_from, payment_to)
  values (v_order.id, v_order.status, v_order.status, auth.uid(), v_old_pay, v_new_pay);

  return jsonb_build_object('payment_status', v_order.payment_status, 'paid_at', v_order.paid_at);
end $$;

-- Owner only: the refund owed on a cancelled/returned paid order has been sent back.
create or replace function mark_refunded(order_id uuid, note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_order_id uuid := order_id;
  v_note     text := nullif(btrim(coalesce(note, '')), '');
  v_order    orders%rowtype;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if char_length(coalesce(v_note, '')) > 1000 then raise exception 'TEXT_TOO_LONG'; end if;
  select * into v_order from orders o where o.id = v_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.payment_status <> 'refund_due' then raise exception 'REFUND_NOT_DUE'; end if;

  update orders o set payment_status = 'refunded' where o.id = v_order.id returning * into v_order;

  insert into order_status_history (order_id, from_status, to_status, note, changed_by, payment_from, payment_to)
  values (v_order.id, v_order.status, v_order.status, v_note, auth.uid(), 'refund_due', 'refunded');

  return jsonb_build_object('payment_status', v_order.payment_status);
end $$;

-- Manual stock adjustment (staff and owner). change > 0 adds, < 0 removes. Always logged.
create or replace function adjust_stock(variant_id bigint, change integer, note text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_variant_id bigint  := variant_id;
  v_change     integer := change;
  v_note       text    := nullif(btrim(coalesce(note, '')), '');
  v_stock      integer;
begin
  if not is_staff() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_change is null or v_change = 0 or abs(v_change) > 100000 then raise exception 'INVALID_QUANTITY'; end if;
  if char_length(coalesce(v_note, '')) > 500 then raise exception 'TEXT_TOO_LONG'; end if;

  select pv.stock into v_stock from product_variants pv where pv.id = v_variant_id for update;
  if not found then raise exception 'VARIANT_NOT_FOUND'; end if;
  if v_stock + v_change < 0 then raise exception 'INSUFFICIENT_STOCK'; end if;

  perform _set_stock_context('manual', null, v_note);
  update product_variants pv set stock = pv.stock + v_change where pv.id = v_variant_id
  returning pv.stock into v_stock;
  perform _set_stock_context(null, null, null);

  return jsonb_build_object('variant_id', v_variant_id, 'stock', v_stock);
end $$;

-- Owner promotes an existing account (by email) to staff or owner.
create or replace function add_staff(email text, role text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_email text := lower(btrim(coalesce(email, '')));
  v_role  text := role;
  v_uid   uuid;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_role is null or v_role not in ('owner', 'staff') then raise exception 'INVALID_ROLE'; end if;
  select u.id into v_uid from auth.users u where lower(u.email) = v_email;
  if v_uid is null then raise exception 'USER_NOT_FOUND'; end if;
  if v_uid = auth.uid() and v_role <> 'owner' then raise exception 'CANNOT_REMOVE_SELF'; end if;

  insert into staff (user_id, role, active, created_by)
  values (v_uid, v_role::staff_role, true, auth.uid())
  on conflict (user_id) do update set role = excluded.role, active = true;

  return jsonb_build_object('user_id', v_uid, 'role', v_role);
end $$;

create or replace function remove_staff(user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_uid uuid := user_id;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_uid = auth.uid() then raise exception 'CANNOT_REMOVE_SELF'; end if;
  delete from staff s where s.user_id = v_uid;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  return jsonb_build_object('user_id', v_uid);
end $$;

-- Owner: staff list with emails (auth.users is not readable from the client).
create or replace function list_staff()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id', s.user_id, 'email', u.email, 'full_name', p.full_name,
             'role', s.role, 'active', s.active, 'created_at', s.created_at)
           order by s.role, s.created_at), '[]'::jsonb)
    from staff s
    join auth.users u on u.id = s.user_id
    left join profiles p on p.id = s.user_id
  );
end $$;

-- Owner: full settings row including CliQ details.
create or replace function get_admin_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  return (select to_jsonb(s) from settings s where s.id);
end $$;

-- Owner dashboard. Range = whole days in Asia/Amman, based on order created_at.
-- Revenue = delivered orders' goods after discounts (total − delivery_fee); delivery fees reported separately.
create or replace function dashboard_stats(date_from date, date_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_date_from date := date_from;
  v_date_to   date := date_to;
  v_from      timestamptz;
  v_to        timestamptz;
  v_window    integer;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_date_from is null or v_date_to is null or v_date_to < v_date_from or v_date_to - v_date_from > 366 then
    raise exception 'INVALID_DATE_RANGE';
  end if;

  v_from := v_date_from::timestamp at time zone 'Asia/Amman';
  v_to   := (v_date_to + 1)::timestamp at time zone 'Asia/Amman';
  select s.cliq_window_hours into v_window from settings s where s.id;

  return (
    with ord as (
      select * from orders o where o.created_at >= v_from and o.created_at < v_to
    ),
    delivered as (
      select * from ord where ord.status = 'delivered'
    )
    select jsonb_build_object(
      'range', jsonb_build_object('from', v_date_from, 'to', v_date_to, 'timezone', 'Asia/Amman'),
      'orders_total', (select count(*) from ord),
      'orders_by_status', (
        select jsonb_object_agg(st::text, (select count(*) from ord where ord.status = st))
        from unnest(enum_range(null::order_status)) st),
      'delivered_orders',    (select count(*) from delivered),
      'revenue',             (select coalesce(sum(d.total - d.delivery_fee), 0) from delivered d),
      'delivery_fees',       (select coalesce(sum(d.delivery_fee), 0) from delivered d),
      'discounts',           (select coalesce(sum(d.bundle_discount + d.coupon_discount), 0) from delivered d),
      'average_order_value', (select coalesce(round(avg(d.total - d.delivery_fee), 3), 0) from delivered d),
      'top_products', (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.quantity desc, t.product_name_ar), '[]'::jsonb)
        from (
          select oi.product_id, max(oi.product_name_ar) as product_name_ar,
                 sum(oi.quantity)::integer as quantity, sum(oi.line_total) as gross_sales
          from order_items oi
          join delivered d on d.id = oi.order_id
          group by oi.product_id
          order by sum(oi.quantity) desc, max(oi.product_name_ar)
          limit 5
        ) t),
      'low_stock', (
        select coalesce(jsonb_agg(to_jsonb(x) order by x.stock, x.product_name_ar), '[]'::jsonb)
        from (
          select pv.id as variant_id, p.id as product_id, p.name_ar as product_name_ar,
                 pv.label as variant_label, pv.sku, pv.stock, pv.low_stock_threshold
          from product_variants pv
          join products p on p.id = pv.product_id
          where pv.active and p.active and pv.stock <= pv.low_stock_threshold
          order by pv.stock, p.name_ar
          limit 50
        ) x),
      -- Outstanding refunds (not date-bound)
      'refund_due_count',  (select count(*) from orders o where o.payment_status = 'refund_due'),
      'refund_due_amount', (select coalesce(sum(o.total), 0) from orders o where o.payment_status = 'refund_due'),
      'flagged_cliq_orders', (
        select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at), '[]'::jsonb)
        from (
          select o.id, o.order_number, o.customer_name, o.total, o.payment_status, o.status, o.created_at
          from orders o
          where o.payment_method = 'cliq'
            and o.payment_status in ('awaiting_transfer', 'awaiting_verification')
            and o.status not in ('cancelled', 'returned')
            and o.created_at < now() - make_interval(hours => v_window)
        ) f)
    )
  );
end $$;

-- ---------------------------------------------------------------------
-- Profile row for every new auth user (name/phone from sign-up metadata)
-- ---------------------------------------------------------------------
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Function privileges: revoke everything, then grant exactly the API.
-- Internal helpers (_price_cart, _apply_status_change, _order_public_json, _normalize_cart_items,
-- _set_stock_context, _can_transition, _lookup_order_by_number) and trigger functions stay callable by NO API role.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Called inside RLS policies, generated columns and triggers that run as the API role.
grant execute on function
  is_staff(), is_owner(), product_is_visible(bigint),
  western_digits(text), normalize_ar(text), product_search_text(text, text, text[]),
  normalize_phone(text), slugify(text), normalize_tags(text[]),
  normalize_person_name(text), is_valid_person_name(text)
to anon, authenticated;

-- Public RPCs (guests and customers)
grant execute on function
  calculate_cart(jsonb, integer, text, text),
  place_order(jsonb),
  get_order_by_token(uuid),
  track_order(text, text),
  attach_payment_proof(uuid, text, text),
  cancel_own_order(text, text),
  submit_review(uuid, integer, text),
  quiz_recommend(text[]),
  product_reviews(bigint, integer)
to anon, authenticated;

-- Signed-in only (each checks is_staff() / is_owner() / ownership inside)
grant execute on function
  cancel_my_order(uuid),
  update_order_status(uuid, text, text, boolean),
  verify_payment(uuid, boolean),
  mark_refunded(uuid, text),
  adjust_stock(bigint, integer, text),
  add_staff(text, text),
  remove_staff(uuid),
  list_staff(),
  get_admin_settings(),
  dashboard_stats(date, date)
to authenticated;
