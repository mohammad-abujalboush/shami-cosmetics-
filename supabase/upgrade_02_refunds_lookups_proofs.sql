-- =====================================================================
-- Shami Cosmetics — upgrade 02: refunds, lookup brute-force guard, 3 payment proofs per order
--
-- Only for a project installed before this change (it already ran upgrade_01 + 02b).
-- A fresh install doesn't need it: 01–04 contain the same definitions.
-- Idempotent. Run it, then run 02b_grants.sql again.
-- =====================================================================

-- a) Refunds: new payment status + payment columns on the status history
alter type payment_status add value if not exists 'refund_due' before 'refunded';

alter table order_status_history
  add column if not exists payment_from payment_status,
  add column if not exists payment_to   payment_status;

-- b) Failed order-number + phone lookups
create table if not exists order_lookup_failures (
  id           bigint generated always as identity primary key,
  order_number text not null,
  created_at   timestamptz not null default now()
);
create index if not exists order_lookup_failures_number_idx on order_lookup_failures (order_number, created_at);
create index if not exists order_lookup_failures_created_idx on order_lookup_failures (created_at);
alter table order_lookup_failures enable row level security;  -- no policies: functions only
revoke all on order_lookup_failures from anon, authenticated;

-- Functions (identical to 03_functions.sql / 04_storage.sql)

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

  -- Payment follow-ups: COD is paid on delivery; a paid CliQ order that is cancelled or
  -- returned now owes the customer a refund (the owner settles it with mark_refunded).
  v_new_pay := case
    when p_new = 'delivered' and v_order.payment_method = 'cod' then 'paid'
    when p_new in ('cancelled', 'returned') and v_order.payment_method = 'cliq' and v_old_pay = 'paid' then 'refund_due'
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

-- Owner only: the refund owed on a cancelled/returned paid CliQ order has been sent back.
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

-- True only for "<token>/<name>.<image ext>" where <token> is an unpaid CliQ order's public_token.
create or replace function can_upload_payment_proof(object_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_parts text[] := string_to_array(coalesce(object_name, ''), '/');
begin
  if coalesce(array_length(v_parts, 1), 0) <> 2 then
    return false;
  end if;
  if v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if lower(v_parts[2]) !~ '^[a-z0-9_-]{1,80}\.(jpe?g|png|webp|heic|heif)$' then
    return false;
  end if;
  -- At most 3 proof files per order.
  if (select count(*) from storage.objects so
      where so.bucket_id = 'payment-proofs' and so.name like v_parts[1] || '/%') >= 3 then
    return false;
  end if;
  return exists (
    select 1 from orders o
    where o.public_token = v_parts[1]::uuid
      and o.payment_method = 'cliq'
      and o.payment_status = 'awaiting_transfer'
      and o.status not in ('cancelled', 'returned')
  );
end $$;

-- New/changed functions: no API access until granted (02b re-applies the full set)
revoke execute on function _lookup_order_by_number(text, text), mark_refunded(uuid, text) from public, anon, authenticated;
grant execute on function mark_refunded(uuid, text) to authenticated;
