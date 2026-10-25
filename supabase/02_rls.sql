-- =====================================================================
-- Shami Cosmetics — 02 row level security & privileges
-- Run after 01_schema.sql.
--
-- Principles
--   * RLS is enabled on every table. The browser is untrusted.
--   * Orders, order items, history, stock movements and reviews are written ONLY by
--     SECURITY DEFINER functions (03_functions.sql). Clients get no write privileges on them.
--   * Column privileges hide non-public columns (settings CliQ details) and block direct
--     stock edits (stock changes only through adjust_stock / order functions, always logged).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so policies can call them without recursion)
-- ---------------------------------------------------------------------
create or replace function is_staff()  -- true for active staff AND owners
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.user_id = auth.uid() and s.active);
$$;

create or replace function is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.user_id = auth.uid() and s.active and s.role = 'owner');
$$;

-- Public catalog visibility: product active, category active, at least one active variant.
create or replace function product_is_visible(p_product_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from products p
    join categories c on c.id = p.category_id
    where p.id = p_product_id and p.active and c.active
      and exists (select 1 from product_variants v where v.product_id = p.id and v.active)
  );
$$;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------
alter table settings             enable row level security;
alter table governorates         enable row level security;
alter table categories           enable row level security;
alter table products             enable row level security;
alter table product_images       enable row level security;
alter table product_variants     enable row level security;
alter table offers               enable row level security;
alter table coupons              enable row level security;
alter table profiles             enable row level security;
alter table addresses            enable row level security;
alter table staff                enable row level security;
alter table orders               enable row level security;
alter table order_items          enable row level security;
alter table order_status_history enable row level security;
alter table order_notes          enable row level security;
alter table stock_movements      enable row level security;
alter table reviews              enable row level security;
alter table quiz_questions       enable row level security;
alter table quiz_options         enable row level security;
alter table order_lookup_failures enable row level security;  -- no policies: functions only

-- (TRUNCATE ignores RLS — the privileges section at the end grants it to no API role.)

-- ---------------------------------------------------------------------
-- settings — public columns only; CliQ alias/account name are NOT readable by clients
-- (they are returned by get_order_by_token / track_order for unpaid CliQ orders, and
--  to the owner by get_admin_settings()).
-- ---------------------------------------------------------------------

create policy "settings: public read" on settings
  for select to anon, authenticated using (true);
create policy "settings: owner update" on settings
  for update to authenticated using (is_owner()) with check (is_owner());

-- ---------------------------------------------------------------------
-- governorates — public reads active ones; owner edits fee/active/sort
-- ---------------------------------------------------------------------

create policy "governorates: public read active" on governorates
  for select to anon, authenticated using (active or is_staff());
create policy "governorates: owner update" on governorates
  for update to authenticated using (is_owner()) with check (is_owner());

-- ---------------------------------------------------------------------
-- Catalog — public reads active data; staff read everything; only owner writes
-- ---------------------------------------------------------------------
create policy "categories: public read active" on categories
  for select to anon, authenticated using (active or is_staff());
create policy "categories: owner write" on categories
  for all to authenticated using (is_owner()) with check (is_owner());

create policy "products: public read visible" on products
  for select to anon, authenticated using (product_is_visible(id) or is_staff());
create policy "products: owner write" on products
  for all to authenticated using (is_owner()) with check (is_owner());

create policy "product_images: public read visible" on product_images
  for select to anon, authenticated using (product_is_visible(product_id) or is_staff());
create policy "product_images: owner write" on product_images
  for all to authenticated using (is_owner()) with check (is_owner());

-- stock is not client-updatable (column privileges at the end; adjust_stock / order functions only).

create policy "product_variants: public read active" on product_variants
  for select to anon, authenticated using ((active and product_is_visible(product_id)) or is_staff());
create policy "product_variants: owner write" on product_variants
  for all to authenticated using (is_owner()) with check (is_owner());

-- ---------------------------------------------------------------------
-- Offers — public reads currently running active offers; coupons are owner-only
-- ---------------------------------------------------------------------
create policy "offers: public read running" on offers
  for select to anon, authenticated
  using ((active and now() >= starts_at and now() < ends_at) or is_staff());
create policy "offers: owner write" on offers
  for all to authenticated using (is_owner()) with check (is_owner());

create policy "coupons: owner only" on coupons
  for all to authenticated using (is_owner()) with check (is_owner());

-- ---------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------

create policy "profiles: read own" on profiles
  for select to authenticated using (id = auth.uid() or is_owner());
create policy "profiles: insert own" on profiles
  for insert to authenticated with check (id = auth.uid());
create policy "profiles: update own" on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "addresses: own rows" on addresses
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Staff — users read their own row (admin pages check role on load); owner reads all.
-- Writes only via add_staff / remove_staff.
-- ---------------------------------------------------------------------

create policy "staff: read own or owner" on staff
  for select to authenticated using (user_id = auth.uid() or is_owner());

-- ---------------------------------------------------------------------
-- Orders — customers read their own; staff read all; writes via functions only
-- ---------------------------------------------------------------------

create policy "orders: read own or staff" on orders
  for select to authenticated using (user_id = auth.uid() or is_staff());

create policy "order_items: read own or staff" on order_items
  for select to authenticated
  using (is_staff() or exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid()));

-- History notes can be internal: staff only. Customers get a sanitized timeline from
-- get_order_by_token / track_order.
create policy "order_status_history: staff read" on order_status_history
  for select to authenticated using (is_staff());

create policy "order_notes: staff read" on order_notes
  for select to authenticated using (is_staff());
create policy "order_notes: staff add" on order_notes
  for insert to authenticated with check (is_staff() and created_by = auth.uid());
create policy "order_notes: author or owner delete" on order_notes
  for delete to authenticated using (is_staff() and (created_by = auth.uid() or is_owner()));

create policy "stock_movements: staff read" on stock_movements
  for select to authenticated using (is_staff());

-- ---------------------------------------------------------------------
-- Reviews — public reads approved; staff moderate (status / featured); owner deletes.
-- Inserted only through submit_review().
-- ---------------------------------------------------------------------

create policy "reviews: public read approved" on reviews
  for select to anon, authenticated using (status = 'approved' or is_staff());
create policy "reviews: staff moderate" on reviews
  for update to authenticated using (is_staff()) with check (is_staff());
create policy "reviews: owner delete" on reviews
  for delete to authenticated using (is_owner());

-- ---------------------------------------------------------------------
-- Quiz — public reads active questions and their options; owner edits
-- ---------------------------------------------------------------------
create policy "quiz_questions: public read active" on quiz_questions
  for select to anon, authenticated using (active or is_staff());
create policy "quiz_questions: owner write" on quiz_questions
  for all to authenticated using (is_owner()) with check (is_owner());

create policy "quiz_options: public read active" on quiz_options
  for select to anon, authenticated
  using (is_staff() or exists (select 1 from quiz_questions q where q.id = question_id and q.active));
create policy "quiz_options: owner write" on quiz_options
  for all to authenticated using (is_owner()) with check (is_owner());

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
                offers, reviews, quiz_questions, quiz_options, catalog_products
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
