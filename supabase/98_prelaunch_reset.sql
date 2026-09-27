-- =====================================================================
-- Shami Cosmetics — 98 pre-launch reset
--
-- Makes the first real order SH-10001. Sequence values are consumed even by rolled-back
-- transactions (e.g. the TESTS.md blocks), so the counter drifts during testing.
--
-- REFUSES to run if any order exists. Run it right before launch, after testing is finished.
-- If the only orders left are test orders, delete them first (reviewing them before you do):
--   select order_number, customer_name, phone, created_at from orders order by created_at;
--   delete from orders where ...;   -- cascades to items, history, notes, reviews
-- =====================================================================

do $$
declare
  v_count bigint;
begin
  -- Block new orders until this transaction ends, so none can slip in between check and reset.
  lock table public.orders in share row exclusive mode;

  select count(*) into v_count from public.orders;
  if v_count > 0 then
    raise exception 'REFUSED: % order(s) exist. The order number can only be reset while the orders table is empty.', v_count;
  end if;

  perform setval('public.order_number_seq', 10001, false);  -- next nextval() returns 10001
  raise notice 'Done: the next order will be SH-10001.';
end $$;

-- Check: last_value = 10001 and is_called = false  →  next order is SH-10001
select last_value, is_called from public.order_number_seq;
