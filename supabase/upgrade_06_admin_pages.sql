-- =====================================================================
-- Shami Cosmetics — upgrade 06: remaining admin pages
--
--  1. staff_names()      staff + owner: id + display name of staff members (no emails, no roles),
--                        so order history / notes / stock movements can show who did what.
--  2. set_staff_active() owner: deactivate / reactivate a staff member (history keeps their name).
--                        The last active owner can never be deactivated.
--  3. coupon_stats()     owner: usage per coupon (orders, discount given, last use).
--  4. sales_report()     owner: sales by day / product / governorate / payment method + refunds.
--
-- Only for a project installed before this change. A fresh install doesn't need it (03 and 02b have it).
-- Idempotent.
-- =====================================================================

create or replace function staff_names()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'NOT_AUTHORIZED'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id', s.user_id,
             'display_name', coalesce(nullif(btrim(p.full_name), ''), 'موظف')) order by s.created_at), '[]'::jsonb)
    from staff s
    left join profiles p on p.id = s.user_id
  );
end $$;

create or replace function set_staff_active(user_id uuid, make_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_uid    uuid    := user_id;
  v_active boolean := coalesce(make_active, false);
  v_row    staff%rowtype;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_uid = auth.uid() and not v_active then raise exception 'CANNOT_REMOVE_SELF'; end if;
  select * into v_row from staff s where s.user_id = v_uid for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if not v_active and v_row.role = 'owner'
     and not exists (select 1 from staff s where s.role = 'owner' and s.active and s.user_id <> v_uid) then
    raise exception 'LAST_OWNER';
  end if;
  update staff s set active = v_active where s.user_id = v_uid;
  return jsonb_build_object('user_id', v_uid, 'active', v_active);
end $$;

create or replace function coupon_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'coupon_id', c.id,
             'orders', x.orders,
             'discount_total', x.discount_total,
             'last_used', x.last_used) order by c.id), '[]'::jsonb)
    from coupons c
    cross join lateral (
      select count(*) filter (where o.status <> 'cancelled')::integer as orders,
             coalesce(sum(o.coupon_discount) filter (where o.status not in ('cancelled', 'returned')), 0) as discount_total,
             max(o.created_at) as last_used
      from orders o where o.coupon_id = c.id
    ) x
  );
end $$;

-- Owner report. Same basis as dashboard_stats: orders CREATED in the range (whole days, Asia/Amman);
-- revenue = delivered orders' goods after discounts (total - delivery_fee).
create or replace function sales_report(date_from date, date_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_date_from date := date_from;
  v_date_to   date := date_to;
  v_from      timestamptz;
  v_to        timestamptz;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_date_from is null or v_date_to is null or v_date_to < v_date_from or v_date_to - v_date_from > 366 then
    raise exception 'INVALID_DATE_RANGE';
  end if;
  v_from := v_date_from::timestamp at time zone 'Asia/Amman';
  v_to   := (v_date_to + 1)::timestamp at time zone 'Asia/Amman';

  return (
    with ord as (
      select o.*, (o.created_at at time zone 'Asia/Amman')::date as day
      from orders o where o.created_at >= v_from and o.created_at < v_to
    ),
    delivered as (select * from ord where ord.status = 'delivered')
    select jsonb_build_object(
      'range', jsonb_build_object('from', v_date_from, 'to', v_date_to, 'timezone', 'Asia/Amman'),
      'totals', jsonb_build_object(
        'orders',        (select count(*) from ord),
        'delivered',     (select count(*) from delivered),
        'cancelled',     (select count(*) from ord where ord.status = 'cancelled'),
        'returned',      (select count(*) from ord where ord.status = 'returned'),
        'revenue',       (select coalesce(sum(d.total - d.delivery_fee), 0) from delivered d),
        'delivery_fees', (select coalesce(sum(d.delivery_fee), 0) from delivered d),
        'discounts',     (select coalesce(sum(d.bundle_discount + d.coupon_discount), 0) from delivered d)),
      'by_day', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'day', g.day, 'orders', coalesce(c.orders, 0), 'delivered', coalesce(c.delivered, 0),
                 'revenue', coalesce(c.revenue, 0)) order by g.day), '[]'::jsonb)
        from generate_series(v_date_from, v_date_to, interval '1 day') as gs(d)
        cross join lateral (select gs.d::date as day) g
        left join (
          select ord.day,
                 count(*)::integer as orders,
                 (count(*) filter (where ord.status = 'delivered'))::integer as delivered,
                 coalesce(sum(ord.total - ord.delivery_fee) filter (where ord.status = 'delivered'), 0) as revenue
          from ord group by ord.day
        ) c on c.day = g.day),
      'top_products', (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.quantity desc, t.product_name_ar), '[]'::jsonb)
        from (
          select oi.product_id, max(oi.product_name_ar) as product_name_ar,
                 sum(oi.quantity)::integer as quantity, sum(oi.line_total) as gross_sales
          from order_items oi join delivered d on d.id = oi.order_id
          group by oi.product_id
          order by sum(oi.quantity) desc, max(oi.product_name_ar)
          limit 20
        ) t),
      'by_governorate', (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.revenue desc, t.orders desc, t.governorate_name), '[]'::jsonb)
        from (
          select ord.governorate_name,
                 count(*)::integer as orders,
                 (count(*) filter (where ord.status = 'delivered'))::integer as delivered,
                 coalesce(sum(ord.total - ord.delivery_fee) filter (where ord.status = 'delivered'), 0) as revenue
          from ord group by ord.governorate_name
        ) t),
      'by_payment_method', (
        select coalesce(jsonb_agg(to_jsonb(t) order by t.method), '[]'::jsonb)
        from (
          select ord.payment_method::text as method,
                 count(*)::integer as orders,
                 (count(*) filter (where ord.status = 'delivered'))::integer as delivered,
                 coalesce(sum(ord.total - ord.delivery_fee) filter (where ord.status = 'delivered'), 0) as revenue
          from ord group by ord.payment_method
        ) t),
      'refunds', jsonb_build_object(
        'refund_due_count',  (select count(*) from ord where ord.payment_status = 'refund_due'),
        'refund_due_amount', (select coalesce(sum(ord.total), 0) from ord where ord.payment_status = 'refund_due'),
        'refunded_count',    (select count(*) from ord where ord.payment_status = 'refunded'),
        'refunded_amount',   (select coalesce(sum(ord.total), 0) from ord where ord.payment_status = 'refunded'))
    )
  );
end $$;

revoke execute on function staff_names(), set_staff_active(uuid, boolean), coupon_stats(), sales_report(date, date)
  from public, anon, authenticated;
grant execute on function staff_names(), set_staff_active(uuid, boolean), coupon_stats(), sales_report(date, date)
  to authenticated, service_role;
