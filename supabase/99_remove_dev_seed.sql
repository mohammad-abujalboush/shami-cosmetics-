-- =====================================================================
-- Shami Cosmetics — 99 remove the dev seed
--
-- Undoes 06_dev_seed.sql exactly:
--   * deletes only rows the seed recorded in dev_seed.created (and double-checks their
--     "[تجربة]" / DEV- markers), including their stock-movement log rows;
--   * restores the settings row and governorate fees/flags to their pre-seed values
--     (updated_at included);
--   * drops the dev_seed schema.
-- Real data is never matched by name alone. Identity counters (e.g. the next product id)
-- are not rewound; that is harmless.
-- =====================================================================

do $$
begin
  if to_regnamespace('dev_seed') is null then
    raise exception 'NOTHING TO REMOVE: the dev seed is not installed (schema dev_seed not found).';
  end if;

  -- Demo orders (cascades to items, status history, notes, reviews)
  delete from public.orders o
  using dev_seed.created c
  where c.kind = 'order' and o.id = c.id::uuid and o.order_number like 'DEV-%';

  -- Stock-movement rows of seeded variants, then the products (cascades to variants and images)
  delete from public.stock_movements m
  using public.product_variants v, dev_seed.created c
  where c.kind = 'product' and v.product_id = c.id::bigint and m.variant_id = v.id;

  delete from public.products p
  using dev_seed.created c
  where c.kind = 'product' and p.id = c.id::bigint and p.name_ar like '[تجربة]%';

  delete from public.offers o
  using dev_seed.created c
  where c.kind = 'offer' and o.id = c.id::bigint and o.name_ar like '[تجربة]%';

  delete from public.coupons k
  using dev_seed.created c
  where c.kind = 'coupon' and k.id = c.id::bigint and k.code like 'DEV%';

  delete from public.quiz_questions q  -- cascades to options
  using dev_seed.created c
  where c.kind = 'quiz_question' and q.id = c.id::bigint and q.question_ar like '[تجربة]%';

  -- Restore settings and governorates exactly (skip the updated_at trigger for this restore)
  alter table public.settings disable trigger settings_set_updated_at;
  update public.settings s
  set store_whatsapp          = b.store_whatsapp,
      cliq_alias              = b.cliq_alias,
      cliq_account_name       = b.cliq_account_name,
      cliq_window_hours       = b.cliq_window_hours,
      free_delivery_threshold = b.free_delivery_threshold,
      top_bar_messages        = b.top_bar_messages,
      homepage_stats          = b.homepage_stats,
      return_policy_ar        = b.return_policy_ar,
      social_links            = b.social_links,
      store_open              = b.store_open,
      updated_at              = b.updated_at
  from dev_seed.backup_settings b
  where s.id = b.id;
  alter table public.settings enable trigger settings_set_updated_at;

  alter table public.governorates disable trigger governorates_set_updated_at;
  update public.governorates g
  set delivery_fee = b.delivery_fee, active = b.active, sort = b.sort, updated_at = b.updated_at
  from dev_seed.backup_governorates b
  where g.id = b.id;
  alter table public.governorates enable trigger governorates_set_updated_at;

  drop schema dev_seed cascade;
  raise notice 'Dev seed removed.';
end $$;
