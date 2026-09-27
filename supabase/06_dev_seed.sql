-- =====================================================================
-- Shami Cosmetics — 06 DEV SEED  ⚠ local / testing projects only — never on the live store
--
-- Realistic sample data for building and testing pages:
--   4 soaps, 3 TWINS perfumes (30/50/100ml: one variant out of stock, one low stock),
--   1 TWINS UNITY set, 1 gift box, a 3-for-10 soap bundle ending 5 days from now,
--   2 coupons (DEV10, DEV2JD), 3 approved reviews (on 3 delivered demo orders DEV-1..3),
--   3 quiz questions with tagged options, governorate fees, obviously fake WhatsApp/CliQ settings.
--
-- Every seeded product / offer / quiz question / order name starts with "[تجربة]".
-- Everything created is recorded in the private schema dev_seed, and the settings and
-- governorate rows it changes are backed up there, so 99_remove_dev_seed.sql can undo it
-- exactly without touching real data.
-- Refuses to run twice. Run after 01–04 (and 05 if you want an owner).
-- =====================================================================

do $$
declare
  v_soap  bigint := (select id from public.categories where key = 'soap');
  v_perf  bigint := (select id from public.categories where key = 'twins_perfumes');
  v_unity bigint := (select id from public.categories where key = 'twins_unity');
  v_gift  bigint := (select id from public.categories where key = 'gift_boxes');
  v_desc  text   := '[تجربة] منتج تجريبي لاختبار المتجر — لا يُباع.';
  v_p     bigint;
  v_q     bigint;
  v_o     uuid;
  v_v     bigint;
  v_id    bigint;
  r       record;
begin
  if to_regnamespace('dev_seed') is not null then
    raise exception 'REFUSED: the dev seed is already installed. Run 99_remove_dev_seed.sql first.';
  end if;
  if v_soap is null or v_perf is null or v_unity is null or v_gift is null then
    raise exception 'REFUSED: seed categories (soap, twins_perfumes, twins_unity, gift_boxes) are missing.';
  end if;

  -- Bookkeeping (private schema: not exposed to the API, not granted to anyone)
  create schema dev_seed;
  revoke all on schema dev_seed from public;
  create table dev_seed.created (kind text not null, id text not null);
  create table dev_seed.backup_settings as select * from public.settings;
  create table dev_seed.backup_governorates as select id, delivery_fee, active, sort, updated_at from public.governorates;

  -- ---------- Products ----------
  for r in select * from (values
    -- category, name_ar, name_en, slug, gender, tags, bestseller, sort
    (v_soap,  '[تجربة] صابون الغار',          'Dev Laurel Soap',       'dev-laurel-soap',      null,     '{sensitive,dry}',  true,  1),
    (v_soap,  '[تجربة] صابون العنبر الأسود',  'Dev Black Amber Soap',  'dev-black-amber-soap', null,     '{oily,whitening}', true,  2),
    (v_soap,  '[تجربة] صابون الزيتون',        'Dev Olive Soap',        'dev-olive-soap',       null,     '{dry,sensitive}',  false, 3),
    (v_soap,  '[تجربة] صابون الكبريت',        'Dev Sulfur Soap',       'dev-sulfur-soap',      null,     '{acne,oily}',      false, 4),
    (v_perf,  '[تجربة] TWINS No.12 رجالي',    'Dev TWINS No.12',       'dev-twins-no-12',      'men',    '{}',               true,  1),
    (v_perf,  '[تجربة] TWINS No.07 نسائي',    'Dev TWINS No.07',       'dev-twins-no-07',      'women',  '{}',               false, 2),
    (v_perf,  '[تجربة] TWINS No.24 للجنسين',  'Dev TWINS No.24',       'dev-twins-no-24',      'unisex', '{}',               false, 3),
    (v_unity, '[تجربة] طقم TWINS UNITY',      'Dev TWINS UNITY Set',   'dev-twins-unity-set',  'unisex', '{}',               false, 1),
    (v_gift,  '[تجربة] بوكس هدية فاخر',       'Dev Luxury Gift Box',   'dev-luxury-gift-box',  null,     '{}',               false, 1)
  ) t(category_id, name_ar, name_en, slug, gender, tags, bestseller, sort) loop
    insert into public.products (category_id, name_ar, name_en, slug, description_ar, gender, tags, is_bestseller, active, sort)
    values (r.category_id, r.name_ar, r.name_en, r.slug, v_desc, r.gender::gender_t, r.tags::text[], r.bestseller, true, r.sort)
    returning id into v_p;
    insert into dev_seed.created values ('product', v_p);
  end loop;

  -- ---------- Variants (slug, label, sku, price, compare_at, stock) ----------
  insert into public.product_variants (product_id, label, sku, price, compare_at_price, stock, sort)
  select p.id, v.label, v.sku, v.price, v.compare_at, v.stock, v.sort
  from (values
    ('dev-laurel-soap',      'قطعة واحدة', 'DEV-SOAP-LAUREL',  4.000, null::numeric, 60, 1),
    ('dev-black-amber-soap', 'قطعة واحدة', 'DEV-SOAP-AMBER',   4.500, null,          40, 1),
    ('dev-olive-soap',       'قطعة واحدة', 'DEV-SOAP-OLIVE',   3.500, null,          80, 1),
    ('dev-sulfur-soap',      'قطعة واحدة', 'DEV-SOAP-SULFUR',  4.000, 5.000,         25, 1),
    ('dev-twins-no-12',      '30ml',       'DEV-TW12-30',     10.000, null,          15, 1),
    ('dev-twins-no-12',      '50ml',       'DEV-TW12-50',     15.000, null,           3, 2),  -- low stock
    ('dev-twins-no-12',      '100ml',      'DEV-TW12-100',    25.000, 30.000,        12, 3),
    ('dev-twins-no-07',      '30ml',       'DEV-TW07-30',     11.000, null,          20, 1),
    ('dev-twins-no-07',      '50ml',       'DEV-TW07-50',     16.000, null,           9, 2),
    ('dev-twins-no-07',      '100ml',      'DEV-TW07-100',    26.000, null,           0, 3),  -- out of stock
    ('dev-twins-no-24',      '30ml',       'DEV-TW24-30',      9.500, null,          30, 1),
    ('dev-twins-no-24',      '50ml',       'DEV-TW24-50',     14.000, null,          18, 2),
    ('dev-twins-no-24',      '100ml',      'DEV-TW24-100',    22.000, null,           7, 3),
    ('dev-twins-unity-set',  'طقم',        'DEV-UNITY-SET',   35.000, 40.000,         6, 1),
    ('dev-luxury-gift-box',  'بوكس',       'DEV-GIFT-BOX',    28.000, null,          10, 1)
  ) v(slug, label, sku, price, compare_at, stock, sort)
  join public.products p on p.slug = v.slug;

  -- ---------- Bundle offer: 3 soaps for 10 JD, ending 5 days from now ----------
  if exists (select 1 from public.offers o
             where o.category_id = v_soap and o.active and o.ends_at > now()) then
    raise notice 'Skipped the bundle offer: an active soap offer already exists in this project.';
  else
    insert into public.offers (name_ar, description_ar, category_id, quantity, bundle_price, starts_at, ends_at, active, show_countdown)
    values ('[تجربة] 3 صابونات بـ10 دنانير', '[تجربة] اختيار أي 3 أنواع من صابون الشامي بسعر خاص.',
            v_soap, 3, 10, now(), now() + interval '5 days', true, true)
    returning id into v_id;
    insert into dev_seed.created values ('offer', v_id);
  end if;

  -- ---------- Coupons ----------
  for r in select * from (values
    ('DEV10',  'percent'::coupon_type, 10.000, 5.000,          0.000),
    ('DEV2JD', 'fixed'::coupon_type,    2.000, null::numeric, 15.000)
  ) c(code, type, value, max_discount, min_order) loop
    if exists (select 1 from public.coupons where code = r.code) then
      raise notice 'Skipped coupon %: the code already exists in this project.', r.code;
    else
      insert into public.coupons (code, type, value, max_discount, min_order, active)
      values (r.code, r.type, r.value, r.max_discount, r.min_order, true)
      returning id into v_id;
      insert into dev_seed.created values ('coupon', v_id);
    end if;
  end loop;

  -- ---------- Quiz ----------
  insert into public.quiz_questions (question_ar, sort) values ('[تجربة] ما نوع البشرة؟', 1) returning id into v_q;
  insert into dev_seed.created values ('quiz_question', v_q);
  insert into public.quiz_options (question_id, label_ar, tags, sort) values
    (v_q, 'جافة', '{dry}', 1), (v_q, 'دهنية', '{oily}', 2), (v_q, 'حساسة', '{sensitive}', 3), (v_q, 'عادية', '{}', 4);

  insert into public.quiz_questions (question_ar, sort) values ('[تجربة] ما المشكلة الأكثر إزعاجًا؟', 2) returning id into v_q;
  insert into dev_seed.created values ('quiz_question', v_q);
  insert into public.quiz_options (question_id, label_ar, tags, sort) values
    (v_q, 'حبوب وبثور', '{acne}', 1), (v_q, 'بقع وتصبغات', '{whitening}', 2),
    (v_q, 'جفاف وتقشر', '{dry}', 3), (v_q, 'لا توجد مشكلة محددة', '{}', 4);

  insert into public.quiz_questions (question_ar, sort) values ('[تجربة] ما النتيجة المطلوبة من الصابون؟', 3) returning id into v_q;
  insert into dev_seed.created values ('quiz_question', v_q);
  insert into public.quiz_options (question_id, label_ar, tags, sort) values
    (v_q, 'تنظيف عميق', '{oily,acne}', 1), (v_q, 'ترطيب ونعومة', '{dry,sensitive}', 2), (v_q, 'توحيد لون البشرة', '{whitening}', 3);

  -- ---------- 3 delivered demo orders + approved reviews ----------
  -- Order numbers DEV-n (not SH-) so the real sequence is never consumed.
  for r in select * from (values
    (1, 'dev-laurel-soap',     'سارة', 'عمّان',   5, '[تجربة] صابون الغار مريح جدًا للبشرة الحساسة، والتغليف أنيق.', true),
    (2, 'dev-twins-no-12',     'أحمد', 'إربد',    5, '[تجربة] الثبات ممتاز والرائحة مميزة، والتوصيل كان سريعًا.',   true),
    (3, 'dev-luxury-gift-box', 'ليان', 'الزرقاء', 4, '[تجربة] البوكس مناسب كهدية، والتواصل عبر واتساب سهل.',        false)
  ) x(n, slug, first_name, gov_name, rating, body, featured) loop
    select pv.id into v_v from public.product_variants pv join public.products p on p.id = pv.product_id
    where p.slug = r.slug order by pv.sort limit 1;

    insert into public.orders (order_number, customer_name, phone, governorate_id, governorate_name, area, address_details,
                               payment_method, payment_status, status, subtotal, delivery_fee, total, paid_at, delivered_at,
                               created_at)
    select 'DEV-' || r.n, '[تجربة] ' || r.first_name, '96279000000' || r.n, g.id, g.name_ar,
           '[تجربة] منطقة', '[تجربة] عنوان وهمي', 'cod', 'paid', 'delivered',
           pv.price, 3, pv.price + 3, now() - interval '2 days', now() - interval '2 days', now() - interval '4 days'
    from public.governorates g, public.product_variants pv
    where g.name_ar = r.gov_name and pv.id = v_v
    returning id into v_o;
    insert into dev_seed.created values ('order', v_o);

    insert into public.order_items (order_id, variant_id, product_id, product_name_ar, product_name_en, variant_label, sku,
                                    unit_price, quantity, line_total)
    select v_o, pv.id, p.id, p.name_ar, p.name_en, pv.label, pv.sku, pv.price, 1, pv.price
    from public.product_variants pv join public.products p on p.id = pv.product_id where pv.id = v_v;

    insert into public.reviews (order_id, rating, body, display_name, governorate_name, status, featured)
    values (v_o, r.rating, r.body, r.first_name, r.gov_name, 'approved', r.featured);
  end loop;

  -- ---------- Delivery fees & settings (backed up above) ----------
  update public.governorates set delivery_fee = case id
      when 1 then 2 when 3 then 2.5 when 12 then 4
      when 9 then 3.5 when 10 then 3.5 when 11 then 3.5
      else 3 end;
  update public.settings
  set store_whatsapp    = '962790000000',             -- 0790000000: obviously fake
      cliq_alias        = 'DEV-FAKE-ALIAS',
      cliq_account_name = '[تجربة] حساب وهمي';

  raise notice 'Dev seed installed. Remove it with 99_remove_dev_seed.sql.';
end $$;
