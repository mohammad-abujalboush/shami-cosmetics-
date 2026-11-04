-- =====================================================================
-- Shami Cosmetics — upgrade 07: staff & profile management, customers, activity log
--
--  1. staff_details        owner-only job title / notes per staff member
--  2. profiles.disabled    customer account switch (the real block is the Auth ban set by the Edge Function)
--  3. account_flags        "must change password" (server-enforced: is_staff()/is_owner() are FALSE until changed)
--  4. activity_log         audit trail + triggers on prices, settings, staff, coupons, offers, delivery, products
--  5. RPCs                 my_account_flags, complete_password_change, owner_update_staff, list_staff (extended),
--                          list_customers, customer_detail, activity_feed, + service-role helpers for the Edge Function
--
-- Run ONCE in the SQL Editor, AFTER 01-03 + 02b (fresh install) or after upgrade_06 (existing project). Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables / columns
-- ---------------------------------------------------------------------
create table if not exists staff_details (
  user_id   uuid primary key references staff(user_id) on delete cascade,
  job_title text check (job_title is null or char_length(job_title) <= 100),
  notes     text check (notes is null or char_length(notes) <= 1000)
);
alter table staff_details enable row level security;
drop policy if exists "staff_details: owner only" on staff_details;
create policy "staff_details: owner only" on staff_details for select to authenticated using (is_owner());
-- writes: only through owner_update_staff() / service_role helpers (no INSERT/UPDATE grant)
revoke all on staff_details from anon, authenticated;
grant select on staff_details to authenticated;

alter table profiles add column if not exists disabled boolean not null default false;
-- customers must not be able to flip their own flag: column grants already limit updates to (full_name, phone)

-- Locked table: RLS on, no policy, no grant → only SECURITY DEFINER functions touch it.
create table if not exists account_flags (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  must_change   boolean not null default true,
  pw_snapshot   text,                 -- auth.users.encrypted_password when the temporary password was set
  set_at        timestamptz not null default now()
);
alter table account_flags enable row level security;
revoke all on account_flags from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. is_staff() / is_owner(): false while a forced password change is pending
--    (so RLS itself blocks every admin read/write until the temporary password is replaced)
-- ---------------------------------------------------------------------
create or replace function is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.user_id = auth.uid() and s.active)
     and not exists (select 1 from account_flags f where f.user_id = auth.uid() and f.must_change);
$$;

create or replace function is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.user_id = auth.uid() and s.active and s.role = 'owner')
     and not exists (select 1 from account_flags f where f.user_id = auth.uid() and f.must_change);
$$;

-- ---------------------------------------------------------------------
-- 3. Activity log
-- ---------------------------------------------------------------------
create table if not exists activity_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  actor_id     uuid references auth.users(id) on delete set null,
  category     text not null check (category in ('price', 'settings', 'staff', 'catalog', 'offer', 'coupon', 'delivery', 'customer')),
  action       text not null check (action in ('insert', 'update', 'delete', 'create_staff', 'reset_password', 'change_role',
                                              'activate', 'deactivate', 'edit_staff', 'disable_customer', 'enable_customer', 'promote')),
  entity_type  text not null,
  entity_id    text,
  entity_label text,
  details      jsonb not null default '{}'
);
create index if not exists activity_log_created_idx on activity_log (created_at desc);
create index if not exists activity_log_actor_idx on activity_log (actor_id, created_at desc);
create index if not exists activity_log_category_idx on activity_log (category, created_at desc);
alter table activity_log enable row level security;
drop policy if exists "activity_log: owner read" on activity_log;
create policy "activity_log: owner read" on activity_log for select to authenticated using (is_owner());
revoke all on activity_log from anon, authenticated;
grant select on activity_log to authenticated;

-- Short, safe copy of a jsonb value for the log (long strings truncated).
create or replace function _log_val(v jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select case when jsonb_typeof(v) = 'string' and char_length(v #>> '{}') > 200
              then to_jsonb(left(v #>> '{}', 200) || '…') else v end;
$$;

-- Generic row-change trigger. TG_ARGV: 0 category, 1 entity_type, 2 label column (may be '').
create or replace function log_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_new jsonb; v_old jsonb; v_row jsonb;
  v_changes jsonb := '{}'; k text;
  v_skip text[] := array['updated_at', 'created_at', 'search', 'password', 'used_count'];
  v_label text; v_id text;
begin
  if current_setting('app.skip_log', true) = '1' then return null; end if;   -- caller writes its own log row
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_label := case when coalesce(tg_argv[2], '') <> '' then v_row ->> tg_argv[2] end;
  v_id := coalesce(v_row ->> 'id', v_row ->> 'user_id');
  if tg_op = 'UPDATE' then
    v_new := to_jsonb(new); v_old := to_jsonb(old);
    for k in select jsonb_object_keys(v_new) loop
      if k = any (v_skip) then continue; end if;
      if v_new -> k is distinct from v_old -> k then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', _log_val(v_old -> k), 'to', _log_val(v_new -> k)));
      end if;
    end loop;
    if v_changes = '{}' then return null; end if;
  end if;
  insert into activity_log (actor_id, category, action, entity_type, entity_id, entity_label, details)
  values (auth.uid(), tg_argv[0], lower(tg_op), tg_argv[1], v_id, v_label,
          case when tg_op = 'UPDATE' then jsonb_build_object('changes', v_changes) else '{}'::jsonb end);
  return null;
end $$;

-- Variant price / compare-at / stock-independent changes → category 'price' (label = SKU).
create or replace function log_variant_price()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_changes jsonb := '{}'; v_product text;
begin
  if tg_op = 'UPDATE' then
    if new.price is distinct from old.price then
      v_changes := v_changes || jsonb_build_object('price', jsonb_build_object('from', old.price, 'to', new.price));
    end if;
    if new.compare_at_price is distinct from old.compare_at_price then
      v_changes := v_changes || jsonb_build_object('compare_at_price', jsonb_build_object('from', old.compare_at_price, 'to', new.compare_at_price));
    end if;
    if new.active is distinct from old.active then
      v_changes := v_changes || jsonb_build_object('active', jsonb_build_object('from', old.active, 'to', new.active));
    end if;
    if v_changes = '{}' then return null; end if;
  end if;
  select p.name_ar into v_product from products p where p.id = new.product_id;
  insert into activity_log (actor_id, category, action, entity_type, entity_id, entity_label, details)
  values (auth.uid(), 'price', lower(tg_op), 'variant', new.id::text,
          coalesce(v_product, '') || ' — ' || coalesce(new.label, ''),
          case when tg_op = 'UPDATE' then jsonb_build_object('changes', v_changes)
               else jsonb_build_object('price', new.price) end);
  return null;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('settings',     'settings',  'settings',  ''),
    ('staff',        'staff',     'staff',     ''),
    ('products',     'catalog',   'product',   'name_ar'),
    ('categories',   'catalog',   'category',  'name_ar'),
    ('offers',       'offer',     'offer',     ''),
    ('coupons',      'coupon',    'coupon',    'code'),
    ('governorates', 'delivery',  'governorate', 'name_ar')
  ) as x(tbl, cat, ent, lbl) loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    execute format('drop trigger if exists %I on %I', r.tbl || '_activity_log', r.tbl);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function log_row_change(%L, %L, %L)',
                   r.tbl || '_activity_log', r.tbl, r.cat, r.ent, r.lbl);
  end loop;
end $$;

drop trigger if exists product_variants_activity_log on product_variants;
create trigger product_variants_activity_log after insert or update on product_variants
  for each row execute function log_variant_price();   -- variant deletes are covered by the product's own log

-- ---------------------------------------------------------------------
-- 4. Account flags: read + complete (callable by the signed-in user)
-- ---------------------------------------------------------------------
create or replace function my_account_flags()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('must_change_password',
           coalesce((select f.must_change from account_flags f where f.user_id = auth.uid()), false));
$$;

-- Clears the flag ONLY if the password really changed since the temporary one was set.
create or replace function complete_password_change()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_snap text; v_now text;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHORIZED'; end if;
  select f.pw_snapshot into v_snap from account_flags f where f.user_id = auth.uid() and f.must_change;
  if not found then return jsonb_build_object('ok', true); end if;
  select u.encrypted_password into v_now from auth.users u where u.id = auth.uid();
  if v_now is not distinct from v_snap then raise exception 'PASSWORD_NOT_CHANGED'; end if;
  update account_flags f set must_change = false, pw_snapshot = null where f.user_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 5. Owner actions on staff (SQL side; the Edge Function handles anything touching auth)
-- ---------------------------------------------------------------------
create or replace function owner_update_staff(p_user_id uuid, p_full_name text, p_phone text, p_job_title text, p_notes text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from staff s where s.user_id = p_user_id) then raise exception 'USER_NOT_FOUND'; end if;
  insert into profiles (id, full_name, phone) values (p_user_id, p_full_name, p_phone)
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone;   -- trigger validates name / phone
  insert into staff_details (user_id, job_title, notes)
  values (p_user_id, nullif(btrim(p_job_title), ''), nullif(btrim(p_notes), ''))
  on conflict (user_id) do update set job_title = excluded.job_title, notes = excluded.notes;
  insert into activity_log (actor_id, category, action, entity_type, entity_id, entity_label)
  values (auth.uid(), 'staff', 'edit_staff', 'staff', p_user_id::text, nullif(btrim(p_full_name), ''));
  return jsonb_build_object('user_id', p_user_id);
end $$;

-- Demoting / deactivating the last active owner is refused; owners cannot demote themselves.
create or replace function set_staff_role(p_user_id uuid, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_row staff%rowtype;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_role not in ('owner', 'staff') then raise exception 'INVALID_ROLE'; end if;
  select * into v_row from staff s where s.user_id = p_user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if p_user_id = auth.uid() and p_role <> 'owner' then raise exception 'CANNOT_REMOVE_SELF'; end if;
  if v_row.role = 'owner' and p_role <> 'owner'
     and not exists (select 1 from staff s where s.role = 'owner' and s.active and s.user_id <> p_user_id) then
    raise exception 'LAST_OWNER';
  end if;
  update staff s set role = p_role::staff_role where s.user_id = p_user_id;
  return jsonb_build_object('user_id', p_user_id, 'role', p_role);
end $$;

-- add_staff (promote by email) can no longer demote: role changes go through set_staff_role (last-owner guard).
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
  if exists (select 1 from staff s where s.user_id = v_uid) then
    return set_staff_role(v_uid, v_role) || jsonb_build_object('reactivated', false);
  end if;
  insert into staff (user_id, role, active, created_by) values (v_uid, v_role::staff_role, true, auth.uid());
  return jsonb_build_object('user_id', v_uid, 'role', v_role);
end $$;

-- list_staff now includes phone, job title, notes and the pending-password flag.
create or replace function list_staff()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id', s.user_id, 'email', u.email, 'full_name', p.full_name, 'phone', p.phone,
             'role', s.role, 'active', s.active, 'created_at', s.created_at,
             'job_title', d.job_title, 'notes', d.notes,
             'must_change_password', coalesce(f.must_change, false))
           order by s.role, s.created_at), '[]'::jsonb)
    from staff s
    join auth.users u on u.id = s.user_id
    left join profiles p on p.id = s.user_id
    left join staff_details d on d.user_id = s.user_id
    left join account_flags f on f.user_id = s.user_id
  );
end $$;

-- ---------------------------------------------------------------------
-- 6. Service-role helpers for the Edge Function (callable by service_role ONLY)
-- ---------------------------------------------------------------------
-- Caller check: active owner whose password change is not pending.
create or replace function _is_active_owner(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.user_id = p_uid and s.active and s.role = 'owner')
     and not exists (select 1 from account_flags f where f.user_id = p_uid and f.must_change);
$$;

create or replace function _mark_must_change(p_uid uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  insert into account_flags (user_id, must_change, pw_snapshot, set_at)
  values (p_uid, true, (select u.encrypted_password from auth.users u where u.id = p_uid), now())
  on conflict (user_id) do update
    set must_change = true, pw_snapshot = excluded.pw_snapshot, set_at = now();
end $$;

create or replace function _finish_staff_create(p_uid uuid, p_actor uuid, p_role text, p_full_name text, p_phone text,
                                                p_job_title text, p_notes text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if p_role not in ('owner', 'staff') then raise exception 'INVALID_ROLE'; end if;
  insert into profiles (id, full_name, phone) values (p_uid, p_full_name, p_phone)
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone;   -- trigger validates
  perform set_config('app.skip_log', '1', true);
  insert into staff (user_id, role, active, created_by) values (p_uid, p_role::staff_role, true, p_actor);
  perform set_config('app.skip_log', '', true);
  insert into staff_details (user_id, job_title, notes) values (p_uid, nullif(btrim(p_job_title), ''), nullif(btrim(p_notes), ''));
  perform _mark_must_change(p_uid);
  insert into activity_log (actor_id, category, action, entity_type, entity_id, entity_label, details)
  values (p_actor, 'staff', 'create_staff', 'staff', p_uid::text, p_full_name, jsonb_build_object('role', p_role));
end $$;

create or replace function _log_reset_password(p_uid uuid, p_actor uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from staff s where s.user_id = p_uid) then raise exception 'USER_NOT_FOUND'; end if;
  perform _mark_must_change(p_uid);
  insert into activity_log (actor_id, category, action, entity_type, entity_id, entity_label)
  values (p_actor, 'staff', 'reset_password', 'staff', p_uid::text, (select p.full_name from profiles p where p.id = p_uid));
end $$;

create or replace function _set_customer_disabled(p_uid uuid, p_actor uuid, p_disabled boolean)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if exists (select 1 from staff s where s.user_id = p_uid) then raise exception 'USER_IS_STAFF'; end if;
  update profiles p set disabled = p_disabled where p.id = p_uid;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  insert into activity_log (actor_id, category, action, entity_type, entity_id, entity_label)
  values (p_actor, 'customer', case when p_disabled then 'disable_customer' else 'enable_customer' end, 'customer', p_uid::text,
          (select p.full_name from profiles p where p.id = p_uid));
end $$;

-- ---------------------------------------------------------------------
-- 7. Customers (owner + staff read; disable/enable goes through the Edge Function)
-- ---------------------------------------------------------------------
-- p_kind: 'registered' (accounts) | 'guests' (orders without an account, grouped by phone)
create or replace function list_customers(p_kind text, p_search text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_q   text := normalize_ar(coalesce(btrim(p_search), ''));
  v_ph  text := regexp_replace(western_digits(coalesce(p_search, '')), '\D', '', 'g');
  v_lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer; v_rows jsonb;
begin
  if not is_staff() then raise exception 'NOT_AUTHORIZED'; end if;
  v_ph := regexp_replace(regexp_replace(v_ph, '^(00)?962', ''), '^0', '');

  if p_kind = 'guests' then
    with g as (
      select o.phone,
             (array_agg(o.customer_name order by o.created_at desc))[1] as name,
             count(*)::integer as orders_count,
             coalesce(sum(o.total) filter (where o.status not in ('cancelled', 'returned')), 0) as total_spent,
             max(o.created_at) as last_order_at
      from orders o
      where o.user_id is null
      group by o.phone
    ), f as (
      select * from g
      where v_q = '' and v_ph = ''
         or (v_ph <> '' and g.phone like '%' || v_ph || '%')
         or (v_q <> '' and normalize_ar(g.name) like '%' || v_q || '%')
    )
    select (select count(*) from f)::integer,
           coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      into v_total, v_rows
    from (select * from f order by last_order_at desc limit v_lim offset v_off) x;
  else
    with c as (
      select p.id as user_id, p.full_name as name, p.phone, u.email, p.disabled, p.created_at,
             (select count(*) from orders o where o.user_id = p.id)::integer as orders_count,
             coalesce((select sum(o.total) from orders o where o.user_id = p.id and o.status not in ('cancelled', 'returned')), 0) as total_spent,
             (select max(o.created_at) from orders o where o.user_id = p.id) as last_order_at
      from profiles p
      join auth.users u on u.id = p.id
      where not exists (select 1 from staff s where s.user_id = p.id)
    ), f as (
      select * from c
      where v_q = '' and v_ph = ''
         or (v_ph <> '' and c.phone like '%' || v_ph || '%')
         or (v_q <> '' and (normalize_ar(coalesce(c.name, '')) like '%' || v_q || '%' or lower(c.email) like '%' || lower(btrim(p_search)) || '%'))
    )
    select (select count(*) from f)::integer,
           coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      into v_total, v_rows
    from (select * from f order by last_order_at desc nulls last, created_at desc limit v_lim offset v_off) x;
  end if;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

-- Detail: registered customer (p_user_id) or guest (p_phone). Orders + addresses.
create or replace function customer_detail(p_user_id uuid, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_orders jsonb; v_addr jsonb; v_profile jsonb;
begin
  if not is_staff() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_user_id is not null then
    select to_jsonb(x) into v_profile from (
      select p.id as user_id, p.full_name as name, p.phone, u.email, p.disabled, p.created_at
      from profiles p join auth.users u on u.id = p.id where p.id = p_user_id) x;
    if v_profile is null then raise exception 'USER_NOT_FOUND'; end if;
    select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc), '[]') into v_orders from (
      select id, order_number, status, payment_status, total, created_at from orders where user_id = p_user_id order by created_at desc limit 100) o;
    select coalesce(jsonb_agg(to_jsonb(a)), '[]') into v_addr from (
      select a.id, a.label, a.full_name, a.phone, g.name_ar as governorate_name, a.area, a.details as address_details, a.is_default
      from addresses a join governorates g on g.id = a.governorate_id where a.user_id = p_user_id order by a.is_default desc, a.created_at) a;
  else
    if p_phone is null or p_phone !~ '^9627[789][0-9]{7}$' then raise exception 'INVALID_PHONE'; end if;
    select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc), '[]') into v_orders from (
      select id, order_number, status, payment_status, total, created_at from orders where user_id is null and phone = p_phone order by created_at desc limit 100) o;
    -- guests have no saved addresses: show the distinct delivery addresses used on their orders
    select coalesce(jsonb_agg(to_jsonb(a)), '[]') into v_addr from (
      select distinct o.governorate_name, o.area, o.address_details from orders o where o.user_id is null and o.phone = p_phone) a;
    v_profile := jsonb_build_object('phone', p_phone,
      'name', (select o.customer_name from orders o where o.user_id is null and o.phone = p_phone order by o.created_at desc limit 1));
  end if;
  return jsonb_build_object('profile', v_profile, 'orders', v_orders, 'addresses', v_addr);
end $$;

-- ---------------------------------------------------------------------
-- 8. Activity feed (owner): activity_log + order status/payment history + non-order stock movements
-- ---------------------------------------------------------------------
-- p_category: '' | order | payment | stock | price | settings | staff | catalog | offer | coupon | delivery | customer
create or replace function activity_feed(p_category text, p_actor uuid, p_from timestamptz, p_to timestamptz,
                                         p_search text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_q   text := nullif(btrim(coalesce(p_search, '')), '');
  v_rows jsonb;
begin
  if not is_owner() then raise exception 'NOT_AUTHORIZED'; end if;
  with ev as (
    select 'log-' || l.id as ev_id, l.created_at, l.actor_id, false as by_customer, l.category, l.action,
           l.entity_type, l.entity_label as label, l.details
    from activity_log l
    union all
    select 'ord-' || h.id, h.created_at, h.changed_by, h.by_customer, 'order', 'status', 'order',
           o.order_number, jsonb_build_object('from', h.from_status, 'to', h.to_status, 'note', h.note)
    from order_status_history h join orders o on o.id = h.order_id
    where h.from_status is distinct from h.to_status
    union all
    select 'pay-' || h.id, h.created_at, h.changed_by, h.by_customer, 'payment', 'payment', 'order',
           o.order_number, jsonb_build_object('from', h.payment_from, 'to', h.payment_to, 'note', h.note)
    from order_status_history h join orders o on o.id = h.order_id
    where h.payment_to is not null and h.payment_to is distinct from h.payment_from
    union all
    select 'stk-' || m.id, m.created_at, m.created_by, false, 'stock', m.reason::text, 'variant',
           coalesce(pr.name_ar || ' — ' || pv.label, ''),
           jsonb_build_object('change', m.change, 'balance_after', m.balance_after, 'note', m.note)
    from stock_movements m
    left join product_variants pv on pv.id = m.variant_id
    left join products pr on pr.id = pv.product_id
    where m.reason::text <> 'order'
  )
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_rows from (
    select e.ev_id as id, e.created_at, e.actor_id, e.by_customer, e.category, e.action, e.entity_type,
           coalesce(e.label, (select nullif(btrim(tp.full_name), '') from profiles tp where e.entity_type in ('staff', 'customer') and tp.id::text = e.entity_id)) as label, e.details,
           coalesce(nullif(btrim(p.full_name), ''), u.email) as actor_name
    from ev e
    left join profiles p on p.id = e.actor_id
    left join auth.users u on u.id = e.actor_id
    where (coalesce(p_category, '') = '' or e.category = p_category)
      and (p_actor is null or e.actor_id = p_actor)
      and (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at < p_to)
      and (v_q is null or e.label ilike '%' || v_q || '%' or normalize_ar(coalesce(e.label, '')) like '%' || normalize_ar(v_q) || '%')
    order by e.created_at desc, e.ev_id desc
    limit v_lim offset v_off
  ) x;
  return v_rows;
end $$;

-- ---------------------------------------------------------------------
-- 9. Privileges
-- ---------------------------------------------------------------------
revoke execute on function _log_val(jsonb), log_row_change(), log_variant_price(),
  _is_active_owner(uuid), _mark_must_change(uuid), _finish_staff_create(uuid, uuid, text, text, text, text, text),
  _log_reset_password(uuid, uuid), _set_customer_disabled(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function _is_active_owner(uuid), _mark_must_change(uuid),
  _finish_staff_create(uuid, uuid, text, text, text, text, text), _log_reset_password(uuid, uuid),
  _set_customer_disabled(uuid, uuid, boolean) to service_role;

revoke execute on function my_account_flags(), complete_password_change(), owner_update_staff(uuid, text, text, text, text),
  set_staff_role(uuid, text), list_customers(text, text, integer, integer), customer_detail(uuid, text),
  activity_feed(text, uuid, timestamptz, timestamptz, text, integer, integer) from public, anon;
grant execute on function my_account_flags(), complete_password_change(), owner_update_staff(uuid, text, text, text, text),
  set_staff_role(uuid, text), list_customers(text, text, integer, integer), customer_detail(uuid, text),
  activity_feed(text, uuid, timestamptz, timestamptz, text, integer, integer) to authenticated;
