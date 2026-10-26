# Database tests

These SQL tests prove the security and pricing rules in `01`–`04` hold. Run them in the Supabase **SQL Editor** after the setup files:
- **Fresh install:** `01` → `02` → `03` → `04` → `05`.
- **Existing project:** apply every `upgrade_*.sql` it hasn't had yet, in order, then `02b_grants.sql` once at the end. (`upgrade_01_names.sql`, then `upgrade_02_refunds_lookups_proofs.sql`.)
- The tests never assume tables are empty. They work with real data or the dev seed (`06_dev_seed.sql`) installed. Fixture coupon codes start with `T9-`, and fixture rows use fixed ids 900001+.

- **Step 0** installs a small `test` schema (helpers and fixtures). **Step 99** removes it.
- Every test block runs inside `begin; … rollback;`, so **nothing it does is kept**.
- **Pass:** the block finishes with *Success*. **Fail:** it stops with a red error starting `FAIL:` that says what broke. If you run the blocks through `psql`, every passing check also prints a `NOTICE: PASS: …` line.
- Test rows use ids 900001+ and phone numbers 0790000xxx, so they never collide with real data.
- Tests switch identity with `test.login(uuid)`, which sets the same role and JWT claims PostgREST would. `null` means a guest (`anon`).

| Test user | uuid |
|---|---|
| owner | `00000000-0000-0000-0000-00000000000a` |
| staff | `00000000-0000-0000-0000-00000000000b` |
| customer | `00000000-0000-0000-0000-00000000000c` |

---

## 0. Install test helpers (run once)

```sql
create schema if not exists test;

-- Switch identity like PostgREST does. null = guest (anon).
create or replace function test.login(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
end $$;

create or replace function test.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL: %', p_msg; end if;
  raise notice 'PASS: %', p_msg;
end $$;

-- Statement must raise exactly this error code (the RAISE EXCEPTION message).
create or replace function test.expect_error(p_sql text, p_code text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL: expected % but it succeeded: %', p_code, p_sql;
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  if sqlerrm <> p_code then raise exception 'FAIL: expected %, got "%" (%) for: %', p_code, sqlerrm, sqlstate, p_sql; end if;
  raise notice 'PASS: % → %', p_sql, p_code;
end $$;

-- Statement must RETURN {"error": "<code>"} (track_order / cancel_own_order keep failed attempts, so they don't raise).
create or replace function test.expect_result_error(p_sql text, p_code text) returns void language plpgsql as $$
declare v jsonb;
begin
  execute p_sql into v;
  if v ->> 'error' is distinct from p_code then
    raise exception 'FAIL: expected result {"error": "%"}, got % for: %', p_code, left(coalesce(v::text, 'null'), 120), p_sql;
  end if;
  raise notice 'PASS: % → {"error": "%"}', p_sql, p_code;
end $$;

-- Statement must fail with this SQLSTATE (42501 = permission denied / RLS violation).
create or replace function test.expect_sqlstate(p_sql text, p_state text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL: expected SQLSTATE % but it succeeded: %', p_state, p_sql;
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  if sqlstate <> p_state then raise exception 'FAIL: expected SQLSTATE %, got % "%" for: %', p_state, sqlstate, sqlerrm, p_sql; end if;
  raise notice 'PASS: % → SQLSTATE %', p_sql, p_state;
end $$;

-- Statement must affect / return exactly this many rows.
create or replace function test.expect_rows(p_sql text, p_rows integer) returns void language plpgsql as $$
declare n integer;
begin
  execute p_sql;
  get diagnostics n = row_count;
  if n <> p_rows then raise exception 'FAIL: expected % rows, got % for: %', p_rows, n, p_sql; end if;
  raise notice 'PASS: % → % rows', p_sql, p_rows;
end $$;

create or replace function test.payload(p_items jsonb, p_phone text, p_method text default 'cod',
                                        p_coupon text default null, p_gov integer default 1)
returns jsonb language sql as $$
  select jsonb_build_object(
    'items', p_items, 'customer_name', 'عميلة اختبار', 'phone', p_phone, 'governorate_id', p_gov,
    'area', 'الجبيهة', 'address_details', 'شارع الاختبار، بناية 1',
    'payment_method', p_method, 'coupon_code', p_coupon);
$$;

-- Fixture data. Call as postgres at the start of a test transaction (it is rolled back with it).
create or replace function test.fixture() returns void language plpgsql as $$
declare
  v_soap bigint := (select id from public.categories where key = 'soap');
  v_perf bigint := (select id from public.categories where key = 'twins_perfumes');
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-00000000000a', 'owner@test.local', '{}'),
    ('00000000-0000-0000-0000-00000000000b', 'staff@test.local', '{}'),
    ('00000000-0000-0000-0000-00000000000c', 'customer@test.local',
     '{"full_name": "عميلة اختبار", "phone": "٠٧٩٠٠٠٠٠٩٩"}');
  insert into public.staff (user_id, role) values
    ('00000000-0000-0000-0000-00000000000a', 'owner'),
    ('00000000-0000-0000-0000-00000000000b', 'staff');

  update public.settings set store_open = true, cliq_alias = 'SHAMITEST', cliq_account_name = 'Shami Test',
                             free_delivery_threshold = null;
  update public.governorates set delivery_fee = 3, active = true where id = 1;
  update public.governorates set active = false where id = 12;
  update public.offers set active = false where category_id in (v_soap, v_perf);

  insert into public.products (id, category_id, slug, name_ar, name_en, description_ar, tags, active)
  overriding system value values
    (900001, v_soap, 'test-soap-a',   'صابون اختبار أ', null,           'وصف', '{sensitive,dry}', true),
    (900002, v_soap, 'test-soap-b',   'صابون اختبار ب', null,           'وصف', '{oily,Acne}',     true),
    (900003, v_perf, 'test-perfume',  'عطر اختبار',     'Test Perfume', 'وصف', '{}',              true),
    (900004, v_soap, 'test-inactive', 'منتج مخفي',      null,           'وصف', '{oily}',          false),
    (900005, v_soap, 'test-novar',    'بدون أحجام',     null,           'وصف', '{oily}',          true);
  insert into public.product_variants (id, product_id, label, sku, price, stock, active)
  overriding system value values
    (900011, 900001, 'قطعة',     'T-SA',   5,  100, true),
    (900012, 900002, 'قطعة',     'T-SB',   4,  100, true),
    (900013, 900002, 'حجم صغير', 'T-SB-S', 3,  1,   true),
    (900014, 900003, '50ml',     'T-P50',  20, 10,  true),
    (900015, 900003, '100ml',    'T-P100', 30, 5,   false),
    (900016, 900005, 'قطعة',     'T-NV',   2,  5,   false);

  insert into public.offers (id, name_ar, category_id, quantity, bundle_price, starts_at, ends_at)
  overriding system value
  values (900001, '3 صابونات بـ10', v_soap, 3, 10, now() - interval '1 day', now() + interval '1 day');

  insert into public.coupons (code, type, value, min_order, max_uses, used_count, max_per_phone,
                              starts_at, ends_at, combinable_with_offers, active, max_discount) values
    ('t9-test10',  'percent', 10,  0,  null, 0, null, null, null, true,  true,  null),  -- stored as T9-TEST10
    ('T9-FIXED5',  'fixed',   5,   50, null, 0, null, null, null, true,  true,  null),
    ('T9-ONCE',    'fixed',   1,   0,  1,    1, null, null, null, true,  true,  null),
    ('T9-ONE',     'fixed',   1,   0,  1,    0, null, null, null, true,  true,  null),
    ('T9-PHONE1',  'fixed',   1,   0,  null, 0, 1,    null, null, true,  true,  null),
    ('T9-OLD',     'fixed',   1,   0,  null, 0, null, now() - interval '2 days', now() - interval '1 day', true, true, null),
    ('T9-SOON',    'fixed',   1,   0,  null, 0, null, now() + interval '1 day', null, true, true, null),
    ('T9-OFF',     'fixed',   1,   0,  null, 0, null, null, null, true,  false, null),
    ('T9-NOCOMBO', 'percent', 10,  0,  null, 0, null, null, null, false, true,  null),
    ('T9-BIG50',   'percent', 50,  0,  null, 0, null, null, null, true,  true,  3),
    ('T9-HUGE',    'fixed',   100, 0,  null, 0, null, null, null, true,  true,  null);
end $$;

grant usage on schema test to anon, authenticated;
grant execute on all functions in schema test to anon, authenticated;
```

---

## 1. Price tampering is impossible

The client sends only `variant_id` + `qty`. Any price or total fields it adds are ignored, bad quantities are rejected, and direct writes are blocked.

```sql
begin;
select test.fixture();
select test.login(null);  -- guest

do $$
declare r jsonb;
begin
  r := calculate_cart('[{"variant_id":900011,"qty":2,"price":0.001,"unit_price":0,"line_total":0}]', 1);
  perform test.assert((r->>'subtotal')::numeric = 10, 'calculate_cart uses the database price (2 × 5 = 10)');
  perform test.assert((r->>'total')::numeric = 13, 'calculate_cart total = 10 + 3 delivery');

  r := place_order(test.payload('[{"variant_id":900011,"qty":2,"price":0.001}]', '0790000001')
                   || '{"subtotal":0,"total":0.5,"delivery_fee":0,"bundle_discount":99,"coupon_discount":99}');
  perform test.assert((r->>'total')::numeric = 13, 'place_order ignores client-sent prices and totals');
  perform set_config('test.token', r->>'public_token', true);
end $$;

select test.expect_error($$select calculate_cart('[{"variant_id":900011,"qty":-1}]')$$, 'INVALID_CART');
select test.expect_error($$select calculate_cart('[{"variant_id":900011,"qty":1.5}]')$$, 'INVALID_CART');
select test.expect_error($$select calculate_cart('[{"variant_id":900011,"qty":0}]')$$, 'INVALID_CART');
select test.expect_error($$select calculate_cart('[{"variant_id":"abc","qty":1}]')$$, 'INVALID_CART');
select test.expect_error($$select calculate_cart('{"variant_id":900011}')$$, 'INVALID_CART');
select test.expect_error($$select calculate_cart('[]')$$, 'EMPTY_CART');
select test.expect_error($$select calculate_cart('[{"variant_id":900011,"qty":999},{"variant_id":900011,"qty":999}]')$$, 'INVALID_CART');

-- Guests have no write access to orders or prices at all
select test.expect_sqlstate($$insert into orders (customer_name) values ('x')$$, '42501');
select test.expect_sqlstate($$update orders set total = 0$$, '42501');
select test.expect_sqlstate($$insert into order_items (order_id) values (gen_random_uuid())$$, '42501');
select test.expect_sqlstate($$update product_variants set price = 0.001 where id = 900011$$, '42501');
select test.expect_sqlstate($$select 1 from orders$$, '42501');

-- A signed-in customer can't change prices or stock either
select test.login('00000000-0000-0000-0000-00000000000c');
select test.expect_rows($$update product_variants set price = 0.001 where id = 900011$$, 0);
select test.expect_sqlstate($$update product_variants set stock = 99999 where id = 900011$$, '42501');
select test.expect_rows($$update products set active = false where id = 900001$$, 0);

reset role;
do $$
begin
  perform test.assert((select price from product_variants where id = 900011) = 5, 'variant price unchanged');
  perform test.assert((select total from orders where public_token = current_setting('test.token')::uuid) = 13,
                      'stored order total = 13');
  perform test.assert((select i.unit_price from order_items i join orders o on o.id = i.order_id
                       where o.public_token = current_setting('test.token')::uuid) = 5,
                      'stored unit price snapshot = 5');
end $$;
rollback;
```

---

## 2. Stock can't go negative

### 2a. One session (last unit, oversell, logging, CHECK constraint)

```sql
begin;
select test.fixture();
select test.login(null);

do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900013,"qty":1}]', '0790000011'));
  perform test.assert(r->>'order_number' like 'SH-%', 'first order takes the last unit');
end $$;

select test.expect_error($$select place_order(test.payload('[{"variant_id":900013,"qty":1}]', '0790000012'))$$, 'OUT_OF_STOCK');
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":101}]', '0790000013'))$$, 'INSUFFICIENT_STOCK');
select test.expect_error($$select place_order(test.payload('[{"variant_id":900015,"qty":1}]', '0790000014'))$$, 'VARIANT_INACTIVE');
select test.expect_error($$select place_order(test.payload('[{"variant_id":123456789,"qty":1}]', '0790000015'))$$, 'VARIANT_NOT_FOUND');

do $$
declare r jsonb;
begin
  r := calculate_cart('[{"variant_id":900013,"qty":1},{"variant_id":900011,"qty":1}]', 1);
  perform test.assert((r->>'has_errors')::boolean, 'cart reports has_errors');
  perform test.assert((select l->>'error' from jsonb_array_elements(r->'items') l
                       where (l->>'variant_id')::bigint = 900013) = 'OUT_OF_STOCK', 'sold-out line flagged OUT_OF_STOCK');
  perform test.assert((r->>'subtotal')::numeric = 5, 'sold-out line excluded from the subtotal');
end $$;

reset role;
do $$
begin
  perform test.assert((select stock from product_variants where id = 900013) = 0, 'stock is 0, not negative');
  perform test.assert(exists (select 1 from stock_movements
                              where variant_id = 900013 and change = -1 and reason = 'order' and order_id is not null),
                      'order stock movement logged');
end $$;
select test.expect_sqlstate($$update product_variants set stock = -1 where id = 900013$$, '23514');
rollback;
```

### 2b. Two simultaneous orders (two psql sessions)

The SQL Editor can't hold two open transactions at once, so this one needs two `psql` terminals. Get the connection string from Dashboard → **Connect** → *Session pooler*.

```sql
-- MANUAL — setup (any session, committed)
insert into products (id, category_id, slug, name_ar, description_ar, active) overriding system value
values (900101, (select id from categories where key = 'soap'), 'race-test', 'اختبار التزامن', 'وصف', true);
insert into product_variants (id, product_id, label, price, stock) overriding system value
values (900111, 900101, 'قطعة', 5, 1);
update governorates set active = true where id = 1;
update settings set store_open = true;
```

```sql
-- MANUAL — session A
begin;
select place_order('{"items":[{"variant_id":900111,"qty":1}],"customer_name":"عميلة أولى","phone":"0790000901",
  "governorate_id":1,"area":"عمان","address_details":"اختبار","payment_method":"cod"}');
-- do NOT commit yet
```

```sql
-- MANUAL — session B (this call now WAITS on session A's row lock)
select place_order('{"items":[{"variant_id":900111,"qty":1}],"customer_name":"عميلة ثانية","phone":"0790000902",
  "governorate_id":1,"area":"عمان","address_details":"اختبار","payment_method":"cod"}');
```

```sql
-- MANUAL — session A
commit;
-- Session B now returns:  ERROR: OUT_OF_STOCK
select stock from product_variants where id = 900111;   -- 0
```

```sql
-- MANUAL — cleanup
delete from orders where phone in ('962790000901', '962790000902');
delete from products where id = 900101;
```

Why it holds: `place_order` locks the variant rows with `SELECT … FOR UPDATE`, in id order so orders can't deadlock, *before* pricing. Session B wakes up after A commits and re-reads `stock = 0`. `CHECK (stock >= 0)` is a second guard.

---

## 3. Bundle math: 7 soaps with a "3 for 10 JD" offer

Cart: 4 × soap A (5 JD) + 3 × soap B (4 JD). Units sorted by price (highest first): 5 5 5 5 4 4 4.
That makes 2 full sets (5+5+5 and 5+4+4 = 28 JD), which cost 2 × 10 = 20 JD, so the discount is **8 JD**. The last unit (4 JD) is full price.
Subtotal 32 − 8 = 24, plus 3 delivery = **27 JD**.

```sql
begin;
select test.fixture();
select test.login(null);

do $$
declare r jsonb;
begin
  r := calculate_cart('[{"variant_id":900011,"qty":4},{"variant_id":900012,"qty":3}]', 1);
  perform test.assert((r->>'subtotal')::numeric = 32, 'subtotal 4×5 + 3×4 = 32');
  perform test.assert((r->>'bundle_discount')::numeric = 8, 'bundle discount = 28 − 2×10 = 8');
  perform test.assert((r->'bundles'->0->>'sets')::int = 2, 'two full sets');
  perform test.assert(r->'bundles'->0->>'name_ar' = '3 صابونات بـ10', 'offer name returned for display');
  perform test.assert((r->>'delivery_fee')::numeric = 3, 'delivery fee from governorate');
  perform test.assert((r->>'total')::numeric = 27, 'total = 32 − 8 + 3 = 27');

  r := calculate_cart('[{"variant_id":900011,"qty":4},{"variant_id":900012,"qty":3},{"variant_id":900014,"qty":1}]', 1);
  perform test.assert((r->>'bundle_discount')::numeric = 8 and (r->>'total')::numeric = 47,
                      'perfume (other category) is not bundled: 27 + 20 = 47');

  r := calculate_cart('[{"variant_id":900011,"qty":2}]', 1);
  perform test.assert((r->>'bundle_discount')::numeric = 0 and jsonb_array_length(r->'bundles') = 0,
                      '2 soaps: no full set, no discount');

  r := place_order(test.payload('[{"variant_id":900011,"qty":4},{"variant_id":900012,"qty":3}]', '0790000021'));
  perform test.assert((r->>'total')::numeric = 27, 'place_order charges the same 27');
end $$;

-- Free-delivery threshold applies to the subtotal AFTER discounts (24 here, not 32)
reset role;
update settings set free_delivery_threshold = 25;
select test.login(null);
do $$
declare r jsonb;
begin
  r := calculate_cart('[{"variant_id":900011,"qty":4},{"variant_id":900012,"qty":3}]', 1);
  perform test.assert((r->>'delivery_fee')::numeric = 3 and not (r->>'free_delivery_applied')::boolean,
                      'threshold 25 > 24 after discount → delivery still charged');
end $$;
reset role;
update settings set free_delivery_threshold = 24;
select test.login(null);
do $$
declare r jsonb;
begin
  r := calculate_cart('[{"variant_id":900011,"qty":4},{"variant_id":900012,"qty":3}]', 1);
  perform test.assert((r->>'delivery_fee')::numeric = 0 and (r->>'total')::numeric = 24,
                      'threshold 24 reached → free delivery, total 24');
end $$;

-- Offer switched off → no discount; unknown/inactive governorate is reported
reset role;
update offers set active = false where id = 900001;
select test.login(null);
do $$
declare r jsonb;
begin
  r := calculate_cart('[{"variant_id":900011,"qty":4},{"variant_id":900012,"qty":3}]', 1);
  perform test.assert((r->>'bundle_discount')::numeric = 0, 'inactive offer gives no discount');
  r := calculate_cart('[{"variant_id":900011,"qty":1}]', 12);
  perform test.assert(r->>'governorate_error' = 'INVALID_GOVERNORATE', 'inactive governorate reported');
end $$;
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000022', 'cod', null, 12))$$, 'INVALID_GOVERNORATE');
rollback;
```

A second offer overlapping the active one on the same category is rejected by the database:

```sql
begin;
select test.fixture();
select test.expect_sqlstate($$insert into offers (name_ar, category_id, quantity, bundle_price, starts_at, ends_at)
  values ('عرض ثانٍ', (select id from categories where key = 'soap'), 2, 7, now(), now() + interval '2 days')$$, '23P01');
rollback;
```

---

## 4. Coupon rules and limits

```sql
begin;
select test.fixture();
select test.login(null);

do $$
declare r jsonb;
begin
  -- Case-insensitive, Arabic digits accepted, stored uppercase
  r := calculate_cart('[{"variant_id":900011,"qty":2}]', 1, 't9-test١٠');
  perform test.assert(r->'coupon'->>'code' = 'T9-TEST10' and (r->>'coupon_discount')::numeric = 1,
                      't9-test١٠ → T9-TEST10 (case-insensitive, Arabic digits), 10% of 10 = 1');
  perform test.assert((r->>'total')::numeric = 12, 'total 10 − 1 + 3 = 12');

  -- Applied AFTER the bundle discount: 10% of 24, not of 32
  r := calculate_cart('[{"variant_id":900011,"qty":4},{"variant_id":900012,"qty":3}]', 1, 'T9-TEST10');
  perform test.assert((r->>'coupon_discount')::numeric = 2.4 and (r->>'total')::numeric = 24.6,
                      'coupon after bundle: 24 − 2.4 + 3 = 24.6');

  -- Percent cap
  r := calculate_cart('[{"variant_id":900014,"qty":1}]', 1, 'T9-BIG50');
  perform test.assert((r->>'coupon_discount')::numeric = 3, '50% of 20 capped by max_discount 3');

  -- Never negative
  r := calculate_cart('[{"variant_id":900011,"qty":1}]', 1, 'T9-HUGE');
  perform test.assert((r->>'coupon_discount')::numeric = 5 and (r->>'total')::numeric = 3,
                      'fixed 100 on 5 → discount 5, pay delivery only');

  -- Reported, not raised, by calculate_cart
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":2}]', 1, 'T9-FIXED5')->'coupon'->>'error' = 'COUPON_MIN_ORDER', 'min_order 50 > 10');
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":2}]', 1, 'T9-ONCE')->'coupon'->>'error' = 'COUPON_USAGE_LIMIT', 'max_uses reached');
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":2}]', 1, 'T9-OLD')->'coupon'->>'error' = 'COUPON_EXPIRED', 'expired');
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":2}]', 1, 'T9-SOON')->'coupon'->>'error' = 'COUPON_NOT_STARTED', 'not started');
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":2}]', 1, 'T9-OFF')->'coupon'->>'error' = 'COUPON_INACTIVE', 'inactive');
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":2}]', 1, 'T9-NOPE')->'coupon'->>'error' = 'COUPON_NOT_FOUND', 'unknown code');
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":3}]', 1, 'T9-NOCOMBO')->'coupon'->>'error' = 'COUPON_NOT_COMBINABLE', 'not combinable with an active bundle');
  perform test.assert((calculate_cart('[{"variant_id":900014,"qty":1}]', 1, 'T9-NOCOMBO')->>'coupon_discount')::numeric = 2, 'T9-NOCOMBO works without a bundle');
end $$;

-- place_order raises the coupon error instead of silently dropping it
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":2}]', '0790000031', 'cod', 'T9-FIXED5'))$$, 'COUPON_MIN_ORDER');

-- max_per_phone = 1
select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000032', 'cod', 'T9-PHONE1'));
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '+962 79 000 0032', 'cod', 'T9-PHONE1'))$$, 'COUPON_PHONE_LIMIT');
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000032', 'cod', 't9-phone1'))$$, 'COUPON_PHONE_LIMIT');
do $$ begin
  perform test.assert(calculate_cart('[{"variant_id":900011,"qty":1}]', 1, 'T9-PHONE1', '0790000032')->'coupon'->>'error' = 'COUPON_PHONE_LIMIT',
                      'calculate_cart also checks the phone when given');
end $$;
select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000033', 'cod', 'T9-PHONE1'));  -- another phone is fine

-- max_uses = 1: first order uses it, second is refused, cancelling releases it
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000034', 'cod', 'T9-ONE'));
  perform set_config('test.one', r->>'order_number', true);
end $$;
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000035', 'cod', 'T9-ONE'))$$, 'COUPON_USAGE_LIMIT');
select cancel_own_order(current_setting('test.one'), '0790000034');

reset role;
do $$ begin
  perform test.assert((select used_count from coupons where code = 'T9-ONE') = 0, 'cancelled order released the coupon use');
  perform test.assert((select used_count from coupons where code = 'T9-PHONE1') = 2, 'T9-PHONE1 used twice (two phones)');
  perform test.assert((select code from coupons where code = 'T9-TEST10') = 'T9-TEST10', 'code stored uppercase');
end $$;
rollback;
```

---

## 5. Order status transitions

```sql
begin;
select test.fixture();
select test.login(null);
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":2}]', '0790000041'));
  perform set_config('test.cod', r->>'public_token', true);
  r := place_order(test.payload('[{"variant_id":900014,"qty":1}]', '0790000042', 'cliq'));
  perform set_config('test.cliq', r->>'public_token', true);
  r := place_order(test.payload('[{"variant_id":900012,"qty":3}]', '0790000043'));
  perform set_config('test.cancel', r->>'public_token', true);
  r := place_order(test.payload('[{"variant_id":900012,"qty":2}]', '0790000044'));
  perform set_config('test.ret', r->>'public_token', true);
end $$;

-- Guests can't even call staff functions; a customer who isn't staff is refused
select test.expect_sqlstate($$select update_order_status(gen_random_uuid(), 'confirmed')$$, '42501');
select test.login('00000000-0000-0000-0000-00000000000c');
select test.expect_error($$select update_order_status(gen_random_uuid(), 'confirmed')$$, 'NOT_AUTHORIZED');

select test.login('00000000-0000-0000-0000-00000000000b');  -- staff
do $$ begin
  perform set_config('test.cod_id',    (select id from orders where public_token = current_setting('test.cod')::uuid)::text, true);
  perform set_config('test.cliq_id',   (select id from orders where public_token = current_setting('test.cliq')::uuid)::text, true);
  perform set_config('test.cancel_id', (select id from orders where public_token = current_setting('test.cancel')::uuid)::text, true);
  perform set_config('test.ret_id',    (select id from orders where public_token = current_setting('test.ret')::uuid)::text, true);
end $$;

select test.expect_error($$select update_order_status(current_setting('test.cod_id')::uuid, 'delivered')$$, 'INVALID_TRANSITION');
select test.expect_error($$select update_order_status(current_setting('test.cod_id')::uuid, 'with_courier')$$, 'INVALID_TRANSITION');
select test.expect_error($$select update_order_status(current_setting('test.cod_id')::uuid, 'returned')$$, 'INVALID_TRANSITION');
select test.expect_error($$select update_order_status(current_setting('test.cod_id')::uuid, 'shipped')$$, 'INVALID_TRANSITION');

do $$
declare v_id uuid := current_setting('test.cod_id')::uuid; r jsonb;
begin
  perform update_order_status(v_id, 'confirmed', 'تم الاتصال بالعميلة');
  perform test.expect_error(format('select update_order_status(%L, %L)', v_id, 'new'), 'INVALID_TRANSITION');
  perform update_order_status(v_id, 'with_courier');
  r := update_order_status(v_id, 'delivered');
  perform test.assert(r->>'payment_status' = 'paid', 'COD becomes paid on delivery');
  perform test.expect_error(format('select update_order_status(%L, %L)', v_id, 'with_courier'), 'INVALID_TRANSITION');
  perform update_order_status(v_id, 'returned', 'مرتجع', false);
  perform test.assert((select stock from product_variants where id = 900011) = 98, 'return WITHOUT restock leaves stock at 98');
  perform test.expect_error(format('select update_order_status(%L, %L)', v_id, 'delivered'), 'INVALID_TRANSITION');
  perform test.assert((select count(*) from order_status_history where order_id = v_id) = 5,
                      'history: new, confirmed, with_courier, delivered, returned');
  perform test.assert((select changed_by from order_status_history where order_id = v_id and to_status = 'confirmed')
                      = '00000000-0000-0000-0000-00000000000b', 'history records who changed it');
end $$;

-- Return WITH restock
do $$
declare v_id uuid := current_setting('test.ret_id')::uuid;
begin
  perform update_order_status(v_id, 'confirmed');
  perform update_order_status(v_id, 'with_courier');
  perform update_order_status(v_id, 'delivered');
  perform update_order_status(v_id, 'returned', null, true);
  perform test.assert(exists (select 1 from stock_movements where order_id = v_id and reason = 'return' and change = 2),
                      'return WITH restock logs +2');
end $$;

-- Cancel always restocks
do $$
declare v_id uuid := current_setting('test.cancel_id')::uuid;
begin
  perform update_order_status(v_id, 'cancelled', 'طلب العميلة');
  perform test.assert((select stock from product_variants where id = 900012) = 100, 'cancel restocked soap B to 100');
  perform test.assert(exists (select 1 from stock_movements where order_id = v_id and reason = 'cancel' and change = 3),
                      'cancel stock movement logged');
  perform test.expect_error(format('select update_order_status(%L, %L)', v_id, 'confirmed'), 'INVALID_TRANSITION');
end $$;

-- CliQ: can't go to the courier before the owner verifies payment; staff can't verify
select update_order_status(current_setting('test.cliq_id')::uuid, 'confirmed');
select test.expect_error($$select update_order_status(current_setting('test.cliq_id')::uuid, 'with_courier')$$, 'PAYMENT_NOT_VERIFIED');
select test.expect_error($$select verify_payment(current_setting('test.cliq_id')::uuid, true)$$, 'NOT_AUTHORIZED');
select test.login('00000000-0000-0000-0000-00000000000a');  -- owner
select verify_payment(current_setting('test.cliq_id')::uuid, true);
select test.login('00000000-0000-0000-0000-00000000000b');  -- staff again
select test.expect_rows($$select update_order_status(current_setting('test.cliq_id')::uuid, 'with_courier')$$, 1);

-- Customer cancellation: only while status = new
select test.login(null);
select test.expect_result_error($$select cancel_own_order(current_setting('test.cod')::text, '0790000041')$$, 'ORDER_NOT_FOUND');  -- token is not an order number
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000045'));
  perform test.expect_result_error(format('select cancel_own_order(%L, %L)', r->>'order_number', '0790000099'), 'ORDER_NOT_FOUND');
  perform test.assert(cancel_own_order(replace(r->>'order_number', 'SH-', ''), '٠٧٩٠٠٠٠٠٤٥')->>'status' = 'cancelled',
                      'guest cancels a new order with number + phone (Arabic digits ok)');
  perform test.expect_error(format('select cancel_own_order(%L, %L)', r->>'order_number', '0790000045'), 'CANNOT_CANCEL');
end $$;
select test.expect_result_error($$select cancel_own_order('SH-99999999', '0790000042')$$, 'ORDER_NOT_FOUND');

-- Logged-in customer: own orders only
select test.login('00000000-0000-0000-0000-00000000000c');
do $$
declare r jsonb; v_id uuid;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000046'));
  v_id := (select id from orders where public_token = (r->>'public_token')::uuid);
  perform test.assert(v_id is not null, 'customer sees own order (linked to account)');
  perform test.assert(cancel_my_order(v_id)->>'status' = 'cancelled', 'cancel_my_order works for own new order');
  perform test.expect_error(format('select cancel_my_order(%L)', current_setting('test.cliq_id')), 'ORDER_NOT_FOUND');
end $$;
rollback;
```

---

## 6. Staff can't read revenue or edit prices, offers, coupons, delivery, settings or staff

```sql
begin;
select test.fixture();
select test.login('00000000-0000-0000-0000-00000000000b');  -- staff

select test.expect_error($$select dashboard_stats(current_date - 30, current_date)$$, 'NOT_AUTHORIZED');
select test.expect_error($$select get_admin_settings()$$, 'NOT_AUTHORIZED');
select test.expect_error($$select add_staff('customer@test.local', 'owner')$$, 'NOT_AUTHORIZED');
select test.expect_error($$select remove_staff('00000000-0000-0000-0000-00000000000a')$$, 'NOT_AUTHORIZED');
select test.expect_error($$select list_staff()$$, 'NOT_AUTHORIZED');

select test.expect_rows($$update product_variants set price = 0.5 where id = 900011$$, 0);
select test.expect_rows($$update products set name_ar = 'x' where id = 900001$$, 0);
select test.expect_rows($$delete from products where id = 900001$$, 0);
select test.expect_sqlstate($$insert into products (category_id, name_ar, description_ar) values (1, 'x', 'x')$$, '42501');
select test.expect_rows($$update offers set bundle_price = 1$$, 0);
select test.expect_rows($$select 1 from coupons$$, 0);
select test.expect_rows($$update coupons set value = 100$$, 0);
select test.expect_sqlstate($$insert into coupons (code, type, value) values ('STAFF', 'percent', 90)$$, '42501');
select test.expect_rows($$update governorates set delivery_fee = 0$$, 0);
select test.expect_rows($$update settings set store_open = false$$, 0);
select test.expect_sqlstate($$select cliq_alias from settings$$, '42501');
select test.expect_sqlstate($$insert into staff (user_id, role) values (auth.uid(), 'owner')$$, '42501');
select test.expect_sqlstate($$update staff set role = 'owner'$$, '42501');
select test.expect_sqlstate($$update product_variants set stock = 1000 where id = 900011$$, '42501');

-- What staff CAN do: read orders, adjust stock (logged), moderate reviews, add internal notes
do $$
declare r jsonb;
begin
  r := adjust_stock(900011, -5, 'تالف');
  perform test.assert((r->>'stock')::int = 95, 'staff adjusts stock 100 → 95');
  perform test.assert(exists (select 1 from stock_movements where variant_id = 900011 and change = -5
                              and reason = 'manual' and note = 'تالف' and created_by = auth.uid()),
                      'manual adjustment logged with author and note');
end $$;
select test.expect_error($$select adjust_stock(900011, -1000)$$, 'INSUFFICIENT_STOCK');
select test.expect_error($$select adjust_stock(900011, 0)$$, 'INVALID_QUANTITY');

reset role;
update settings set free_delivery_threshold = null;
select test.login('00000000-0000-0000-0000-00000000000a');  -- owner
do $$
declare r1 jsonb; r2 jsonb; v_id uuid; t jsonb;
begin
  r1 := dashboard_stats(current_date - 30, current_date);
  t := place_order(test.payload('[{"variant_id":900011,"qty":2}]', '0790000051'));
  v_id := (select id from orders where public_token = (t->>'public_token')::uuid);
  perform update_order_status(v_id, 'confirmed');
  perform update_order_status(v_id, 'with_courier');
  perform update_order_status(v_id, 'delivered');
  r2 := dashboard_stats(current_date - 30, current_date);
  perform test.assert((r2->>'revenue')::numeric - (r1->>'revenue')::numeric = 10, 'owner: revenue +10 (goods only)');
  perform test.assert((r2->>'delivery_fees')::numeric - (r1->>'delivery_fees')::numeric = 3, 'owner: delivery fees reported separately (+3)');
  perform test.assert(r2 ? 'orders_by_status' and r2 ? 'top_products' and r2 ? 'low_stock'
                      and r2 ? 'flagged_cliq_orders' and r2 ? 'average_order_value', 'owner: all dashboard sections present');
  perform test.expect_error('select dashboard_stats(current_date, current_date - 1)', 'INVALID_DATE_RANGE');
end $$;
select test.expect_rows($$update product_variants set price = 6 where id = 900011$$, 1);
select test.expect_error($$select add_staff('nobody@test.local', 'staff')$$, 'USER_NOT_FOUND');
select test.expect_error($$select add_staff('owner@test.local', 'staff')$$, 'CANNOT_REMOVE_SELF');
select test.expect_error($$select remove_staff('00000000-0000-0000-0000-00000000000a')$$, 'CANNOT_REMOVE_SELF');
do $$
declare v_before integer := jsonb_array_length(list_staff());
begin
  perform add_staff('Customer@Test.local', 'staff');
  perform test.assert(jsonb_array_length(list_staff()) = v_before + 1, 'owner promotes by email (case-insensitive): +1 staff');
  perform test.assert(exists (select 1 from jsonb_array_elements(list_staff()) e
                              where e->>'email' = 'customer@test.local' and e->>'role' = 'staff'), 'promoted account listed as staff');
end $$;
rollback;
```

---

## 7. CliQ details and payment proofs

```sql
begin;
select test.fixture();
select test.login(null);

do $$
declare r jsonb; t uuid; cod jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900014,"qty":1}]', '0790000061', 'cliq'));
  t := (r->>'public_token')::uuid;
  perform set_config('test.cliq', t::text, true);
  perform test.assert(r->>'payment_status' = 'awaiting_transfer', 'CliQ order starts awaiting_transfer');
  r := get_order_by_token(t);
  perform test.assert(r->'cliq'->>'alias' = 'SHAMITEST' and (r->'cliq'->>'amount')::numeric = 23,
                      'unpaid CliQ order returns alias + exact amount (20 + 3)');

  cod := place_order(test.payload('[{"variant_id":900014,"qty":1}]', '0790000062'));
  perform test.assert(jsonb_typeof(get_order_by_token((cod->>'public_token')::uuid)->'cliq') = 'null',
                      'COD order never exposes CliQ details');

  perform test.assert(can_upload_payment_proof(t || '/receipt.jpg'), 'upload allowed into own token folder');
  perform test.assert(not can_upload_payment_proof(t || '/receipt.pdf'), 'non-image rejected');
  perform test.assert(not can_upload_payment_proof(t || '/a/receipt.jpg'), 'nested path rejected');
  perform test.assert(not can_upload_payment_proof(gen_random_uuid() || '/receipt.jpg'), 'unknown token rejected');
  perform test.assert(not can_upload_payment_proof((cod->>'public_token') || '/receipt.jpg'), 'COD order rejected');
end $$;

select test.expect_sqlstate($$select cliq_alias, cliq_account_name from settings$$, '42501');
select test.expect_error($$select attach_payment_proof(current_setting('test.cliq')::uuid)$$, 'PROOF_REQUIRED');
select test.expect_error($$select attach_payment_proof(current_setting('test.cliq')::uuid, current_setting('test.cliq') || '/missing.jpg')$$, 'INVALID_PROOF');
select test.expect_error($$select attach_payment_proof(gen_random_uuid(), null, '123')$$, 'ORDER_NOT_FOUND');

do $$
declare r jsonb;
begin
  r := attach_payment_proof(current_setting('test.cliq')::uuid, null, 'REF-١٢٣');
  perform test.assert(r->>'payment_status' = 'awaiting_verification', 'reference → awaiting_verification');
  perform test.assert(not can_upload_payment_proof(current_setting('test.cliq') || '/second.jpg'), 'no uploads after submission');
end $$;
select test.expect_error($$select attach_payment_proof(current_setting('test.cliq')::uuid, null, 'AGAIN')$$, 'RECEIPT_ALREADY_UPLOADED');

-- A proof file exists: staff can't read it, the owner can
reset role;
insert into storage.objects (bucket_id, name) values ('payment-proofs', current_setting('test.cliq') || '/r.jpg');
select test.login('00000000-0000-0000-0000-00000000000b');
select test.expect_rows($$select 1 from storage.objects where bucket_id = 'payment-proofs' and name = current_setting('test.cliq') || '/r.jpg'$$, 0);
select test.login('00000000-0000-0000-0000-00000000000a');
select test.expect_rows($$select 1 from storage.objects where bucket_id = 'payment-proofs' and name = current_setting('test.cliq') || '/r.jpg'$$, 1);

do $$
declare r jsonb;
begin
  perform verify_payment((select id from orders where public_token = current_setting('test.cliq')::uuid), true);
  r := get_order_by_token(current_setting('test.cliq')::uuid);
  perform test.assert(r->>'payment_status' = 'paid' and jsonb_typeof(r->'cliq') = 'null', 'after payment CliQ details are hidden');
  perform test.assert((select payment_reference from orders where public_token = current_setting('test.cliq')::uuid) = 'REF-123',
                      'reference stored with Western digits');
end $$;
rollback;
```

---

## 8. normalize_ar and normalize_phone match the JavaScript versions

The expected values below are the actual outputs of `normalizeArabic()` / `normalizePhone()` in `/assets/js/utils.js`.

```sql
begin;
do $$
declare c record;
begin
  for c in select * from (values
    ('إِسْتِـــخدام الصابونة ومسؤول ئ', 'استخدام الصابونه ومسوول ي'),
    ('مَكْتَبَة',                       'مكتبه'),
    ('إيمان آمنة',                      'ايمان امنه'),
    ('مستشفى',                          'مستشفي'),
    ('صابون  الغار',                    'صابون الغار'),
    ('  TWINS   No.12  ',               'twins no.12'),
    ('عطر رجالي No.٠٧',                 'عطر رجالي no.07'),
    ('٢٫٥',                             '2.5'),
    ('١٬٠٠٠',                           '1000'),
    ('۰۷۸',                             '078'),
    (E'أحمد\tو\nإسراء',                 'احمد و اسراء'),
    ('شـــامـــي',                      'شامي'),
    ('قُرْآن',                          'قران'),
    ('ﻻ',                               'ﻻ'),
    ('Café',                            'café'),
    (E'رائحة فاخرة وثابتة',        'رايحه فاخره وثابته'),
    ('',                                ''),
    (null,                              '')
  ) v(input, expected) loop
    perform test.assert(normalize_ar(c.input) = c.expected, format('normalize_ar(%L) = %L', c.input, c.expected));
  end loop;

  for c in select * from (values
    ('0791234567',       '962791234567'),
    ('٠٧٩١٢٣٤٥٦٧',       '962791234567'),
    ('+962 79 123 4567', '962791234567'),
    ('00962781234567',   '962781234567'),
    ('791234567',        '962791234567'),
    ('0761234567',       null),
    ('962791234567',     '962791234567'),
    ('079123456',        null),
    ('07-7123-4567',     '962771234567'),
    ('(078) 123 4567',   '962781234567'),
    ('',                 null)
  ) v(input, expected) loop
    perform test.assert(normalize_phone(c.input) is not distinct from c.expected,
                        format('normalize_phone(%L) = %L', c.input, c.expected));
  end loop;
end $$;

-- The generated search column uses the same normalization (name_ar + name_en + tags)
select test.fixture();
do $$ begin
  perform test.assert((select count(*) from products where id in (900001, 900002)
                       and search like '%' || normalize_ar('إختبار') || '%') = 2, 'search "إختبار" finds both test soaps');
  perform test.assert((select search from products where id = 900003) = 'عطر اختبار test perfume', 'search text = name_ar + name_en');
  perform test.assert((select search from products where id = 900002) = 'صابون اختبار ب acne oily', 'tags normalized (lowercase, sorted) into search');
end $$;
rollback;
```

---

## 9. What the public and customers can see

```sql
begin;
select test.fixture();
-- Quiz ranking must not depend on other soaps in the project: hide non-fixture products for this
-- transaction only (rolled back at the end).
update products set active = false where id not between 900001 and 900099;
select test.login(null);

do $$ begin
  perform test.assert((select count(*) from products where id between 900001 and 900005) = 3,
                      'guest sees only visible products (not inactive, not without active variants)');
  perform test.assert(not exists (select 1 from product_variants where id in (900015, 900016)), 'inactive variants hidden');
  perform test.assert((select count(*) from offers where id = 900001) = 1, 'running offer visible');
  perform test.assert((select store_open from settings) is true, 'public settings columns readable');
  perform test.assert(not exists (select 1 from governorates where id = 12), 'inactive governorate hidden');
  perform test.assert(quiz_recommend(array['OILY'])->0->>'slug' = 'test-soap-b', 'quiz: oily → soap B first');
  perform test.assert(jsonb_array_length(quiz_recommend(array['oily'])) = 2, 'quiz: only visible soaps');
end $$;

select test.expect_sqlstate($$select 1 from coupons$$, '42501');  -- coupons never visible to guests
select test.expect_sqlstate($$select 1 from staff$$, '42501');    -- staff table hidden

-- Reviews: only after delivery, once, visible after approval
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000071'));
  perform set_config('test.rev', r->>'public_token', true);
  perform test.expect_error(format('select submit_review(%L, 5, %L)', r->>'public_token', 'ممتاز'), 'ORDER_NOT_DELIVERED');
end $$;
select test.login('00000000-0000-0000-0000-00000000000b');
do $$
declare v_id uuid := (select id from orders where public_token = current_setting('test.rev')::uuid);
begin
  perform update_order_status(v_id, 'confirmed');
  perform update_order_status(v_id, 'with_courier');
  perform update_order_status(v_id, 'delivered');
  perform set_config('test.rev_id', v_id::text, true);
end $$;
select test.login(null);
select test.expect_error($$select submit_review(current_setting('test.rev')::uuid, 6)$$, 'INVALID_RATING');
select submit_review(current_setting('test.rev')::uuid, 5, 'ممتاز');
select test.expect_error($$select submit_review(current_setting('test.rev')::uuid, 4)$$, 'REVIEW_EXISTS');
select test.expect_rows($$select 1 from reviews where order_id = current_setting('test.rev_id')::uuid$$, 0);   -- pending → hidden
select test.expect_sqlstate($$update reviews set status = 'approved'$$, '42501');
select test.login('00000000-0000-0000-0000-00000000000b');
select test.expect_rows($$update reviews set status = 'approved', featured = true where order_id = current_setting('test.rev_id')::uuid$$, 1);
select test.login(null);
select test.expect_rows($$select 1 from reviews where order_id = current_setting('test.rev_id')::uuid and featured$$, 1);

-- Customer: own profile (created by trigger, phone normalized) and own addresses only
select test.login('00000000-0000-0000-0000-00000000000c');
do $$ begin
  perform test.assert((select phone from profiles where id = auth.uid()) = '962790000099', 'profile created on sign-up, phone normalized');
  perform test.assert((select count(*) from profiles) = 1, 'customer sees only own profile');
  insert into addresses (full_name, phone, governorate_id, area, details) values ('عميلة', '٠٧٨١٢٣٤٥٦٧', 1, 'خلدا', 'شارع 1');
  insert into addresses (full_name, phone, governorate_id, area, details, is_default) values ('عميلة', '0771234567', 2, 'إربد', 'شارع 2', true);
  perform test.assert((select count(*) from addresses where is_default) = 1, 'only one default address');
  perform test.assert((select phone from addresses where area = 'خلدا') = '962781234567', 'address phone normalized');
  perform test.assert((select count(*) from orders where user_id <> auth.uid()) = 0, 'customer cannot see others'' orders');
end $$;
select test.expect_error($$update profiles set phone = '12345' where id = auth.uid()$$, 'INVALID_PHONE');
select test.expect_sqlstate($$insert into addresses (user_id, full_name, phone, governorate_id, area, details)
  values ('00000000-0000-0000-0000-00000000000a', 'عميلة', '0791234567', 1, 'خلدا', 'شارع 1')$$, '42501');
rollback;
```

---

## 10. Rate limit: max 3 orders per phone per hour

```sql
begin;
select test.fixture();
select test.login(null);
select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000081'));
select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000081'));
select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '+962790000081'));
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '٠٧٩٠٠٠٠٠٨١'))$$, 'RATE_LIMITED');
select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000082'));  -- other phone fine
rollback;
```

---

## 11. Customer names

Real names are accepted: Arabic or English, 2–60 characters, several words, with spaces, hyphens and apostrophes. Whitespace is collapsed. The expected values are the real outputs of `normalizeName()` / `isValidName()` in `/assets/js/utils.js`.

```sql
begin;
do $$
declare c record;
begin
  for c in select * from (values
    ('محمد أبو جلبوش',         'محمد أبو جلبوش',         true),
    ('Mohammad Abu-Jalboush',  'Mohammad Abu-Jalboush',  true),
    ('O''Brien',               'O''Brien',               true),
    ('نور',                    'نور',                    true),
    ('Al',                     'Al',                     true),
    ('  Ahmad   Ali  ',        'Ahmad Ali',              true),
    ('عبدُ الله',              'عبدُ الله',              true),
    ('José Álvarez',           'José Álvarez',           true),
    ('D’Angelo',               'D’Angelo',               true),
    (E'Ali\tHassan',           'Ali Hassan',             true),
    (repeat('a', 60),          repeat('a', 60),          true),
    ('أ',                      'أ',                      false),
    ('A',                      'A',                      false),
    ('12345',                  '12345',                  false),
    ('محمد123',                'محمد123',                false),
    ('<script>',               '<script>',               false),
    ('--',                     '--',                     false),
    (repeat('a', 61),          repeat('a', 61),          false),
    ('Ali_Hassan',             'Ali_Hassan',             false),
    ('محمد، علي',              'محمد، علي',              false),
    ('',                       '',                       false),
    (null,                     '',                       false)
  ) v(input, normalized, valid) loop
    perform test.assert(normalize_person_name(c.input) = c.normalized and is_valid_person_name(c.input) = c.valid,
                        format('name %L → %L, valid = %s', c.input, c.normalized, c.valid));
  end loop;
end $$;

select test.fixture();
select test.login(null);
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000091') || '{"customer_name":"  محمد   أبو-جلبوش "}');
  perform test.assert(get_order_by_token((r->>'public_token')::uuid)->>'customer_name' = 'محمد أبو-جلبوش',
                      'Arabic multi-word name with hyphen accepted and stored normalized');
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000092') || '{"customer_name":"Sarah O''Neil"}');
  perform test.assert(r ? 'order_number', 'English name with apostrophe accepted');
end $$;
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000093') || '{"customer_name":"أ"}')$$, 'INVALID_NAME');
select test.expect_error($$select place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000094') || '{"customer_name":"12345"}')$$, 'INVALID_NAME');

select test.login('00000000-0000-0000-0000-00000000000c');
select test.expect_error($$insert into addresses (full_name, phone, governorate_id, area, details) values ('x1', '0791234567', 1, 'خلدا', 'شارع 1')$$, 'INVALID_NAME');
select test.expect_error($$update profiles set full_name = '<b>' where id = auth.uid()$$, 'INVALID_NAME');
rollback;
```

---

## 12. Grants (privileges of the API roles)

> **SQL Editor warning:** this block creates a throw-away table (`zz_grant_probe`) to check that new tables get no API privileges by default, so Supabase shows *"table without RLS"*. Choose **Run without RLS**. That's expected: the table is rolled back at the end of the block and never exists.

Privileges decide which operations a role may even attempt. RLS then decides which rows. This block checks the privileges directly, so it also catches drift between `02b_grants.sql` and the grant sections in `02`/`03`/`04`.

```sql
begin;
select test.fixture();

-- Guests
select test.login(null);
select test.expect_sqlstate($$select 1 from orders$$, '42501');
select test.expect_sqlstate($$select 1 from order_items$$, '42501');
select test.expect_sqlstate($$select 1 from profiles$$, '42501');
select test.expect_sqlstate($$select 1 from addresses$$, '42501');
select test.expect_sqlstate($$select 1 from staff$$, '42501');
select test.expect_sqlstate($$select 1 from order_notes$$, '42501');
select test.expect_sqlstate($$select 1 from order_status_history$$, '42501');
select test.expect_sqlstate($$select 1 from stock_movements$$, '42501');
select test.expect_sqlstate($$select 1 from coupons$$, '42501');
select test.expect_sqlstate($$select cliq_alias from settings$$, '42501');
select test.expect_rows($$select 1 from products where id in (900001, 900002, 900003)$$, 3);
select test.expect_rows($$select 1 from product_variants where id in (900011, 900012, 900013, 900014)$$, 4);
select test.expect_rows($$select store_open from settings$$, 1);
select test.expect_sqlstate($$select _price_cart('[{"variant_id":900011,"qty":1}]', 1, null, null)$$, '42501');
select test.expect_sqlstate($$select _order_public_json(gen_random_uuid())$$, '42501');
select test.expect_sqlstate($$select update_order_status(gen_random_uuid(), 'confirmed')$$, '42501');

-- Signed-in users can't change prices unless they are the owner
select test.login('00000000-0000-0000-0000-00000000000c');  -- customer
select test.expect_rows($$update product_variants set price = 9 where id = 900011$$, 0);
select test.expect_sqlstate($$select _apply_status_change(gen_random_uuid(), 'cancelled', null, true, null, true)$$, '42501');
select test.login('00000000-0000-0000-0000-00000000000b');  -- staff
select test.expect_rows($$update product_variants set price = 9 where id = 900011$$, 0);
select test.login('00000000-0000-0000-0000-00000000000a');  -- owner
select test.expect_rows($$update product_variants set price = 9 where id = 900011$$, 1);
-- Owner creates catalog rows through the API role (identity sequences + search column functions)
do $do$
declare v_id bigint;
begin
  insert into products (category_id, name_ar, name_en, description_ar, tags)
  values ((select id from categories where key = 'soap'), 'صابون جديد', 'New Soap', 'وصف', '{Dry}')
  returning id into v_id;
  insert into product_variants (product_id, label, price, stock) values (v_id, 'قطعة', 3, 10);
  perform test.assert((select slug from products where id = v_id) = 'new-soap', 'owner creates a product (slug from name_en)');
  perform test.assert(exists (select 1 from stock_movements m join product_variants v on v.id = m.variant_id
                              where v.product_id = v_id and m.change = 10), 'initial stock logged');
end $do$;

-- Full privilege catalogue
reset role;
do $$
declare
  r record;
  v_anon_fns text[] := array[
    'calculate_cart', 'place_order', 'get_order_by_token', 'track_order', 'attach_payment_proof',
    'cancel_own_order', 'submit_review', 'quiz_recommend', 'product_reviews', 'can_upload_payment_proof',
    'is_staff', 'is_owner', 'product_is_visible', 'western_digits', 'normalize_ar', 'product_search_text',
    'normalize_phone', 'slugify', 'normalize_tags', 'normalize_person_name', 'is_valid_person_name'];
  v_auth_fns text[] := v_anon_fns || array[
    'cancel_my_order', 'update_order_status', 'verify_payment', 'mark_refunded', 'adjust_stock',
    'add_staff', 'remove_staff', 'list_staff', 'get_admin_settings', 'dashboard_stats', 'staff_overview'];
  v_anon_read text[] := array[
    'settings', 'governorates', 'categories', 'products', 'product_images', 'product_variants',
    'offers', 'reviews', 'quiz_questions', 'quiz_options', 'catalog_products'];
  v_read_only text[] := array['orders', 'order_items', 'order_status_history', 'stock_movements', 'staff'];
begin
  -- Functions: exactly the allow-lists; PUBLIC gets nothing; internal helpers and triggers nobody
  for r in
    select p.oid, p.proname, p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    perform test.assert(not has_function_privilege('public', r.oid, 'EXECUTE'), format('PUBLIC cannot execute %s', r.sig));
    perform test.assert(has_function_privilege('anon', r.oid, 'EXECUTE') = (r.proname = any (v_anon_fns)),
                        format('anon EXECUTE %s = %s', r.sig, r.proname = any (v_anon_fns)));
    perform test.assert(has_function_privilege('authenticated', r.oid, 'EXECUTE') = (r.proname = any (v_auth_fns)),
                        format('authenticated EXECUTE %s = %s', r.sig, r.proname = any (v_auth_fns)));
  end loop;

  -- Tables
  for r in
    select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  loop
    perform test.assert(not has_table_privilege('anon', r.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
                        and not has_any_column_privilege('anon', r.oid, 'INSERT, UPDATE'),
                        format('anon cannot write %s', r.relname));
    perform test.assert(has_any_column_privilege('anon', r.oid, 'SELECT') = (r.relname = any (v_anon_read)),
                        format('anon SELECT %s = %s', r.relname, r.relname = any (v_anon_read)));
    perform test.assert(not has_table_privilege('authenticated', r.oid, 'TRUNCATE'),
                        format('authenticated cannot truncate %s', r.relname));
    if r.relname = any (v_read_only) then
      perform test.assert(not has_table_privilege('authenticated', r.oid, 'INSERT, UPDATE, DELETE')
                          and not has_any_column_privilege('authenticated', r.oid, 'INSERT, UPDATE'),
                          format('authenticated cannot write %s (functions only)', r.relname));
    end if;
  end loop;

  perform test.assert(not has_column_privilege('authenticated', 'public.product_variants', 'stock', 'UPDATE'),
                      'no API role can update product_variants.stock directly');
  perform test.assert(not has_column_privilege('anon', 'public.settings', 'cliq_alias', 'SELECT')
                      and not has_column_privilege('authenticated', 'public.settings', 'cliq_account_name', 'SELECT'),
                      'CliQ settings columns not readable by API roles');
end $$;

-- Objects created later are NOT auto-granted
create table public.zz_grant_probe (id int);
create function public.zz_grant_probe_fn() returns int language sql as 'select 1';
do $$ begin
  perform test.assert(not has_table_privilege('anon', 'public.zz_grant_probe', 'SELECT')
                      and not has_table_privilege('authenticated', 'public.zz_grant_probe', 'SELECT'),
                      'new tables get no API privileges by default');
  perform test.assert(not has_function_privilege('public', 'public.zz_grant_probe_fn()', 'EXECUTE')
                      and not has_function_privilege('anon', 'public.zz_grant_probe_fn()', 'EXECUTE'),
                      'new functions get no EXECUTE by default');
end $$;
rollback;
```

---

## 13. Refunds (refund_due → refunded)

Any paid order that is cancelled or returned becomes `refund_due` (paid CliQ, or COD that was delivered and then returned). The owner settles it with `mark_refunded`. Every payment change is logged in the status history.

```sql
begin;
select test.fixture();
select test.login(null);
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900014,"qty":1}]', '0790000101', 'cliq')); perform set_config('test.a', r->>'public_token', true);
  r := place_order(test.payload('[{"variant_id":900014,"qty":1}]', '0790000102', 'cliq')); perform set_config('test.b', r->>'public_token', true);
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000103'));         perform set_config('test.c', r->>'public_token', true);
  r := place_order(test.payload('[{"variant_id":900014,"qty":1}]', '0790000104', 'cliq')); perform set_config('test.d', r->>'public_token', true);
end $$;

select test.login('00000000-0000-0000-0000-00000000000a');  -- owner
do $$
declare
  a uuid := (select id from orders where public_token = current_setting('test.a')::uuid);
  b uuid := (select id from orders where public_token = current_setting('test.b')::uuid);
  c uuid := (select id from orders where public_token = current_setting('test.c')::uuid);
  d uuid := (select id from orders where public_token = current_setting('test.d')::uuid);
  v_due_before integer := (dashboard_stats(current_date, current_date)->>'refund_due_count')::integer;
begin
  perform set_config('test.a_id', a::text, true);

  -- A: paid, then cancelled → refund_due
  perform verify_payment(a, true);
  perform update_order_status(a, 'cancelled', 'إلغاء بطلب العميل');
  perform test.assert((select payment_status from orders where id = a) = 'refund_due', 'paid CliQ + cancelled → refund_due');
  perform test.assert(exists (select 1 from order_status_history where order_id = a and to_status = 'cancelled'
                              and payment_from = 'paid' and payment_to = 'refund_due'), 'cancel row logs paid → refund_due');
  perform test.assert(exists (select 1 from order_status_history where order_id = a and from_status = 'new' and to_status = 'new'
                              and payment_from = 'awaiting_transfer' and payment_to = 'paid'), 'verify_payment logged');

  -- B: paid, delivered, returned without restock → refund_due
  perform verify_payment(b, true);
  perform update_order_status(b, 'confirmed');
  perform update_order_status(b, 'with_courier');
  perform update_order_status(b, 'delivered');
  perform test.assert((select payment_status from orders where id = b) = 'paid', 'CliQ stays paid on delivery');
  perform update_order_status(b, 'returned', null, false);
  perform test.assert((select payment_status from orders where id = b) = 'refund_due', 'paid CliQ + returned → refund_due');

  -- C: COD delivered (paid) then returned → refund_due
  perform update_order_status(c, 'confirmed');
  perform update_order_status(c, 'with_courier');
  perform update_order_status(c, 'delivered');
  perform update_order_status(c, 'returned');
  perform test.assert((select payment_status from orders where id = c) = 'refund_due', 'paid COD + returned → refund_due');
  perform test.assert(exists (select 1 from order_status_history where order_id = c and to_status = 'returned'
                              and payment_from = 'paid' and payment_to = 'refund_due'), 'COD return logs paid → refund_due');

  -- D: cancelled before paying; the transfer arrives later → refund_due
  perform update_order_status(d, 'cancelled');
  perform test.assert((select payment_status from orders where id = d) = 'awaiting_transfer', 'unpaid CliQ cancel: no refund due');
  perform verify_payment(d, true);
  perform test.assert((select payment_status from orders where id = d) = 'refund_due', 'money confirmed for a cancelled order → refund_due');

  perform test.assert((dashboard_stats(current_date, current_date)->>'refund_due_count')::integer = v_due_before + 4,
                      'dashboard counts refund_due orders (+4)');

  -- Settle A
  perform test.assert(mark_refunded(a, 'تم التحويل عبر CliQ')->>'payment_status' = 'refunded', 'mark_refunded → refunded');
  perform test.assert(exists (select 1 from order_status_history where order_id = a and payment_from = 'refund_due'
                              and payment_to = 'refunded' and note = 'تم التحويل عبر CliQ'
                              and changed_by = '00000000-0000-0000-0000-00000000000a'), 'refund logged with note and owner');
  perform test.expect_error(format('select mark_refunded(%L)', a), 'REFUND_NOT_DUE');
  perform test.assert((dashboard_stats(current_date, current_date)->>'refund_due_count')::integer = v_due_before + 3,
                      'dashboard refund_due count drops after refund');
end $$;

-- The customer timeline shows status changes only (payment-only rows hidden)
select test.login(null);
do $$ begin
  perform test.assert((select jsonb_agg(h->>'status') from jsonb_array_elements(get_order_by_token(current_setting('test.a')::uuid)->'history') h)
                      = '["new", "cancelled"]'::jsonb, 'customer history: new → cancelled only');
end $$;
select test.expect_sqlstate($$select mark_refunded(gen_random_uuid())$$, '42501');

select test.login('00000000-0000-0000-0000-00000000000b');  -- staff
select test.expect_error($$select mark_refunded(current_setting('test.a_id')::uuid)$$, 'NOT_AUTHORIZED');
rollback;
```

---

## 14. Order lookup brute-force guard

`track_order` and `cancel_own_order` reject an order number with `RATE_LIMITED` after 10 failed attempts in an hour, even if the phone is then correct. A failed lookup *returns* `{"error": "ORDER_NOT_FOUND"}` instead of raising, so the failed attempt is kept.

```sql
begin;
select test.fixture();
select test.login(null);
do $$
declare r jsonb; i integer;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000111'));
  perform set_config('test.n1', r->>'order_number', true);
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000112'));
  perform set_config('test.n2', r->>'order_number', true);

  -- Order 1: 9 failures, the correct phone still works, the 10th failure locks it
  for i in 1..9 loop
    perform test.expect_result_error(format('select track_order(%L, %L)', current_setting('test.n1'), '0790000199'), 'ORDER_NOT_FOUND');
  end loop;
  perform test.assert(track_order(current_setting('test.n1'), '0790000111')->>'order_number' = current_setting('test.n1'),
                      'after 9 failures the right phone still works');
  perform test.expect_result_error(format('select cancel_own_order(%L, %L)', lower(current_setting('test.n1')), '0790000198'), 'ORDER_NOT_FOUND');

  -- Order 2: many successful lookups never lock it
  for i in 1..15 loop
    perform track_order(current_setting('test.n2'), '0790000112');
  end loop;
  perform test.assert(track_order(current_setting('test.n2'), '0790000112') ? 'order_number', 'successful lookups are not counted');
end $$;

select test.expect_error($$select track_order(current_setting('test.n1'), '0790000111')$$, 'RATE_LIMITED');
select test.expect_error($$select track_order(replace(current_setting('test.n1'), 'SH-', ''), '0790000111')$$, 'RATE_LIMITED');
select test.expect_error($$select cancel_own_order(current_setting('test.n1'), '0790000111')$$, 'RATE_LIMITED');
select test.expect_sqlstate($$select 1 from order_lookup_failures$$, '42501');

-- Failures older than an hour no longer count
reset role;
update order_lookup_failures set created_at = now() - interval '61 minutes' where order_number = current_setting('test.n1');
select test.login(null);
do $$ begin
  perform test.assert(track_order(current_setting('test.n1'), '0790000111') ? 'order_number', 'lock expires after an hour');
end $$;
rollback;
```

---

## 15. Payment proofs: at most 3 files per order

This goes through the real storage policy (an insert into `storage.objects` as the guest role).

```sql
begin;
select test.fixture();
select test.login(null);
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900014,"qty":1}]', '0790000121', 'cliq'));
  perform set_config('test.p', r->>'public_token', true);
end $$;

select test.expect_rows($$insert into storage.objects (bucket_id, name) values ('payment-proofs', current_setting('test.p') || '/1.jpg')$$, 1);
select test.expect_rows($$insert into storage.objects (bucket_id, name) values ('payment-proofs', current_setting('test.p') || '/2.png')$$, 1);
do $$ begin
  perform test.assert((get_order_by_token(current_setting('test.p')::uuid)->>'can_upload_proof')::boolean, 'with 2 files, can_upload_proof = true');
end $$;
select test.expect_rows($$insert into storage.objects (bucket_id, name) values ('payment-proofs', current_setting('test.p') || '/3.webp')$$, 1);
select test.expect_sqlstate($$insert into storage.objects (bucket_id, name) values ('payment-proofs', current_setting('test.p') || '/4.jpg')$$, '42501');
do $$ begin
  perform test.assert(not (get_order_by_token(current_setting('test.p')::uuid)->>'can_upload_proof')::boolean, 'with 3 files, can_upload_proof = false');
  perform test.assert(not can_upload_payment_proof(current_setting('test.p') || '/5.jpg'), 'policy helper refuses a 4th file');
end $$;
-- The receipt can still be attached (it's already uploaded)
select test.expect_rows($$select attach_payment_proof(current_setting('test.p')::uuid, current_setting('test.p') || '/3.webp')$$, 1);
rollback;
```

---

## 16. Storefront catalog view and product reviews

`catalog_products` is what the shop pages query. It only contains visible products, and it computes the "from" price, stock state and default variant in the database. `product_reviews` returns only approved reviews from orders that contain the product.

```sql
begin;
select test.fixture();
select test.login(null);
do $$
declare r record;
begin
  perform test.assert(not exists (select 1 from catalog_products where id in (900004, 900005)),
                      'inactive product and product without active variants are not in the catalog');
  select * into r from catalog_products where id = 900002;
  perform test.assert(r.from_price = 3 and r.variant_count = 2 and r.in_stock and r.category_key = 'soap',
                      'soap B: from 3 JD, 2 variants, in stock');
  perform test.assert(r.default_variant_id = 900013 and r.default_variant_stock = 1, 'default variant = cheapest in stock');
  select * into r from catalog_products where id = 900003;
  perform test.assert(r.from_price = 20 and r.variant_count = 1, 'perfume: inactive 100ml variant ignored');
  perform test.assert((select count(*) from catalog_products where id between 900001 and 900003
                       and search like '%' || normalize_ar('إختبار') || '%') = 3, 'Arabic-normalized search on the view');
end $$;

reset role;
update product_variants set stock = 0 where id = 900013;
select test.login(null);
do $$
declare r record;
begin
  select * into r from catalog_products where id = 900002;
  perform test.assert(r.in_stock and r.default_variant_id = 900012 and r.from_price = 3,
                      'cheapest variant sold out → default moves to an in-stock variant; from price unchanged');
end $$;
reset role;
update product_variants set stock = 0 where id = 900012;
select test.login(null);
do $$ begin
  perform test.assert(not (select in_stock from catalog_products where id = 900002), 'all variants sold out → in_stock = false');
end $$;

-- Reviews: pending ones don't count; only products in the reviewed order
do $$
declare r jsonb;
begin
  r := place_order(test.payload('[{"variant_id":900011,"qty":1}]', '0790000131'));
  perform set_config('test.pr', r->>'public_token', true);
end $$;
select test.login('00000000-0000-0000-0000-00000000000b');
do $$
declare v_id uuid := (select id from orders where public_token = current_setting('test.pr')::uuid);
begin
  perform update_order_status(v_id, 'confirmed');
  perform update_order_status(v_id, 'with_courier');
  perform update_order_status(v_id, 'delivered');
  perform set_config('test.pr_id', v_id::text, true);
end $$;
select test.login(null);
select submit_review(current_setting('test.pr')::uuid, 4, 'جيد جدًا');
do $$ begin
  perform test.assert((product_reviews(900001)->>'count')::int = 0, 'pending review not counted');
end $$;
select test.login('00000000-0000-0000-0000-00000000000b');
update reviews set status = 'approved' where order_id = current_setting('test.pr_id')::uuid;
select test.login(null);
do $$
declare r jsonb := product_reviews(900001);
begin
  perform test.assert((r->>'count')::int = 1 and (r->>'average')::numeric = 4, 'approved review counted, average 4');
  perform test.assert(r->'reviews'->0->>'body' = 'جيد جدًا' and not (r->'reviews'->0 ? 'id'), 'review returned without internal ids');
  perform test.assert((product_reviews(900002)->>'count')::int = 0, 'other products get no reviews from this order');
end $$;
rollback;
```

---

## 17. Staff dashboard and Realtime (admin core)

`staff_overview()` is for staff and owners (no revenue). Realtime must publish `orders` only, so every subscriber is filtered by the orders RLS policy.

```sql
begin;
select test.fixture();

select test.login(null);
select test.expect_sqlstate($$select staff_overview()$$, '42501');

select test.login('00000000-0000-0000-0000-00000000000c');  -- customer
select test.expect_error($$select staff_overview()$$, 'NOT_AUTHORIZED');

select test.login('00000000-0000-0000-0000-00000000000b');  -- staff
do $$
declare r jsonb;
begin
  r := staff_overview();
  perform test.assert((r->>'new_count') ~ '^[0-9]+$' and jsonb_typeof(r->'flagged_cliq_orders') = 'array'
                      and jsonb_typeof(r->'low_stock') = 'array', 'staff gets pending counts, flagged CliQ and low stock');
  perform test.assert(not (r ? 'revenue'), 'staff overview has no revenue');
end $$;

select test.login('00000000-0000-0000-0000-00000000000a');  -- owner
select test.assert((staff_overview()->>'cliq_window_hours')::int >= 1, 'owner can read the overview too');

-- Realtime publishes the orders table and nothing sensitive besides
reset role;
do $$
begin
  perform test.assert(not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
                      or exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                                 and schemaname = 'public' and tablename = 'orders'),
                      'orders is in the supabase_realtime publication');
  perform test.assert(not exists (select 1 from pg_publication_tables
                                  where pubname = 'supabase_realtime' and schemaname = 'public'
                                    and tablename in ('settings', 'coupons', 'staff', 'order_notes', 'profiles', 'addresses', 'order_status_history')),
                      'no other private table is published to Realtime');
end $$;
rollback;
```

---

## 99. Remove test helpers

```sql
drop schema test cascade;
```
