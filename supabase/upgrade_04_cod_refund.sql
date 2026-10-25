-- =====================================================================
-- Shami Cosmetics — upgrade 04: any paid order that is cancelled/returned becomes refund_due
--
-- Before: only paid CliQ orders. Now also a COD order that was delivered (so paid) and then returned.
-- Only for a project installed before this change. A fresh install doesn't need it (03 has it).
-- Idempotent. Same function signature, so no grant changes (02b untouched).
-- =====================================================================

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
