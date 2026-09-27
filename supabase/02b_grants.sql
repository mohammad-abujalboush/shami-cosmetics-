-- =====================================================================
-- Shami Cosmetics — 02b grants (standalone, idempotent)
--
-- Resets ALL privileges of the API roles (anon, authenticated) on our objects to exactly
-- what the RLS policies need, whatever state the project was in. Safe to re-run any time.
--
-- * Existing install (01–05 already run): run this file once.
-- * Fresh install: NOT needed — the same statements are at the end of 02, 03 and 04.
--   (Keep them identical; the "Grants" block in TESTS.md fails if they drift.)
-- Requires 01–04 to have been run (it references their tables and functions).
-- =====================================================================

-- Future objects are NOT auto-granted to the API roles.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

-- ---------------------------------------------------------------------
-- Table privileges — least privilege. Privileges decide WHICH operations a role may attempt;
-- RLS policies above decide WHICH ROWS. Both are required.
-- Starts from zero so the result is the same whether or not the project auto-granted anything.
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- service_role is server-side only (never in the browser); it bypasses RLS anyway.
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Public catalog: guests and signed-in users (RLS: active / visible / approved rows only)
grant select on governorates, categories, products, product_images, product_variants,
                offers, reviews, quiz_questions, quiz_options
  to anon, authenticated;
-- settings: public columns only. CliQ alias/account name are never readable by clients
-- (returned by get_order_by_token / track_order for unpaid CliQ orders; owner uses get_admin_settings()).
grant select (id, store_whatsapp, top_bar_messages, homepage_stats, return_policy_ar,
              social_links, store_open, free_delivery_threshold, cliq_window_hours, updated_at)
  on settings to anon, authenticated;

-- Owner catalog/settings management (RLS: is_owner())
grant update (store_whatsapp, cliq_alias, cliq_account_name, cliq_window_hours, free_delivery_threshold,
              top_bar_messages, homepage_stats, return_policy_ar, social_links, store_open)
  on settings to authenticated;
grant update (delivery_fee, active, sort) on governorates to authenticated;
grant insert, update, delete on categories, products, product_images, offers,
                                quiz_questions, quiz_options to authenticated;
grant select, insert, update, delete on coupons to authenticated;
grant insert, delete on product_variants to authenticated;
-- never stock: stock changes only via adjust_stock / order functions (always logged)
grant update (label, sku, price, compare_at_price, low_stock_threshold, active, sort)
  on product_variants to authenticated;

-- Customers (RLS: own rows)
grant select on profiles to authenticated;
grant insert (id, full_name, phone) on profiles to authenticated;
grant update (full_name, phone) on profiles to authenticated;
grant select, insert, update, delete on addresses to authenticated;
-- orders are read-only for everyone: they are created only by place_order
grant select on orders, order_items to authenticated;

-- Staff / owner (RLS: is_staff() / is_owner())
grant select on staff, order_status_history, stock_movements to authenticated;
grant select, delete on order_notes to authenticated;
grant insert (order_id, body) on order_notes to authenticated;
grant update (status, featured) on reviews to authenticated;
grant delete on reviews to authenticated;

-- Identity sequences of tables the owner/staff insert into directly
do $$
declare t text;
begin
  foreach t in array array['categories', 'products', 'product_images', 'product_variants', 'offers',
                           'coupons', 'quiz_questions', 'quiz_options', 'order_notes'] loop
    execute format('grant usage on sequence %s to authenticated', pg_get_serial_sequence('public.' || t, 'id'));
  end loop;
end $$;

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
  quiz_recommend(text[])
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

-- From 04_storage.sql
grant execute on function can_upload_payment_proof(text) to anon, authenticated, service_role;
