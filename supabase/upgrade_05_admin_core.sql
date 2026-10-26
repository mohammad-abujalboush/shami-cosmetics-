-- =====================================================================
-- Shami Cosmetics — upgrade 05: admin core
--
--  1. staff_overview(): what the staff dashboard shows (pending orders, flagged CliQ orders, low stock).
--     dashboard_stats() stays owner-only because it contains revenue.
--  2. Realtime: the orders table is added to the supabase_realtime publication so the admin panel can
--     notify about new orders. Realtime applies the table's RLS to every subscriber, so only
--     staff (policy "orders: read own or staff") and the order's own customer receive an order row.
--
-- Only for a project installed before this change. A fresh install doesn't need it (03 and 02b have it).
-- Idempotent.
-- =====================================================================

create or replace function staff_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_window integer;
begin
  if not is_staff() then raise exception 'NOT_AUTHORIZED'; end if;
  select s.cliq_window_hours into v_window from settings s where s.id;

  return jsonb_build_object(
    'new_count',          (select count(*) from orders o where o.status = 'new'),
    'confirmed_count',    (select count(*) from orders o where o.status = 'confirmed'),
    'with_courier_count', (select count(*) from orders o where o.status = 'with_courier'),
    'cliq_window_hours',  v_window,
    'flagged_cliq_orders', (
      select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at), '[]'::jsonb)
      from (
        select o.id, o.order_number, o.customer_name, o.total, o.payment_status, o.status, o.created_at
        from orders o
        where o.payment_method = 'cliq'
          and o.payment_status in ('awaiting_transfer', 'awaiting_verification')
          and o.status not in ('cancelled', 'returned')
          and o.created_at < now() - make_interval(hours => v_window)
        order by o.created_at
        limit 50
      ) f),
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
      ) x)
  );
end $$;

revoke execute on function staff_overview() from public, anon, authenticated;
grant execute on function staff_overview() to authenticated, service_role;

-- Realtime for new-order notifications (RLS still applies to what each subscriber receives).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;
