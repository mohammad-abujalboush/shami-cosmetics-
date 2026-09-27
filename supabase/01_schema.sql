-- =====================================================================
-- Shami Cosmetics — 01 schema
-- Tables, enums, constraints, indexes, triggers, seed data.
-- Run first, once, on a fresh Supabase project.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- Nothing we create is granted to the API roles automatically; every grant is explicit
-- (see the grants sections at the end of 02, 03, 04 and the standalone 02b_grants.sql).
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type gender_t       as enum ('men', 'women', 'unisex');
create type order_status   as enum ('new', 'confirmed', 'with_courier', 'delivered', 'cancelled', 'returned');
create type payment_status as enum ('unpaid', 'awaiting_transfer', 'awaiting_verification', 'paid', 'refunded');
create type payment_method as enum ('cod', 'cliq');
create type staff_role     as enum ('owner', 'staff');
create type coupon_type    as enum ('percent', 'fixed');
create type stock_reason   as enum ('order', 'cancel', 'return', 'manual');
create type review_status  as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------
-- Text helpers (immutable; mirrored in /assets/js/utils.js)
-- ---------------------------------------------------------------------

-- Arabic-Indic and Persian digits → 0-9, Arabic decimal separator → '.', Arabic thousands separator removed.
-- Mirrors toWesternDigits().
create or replace function western_digits(input text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.translate(coalesce(input, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫٬', '01234567890123456789.');
$$;

-- Mirrors normalizeArabic() exactly: digits → lower → strip tashkeel → strip tatweel →
-- أ/إ/آ→ا, ة→ه, ى→ي, ؤ→و, ئ→ي → collapse whitespace (JS \s set) → trim.
create or replace function normalize_ar(input text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        pg_catalog.regexp_replace(
          pg_catalog.lower(public.western_digits(input)),
          '[ؐ-ًؚ-ٰٟۖ-ۭ]', '', 'g'),
        'أإآةىؤئـ', 'اااهيوي'),
      '[\s   -     　﻿]+', ' ', 'g'),
    ' ');
$$;

-- Wrapper so the generated search column only calls immutable functions
-- (array_to_string / concat_ws are only STABLE on their own).
create or replace function product_search_text(name_ar text, name_en text, tags text[])
returns text language sql immutable parallel safe set search_path = '' as $$
  select public.normalize_ar(pg_catalog.concat_ws(' ', name_ar, name_en, pg_catalog.array_to_string(tags, ' ')));
$$;

-- Jordan mobile → '9627XXXXXXXX' or NULL. Mirrors normalizePhone().
create or replace function normalize_phone(input text)
returns text language plpgsql immutable parallel safe set search_path = '' as $$
declare
  d text := pg_catalog.regexp_replace(public.western_digits(input), '[-\s().]', '', 'g');
begin
  if d like '+%' then d := substr(d, 2); end if;
  if d like '00%' then d := substr(d, 3); end if;
  if d like '962%' then d := substr(d, 4); end if;
  if d like '0%' then d := substr(d, 2); end if;
  if d ~ '^7[789][0-9]{7}$' then return '962' || d; end if;
  return null;
end $$;

-- Trim + collapse whitespace (JS \s set). Mirrors normalizeName().
create or replace function normalize_person_name(input text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(input, ''),
    '[\s   -     　﻿]+', ' ', 'g'));
$$;

-- Customer names: Arabic or Latin letters (incl. accents, tashkeel), spaces, hyphens, apostrophes;
-- 2–60 characters after normalizing; at least one letter. Mirrors isValidName().
create or replace function is_valid_person_name(input text)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.char_length(n) between 2 and 60
     and n ~ '^[A-Za-zÀ-ÖØ-öø-ɏء-غـ-ٰٟ-ۓ ''’-]+$'
     and n ~ '[A-Za-zÀ-ÖØ-öø-ɏء-غف-يٱ-ۓ]'
  from (select public.normalize_person_name(input) as n) s;
$$;

create or replace function slugify(input text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g'), '-');
$$;

-- Lowercase, trimmed, de-duplicated, sorted tags.
create or replace function normalize_tags(input text[])
returns text[] language sql immutable parallel safe set search_path = '' as $$
  select coalesce(array_agg(distinct t order by t), '{}'::text[])
  from (select pg_catalog.lower(pg_catalog.btrim(x)) as t from unnest(input) as x) s
  where t <> '';
$$;

create or replace function set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------
create table settings (
  id                      boolean primary key default true check (id),
  store_whatsapp          text check (store_whatsapp is null or store_whatsapp ~ '^[0-9]{8,15}$'),
  cliq_alias              text,
  cliq_account_name       text,
  cliq_window_hours       integer not null default 24 check (cliq_window_hours between 1 and 720),
  free_delivery_threshold numeric(10,3) check (free_delivery_threshold is null or free_delivery_threshold >= 0),
  top_bar_messages        text[] not null default '{}',
  -- [{ "label_ar": "…", "value": "…", "show": true }, …]
  homepage_stats          jsonb not null default '[]' check (jsonb_typeof(homepage_stats) = 'array'),
  return_policy_ar        text,
  -- { "instagram": "https://…", "facebook": "https://…", "tiktok": "https://…", "snapchat": "https://…" }
  social_links            jsonb not null default '{}' check (jsonb_typeof(social_links) = 'object'),
  store_open              boolean not null default true,
  updated_at              timestamptz not null default now()
);

create or replace function settings_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.store_whatsapp is not null then
    new.store_whatsapp := coalesce(
      normalize_phone(new.store_whatsapp),
      nullif(regexp_replace(western_digits(new.store_whatsapp), '[^0-9]', '', 'g'), ''));
  end if;
  new.cliq_alias := nullif(btrim(new.cliq_alias), '');
  new.cliq_account_name := nullif(btrim(new.cliq_account_name), '');
  return new;
end $$;
create trigger settings_before_write before insert or update on settings
  for each row execute function settings_before_write();

-- ---------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------
create table governorates (
  id           smallint primary key,
  name_ar      text not null unique,
  delivery_fee numeric(10,3) not null default 0 check (delivery_fee >= 0),
  active       boolean not null default true,
  sort         integer not null default 0,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------
create table categories (
  id             bigint generated always as identity primary key,
  key            text unique,  -- stable system key used by code (quiz uses 'soap'); never shown
  slug           text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_ar        text not null check (btrim(name_ar) <> ''),
  name_en        text,
  description_ar text,
  sort           integer not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table products (
  id             bigint generated always as identity (start with 1001) primary key,
  category_id    bigint not null references categories(id) on delete restrict,
  slug           text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name_ar        text not null check (btrim(name_ar) <> ''),
  name_en        text,
  description_ar text not null check (btrim(description_ar) <> ''),
  gender         gender_t,
  tags           text[] not null default '{}',
  is_bestseller  boolean not null default false,
  active         boolean not null default false,
  sort           integer not null default 0,
  search         text generated always as (product_search_text(name_ar, name_en, tags)) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index products_category_idx on products (category_id, sort);
create index products_search_trgm_idx on products using gin (search extensions.gin_trgm_ops);

create table product_images (
  id         bigint generated always as identity primary key,
  product_id bigint not null references products(id) on delete cascade,
  path       text not null,  -- object path inside the product-images bucket
  alt_ar     text,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create index product_images_product_idx on product_images (product_id, sort);

create table product_variants (
  id                  bigint generated always as identity primary key,
  product_id          bigint not null references products(id) on delete cascade,
  label               text not null check (btrim(label) <> ''),
  sku                 text unique,
  price               numeric(10,3) not null check (price > 0),
  compare_at_price    numeric(10,3) check (compare_at_price is null or compare_at_price > 0),  -- UI shows strikethrough only when > price
  stock               integer not null default 0 check (stock >= 0),
  low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0),
  active              boolean not null default true,
  sort                integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index product_variants_product_idx on product_variants (product_id, sort);

-- Slug: admin-editable; auto from name_en, else p-<id>. Never raw Arabic.
create or replace function products_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  new.tags := normalize_tags(new.tags);
  new.name_en := nullif(btrim(new.name_en), '');
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := nullif(slugify(new.name_en), '');
    if new.slug is null then
      new.slug := 'p-' || new.id;
    elsif exists (select 1 from products p where p.slug = new.slug and p.id <> new.id) then
      new.slug := new.slug || '-' || new.id;
    end if;
  else
    new.slug := slugify(new.slug);
    if new.slug = '' then raise exception 'INVALID_SLUG'; end if;
  end if;
  return new;
end $$;
create trigger products_before_write before insert or update on products
  for each row execute function products_before_write();

create or replace function categories_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  new.name_en := nullif(btrim(new.name_en), '');
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := coalesce(nullif(slugify(new.name_en), ''), 'c-' || new.id);
  else
    new.slug := slugify(new.slug);
    if new.slug = '' then raise exception 'INVALID_SLUG'; end if;
  end if;
  return new;
end $$;
create trigger categories_before_write before insert or update on categories
  for each row execute function categories_before_write();

-- ---------------------------------------------------------------------
-- Offers & coupons
-- ---------------------------------------------------------------------
create table offers (
  id             bigint generated always as identity primary key,
  name_ar        text not null check (btrim(name_ar) <> ''),
  description_ar text,
  category_id    bigint not null references categories(id) on delete cascade,
  quantity       integer not null check (quantity >= 2),
  bundle_price   numeric(10,3) not null check (bundle_price > 0),
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  active         boolean not null default true,
  show_countdown boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Only one active bundle offer per category at any moment.
  constraint offers_one_active_per_category
    exclude using gist (category_id with =, tstzrange(starts_at, ends_at) with &&) where (active)
);

create table coupons (
  id                     bigint generated always as identity primary key,
  code                   text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),  -- stored uppercase
  type                   coupon_type not null,
  value                  numeric(10,3) not null check (value > 0),
  max_discount           numeric(10,3) check (max_discount is null or max_discount > 0),  -- percent coupons only
  min_order              numeric(10,3) not null default 0 check (min_order >= 0),
  max_uses               integer check (max_uses is null or max_uses > 0),
  used_count             integer not null default 0 check (used_count >= 0),
  max_per_phone          integer check (max_per_phone is null or max_per_phone > 0),
  starts_at              timestamptz,
  ends_at                timestamptz,
  combinable_with_offers boolean not null default true,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (type <> 'percent' or value <= 100),
  check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create or replace function coupons_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  new.code := upper(btrim(western_digits(new.code)));
  return new;
end $$;
create trigger coupons_before_write before insert or update on coupons
  for each row execute function coupons_before_write();

-- ---------------------------------------------------------------------
-- Customers & staff
-- ---------------------------------------------------------------------
create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text check (full_name is null or char_length(full_name) <= 100),
  phone      text check (phone is null or phone ~ '^9627[789][0-9]{7}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
create trigger profiles_before_write before insert or update on profiles
  for each row execute function profiles_before_write();

create table addresses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  label          text check (label is null or char_length(label) <= 40),
  full_name      text not null check (char_length(btrim(full_name)) between 2 and 80),
  phone          text not null check (phone ~ '^9627[789][0-9]{7}$'),
  governorate_id smallint not null references governorates(id),
  area           text not null check (char_length(btrim(area)) between 2 and 80),
  details        text not null check (char_length(btrim(details)) between 3 and 300),
  is_default     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index addresses_user_idx on addresses (user_id);
create unique index addresses_one_default_idx on addresses (user_id) where is_default;

-- Normalizes phone; first address becomes default; setting a default clears the previous one.
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
create trigger addresses_before_write before insert or update on addresses
  for each row execute function addresses_before_write();

create table staff (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       staff_role not null default 'staff',
  active     boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
create sequence order_number_seq start with 10001;

create table orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text not null unique default ('SH-' || nextval('order_number_seq')),
  public_token         uuid not null unique default gen_random_uuid(),
  user_id              uuid references auth.users(id) on delete set null,
  customer_name        text not null,
  phone                text not null check (phone ~ '^9627[789][0-9]{7}$'),
  governorate_id       smallint not null references governorates(id),
  governorate_name     text not null,  -- snapshot
  area                 text not null,
  address_details      text not null,
  notes                text,
  payment_method       payment_method not null,
  payment_status       payment_status not null,
  status               order_status not null default 'new',
  subtotal             numeric(10,3) not null check (subtotal >= 0),
  bundle_discount      numeric(10,3) not null default 0 check (bundle_discount >= 0),
  coupon_id            bigint references coupons(id) on delete set null,
  coupon_code          text,
  coupon_discount      numeric(10,3) not null default 0 check (coupon_discount >= 0),
  delivery_fee         numeric(10,3) not null default 0 check (delivery_fee >= 0),
  total                numeric(10,3) not null check (total >= 0),
  applied_offers       jsonb not null default '[]',  -- snapshot of bundle offers applied
  payment_reference    text,
  payment_proof_path   text,  -- object path inside the payment-proofs bucket
  payment_submitted_at timestamptz,
  paid_at              timestamptz,
  payment_verified_by  uuid references auth.users(id) on delete set null,
  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index orders_phone_created_idx on orders (phone, created_at desc);
create index orders_user_created_idx on orders (user_id, created_at desc);
create index orders_status_created_idx on orders (status, created_at desc);
create index orders_created_idx on orders (created_at desc);
create index orders_cliq_pending_idx on orders (created_at)
  where payment_method = 'cliq' and payment_status in ('awaiting_transfer', 'awaiting_verification');
create index orders_coupon_phone_idx on orders (coupon_id, phone) where coupon_id is not null;

create table order_items (
  id              bigint generated always as identity primary key,
  order_id        uuid not null references orders(id) on delete cascade,
  variant_id      bigint references product_variants(id) on delete set null,
  product_id      bigint references products(id) on delete set null,
  product_name_ar text not null,  -- snapshots: never change retroactively
  product_name_en text,
  variant_label   text not null,
  sku             text,
  unit_price      numeric(10,3) not null check (unit_price >= 0),
  quantity        integer not null check (quantity > 0),
  line_total      numeric(10,3) not null check (line_total >= 0)
);
create index order_items_order_idx on order_items (order_id);
create index order_items_product_idx on order_items (product_id);

create table order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  from_status order_status,  -- NULL for the creation entry
  to_status   order_status not null,
  note        text,
  changed_by  uuid references auth.users(id) on delete set null,
  by_customer boolean not null default false,
  created_at  timestamptz not null default now()
);
create index order_status_history_order_idx on order_status_history (order_id, created_at);

-- Internal staff notes (kept out of orders so customers can never read them).
create table order_notes (
  id         bigint generated always as identity primary key,
  order_id   uuid not null references orders(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 2000),
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index order_notes_order_idx on order_notes (order_id, created_at);

-- ---------------------------------------------------------------------
-- Stock movements — written ONLY by the trigger below, so no stock change can skip the log.
-- RPCs set transaction-local context (app.stock_reason / app.stock_order_id / app.stock_note).
-- ---------------------------------------------------------------------
create table stock_movements (
  id            bigint generated always as identity primary key,
  variant_id    bigint references product_variants(id) on delete set null,
  change        integer not null check (change <> 0),
  balance_after integer not null,
  reason        stock_reason not null,
  order_id      uuid references orders(id) on delete set null,
  note          text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index stock_movements_variant_idx on stock_movements (variant_id, created_at desc);
create index stock_movements_created_idx on stock_movements (created_at desc);

create or replace function log_stock_movement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_change integer;
begin
  if tg_op = 'INSERT' then
    v_change := new.stock;
  else
    v_change := new.stock - old.stock;
  end if;
  if v_change = 0 then
    return null;
  end if;
  insert into stock_movements (variant_id, change, balance_after, reason, order_id, note, created_by)
  values (
    new.id, v_change, new.stock,
    coalesce(nullif(current_setting('app.stock_reason', true), ''), 'manual')::stock_reason,
    nullif(current_setting('app.stock_order_id', true), '')::uuid,
    nullif(current_setting('app.stock_note', true), ''),
    auth.uid());
  return null;
end $$;
create trigger product_variants_stock_log after insert or update of stock on product_variants
  for each row execute function log_stock_movement();

-- ---------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------
create table reviews (
  id               bigint generated always as identity primary key,
  order_id         uuid not null unique references orders(id) on delete cascade,  -- one per order
  rating           smallint not null check (rating between 1 and 5),
  body             text check (body is null or char_length(body) <= 1000),
  display_name     text not null,  -- first name only
  governorate_name text,
  status           review_status not null default 'pending',
  featured         boolean not null default false,
  moderated_by     uuid references auth.users(id) on delete set null,
  moderated_at     timestamptz,
  created_at       timestamptz not null default now(),
  check (not featured or status = 'approved')
);
create index reviews_public_idx on reviews (status, featured, created_at desc);

create or replace function reviews_before_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status <> 'approved' then new.featured := false; end if;
  if new.status is distinct from old.status or new.featured is distinct from old.featured then
    new.moderated_by := auth.uid();
    new.moderated_at := now();
  end if;
  return new;
end $$;
create trigger reviews_before_update before update on reviews
  for each row execute function reviews_before_update();

-- ---------------------------------------------------------------------
-- Skin quiz (admin-editable; content is created by the owner, not seeded)
-- ---------------------------------------------------------------------
create table quiz_questions (
  id          bigint generated always as identity primary key,
  question_ar text not null check (btrim(question_ar) <> ''),
  sort        integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table quiz_options (
  id          bigint generated always as identity primary key,
  question_id bigint not null references quiz_questions(id) on delete cascade,
  label_ar    text not null check (btrim(label_ar) <> ''),
  tags        text[] not null default '{}',
  sort        integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index quiz_options_question_idx on quiz_options (question_id, sort);

create or replace function quiz_options_before_write()
returns trigger language plpgsql set search_path = public as $$
begin
  new.tags := normalize_tags(new.tags);
  return new;
end $$;
create trigger quiz_options_before_write before insert or update on quiz_options
  for each row execute function quiz_options_before_write();

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'settings', 'governorates', 'categories', 'products', 'product_variants', 'offers', 'coupons',
    'profiles', 'addresses', 'orders', 'quiz_questions', 'quiz_options'
  ] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Seed data (no invented values: fees 0, settings empty)
-- ---------------------------------------------------------------------
insert into settings (id) values (true);

insert into governorates (id, name_ar, sort) values
  (1,  'عمّان',   1),
  (2,  'إربد',    2),
  (3,  'الزرقاء', 3),
  (4,  'البلقاء', 4),
  (5,  'مادبا',   5),
  (6,  'جرش',     6),
  (7,  'عجلون',   7),
  (8,  'المفرق',  8),
  (9,  'الكرك',   9),
  (10, 'الطفيلة', 10),
  (11, 'معان',    11),
  (12, 'العقبة',  12);

insert into categories (key, slug, name_ar, name_en, sort) values
  ('soap',           'soap',           'صابون الشامي',      null,             1),
  ('twins_perfumes', 'twins-perfumes', 'عطور TWINS',        'TWINS Perfumes', 2),
  ('twins_unity',    'twins-unity',    'TWINS UNITY',       'TWINS UNITY',    3),
  ('gift_boxes',     'gift-boxes',     'البوكسات والهدايا', null,             4);
