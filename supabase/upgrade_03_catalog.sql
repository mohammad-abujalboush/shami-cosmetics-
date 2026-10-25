-- =====================================================================
-- Shami Cosmetics — upgrade 03: storefront catalog view + product reviews
--
-- Only for a project installed before this change (already ran upgrade_02 + 02b).
-- A fresh install doesn't need it: 01 and 03 contain the same definitions.
-- Idempotent. Run it, then run 02b_grants.sql again.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Storefront catalog view: one row per visible product with its "from" price, stock state and
-- first image, so the shop can filter / sort / search / paginate in the database.
-- security_invoker = true → the caller's RLS applies (only active, visible rows are aggregated).
-- ---------------------------------------------------------------------
create or replace view catalog_products with (security_invoker = true) as
select p.id, p.slug, p.name_ar, p.name_en, p.description_ar, p.gender, p.tags, p.is_bestseller,
       p.sort, p.created_at, p.search,
       p.category_id, c.key as category_key, c.slug as category_slug, c.name_ar as category_name_ar,
       v.from_price, v.from_compare_at_price, v.in_stock, v.variant_count,
       v.default_variant_id, v.default_variant_stock,
       img.path as image_path, img.alt_ar as image_alt_ar
from products p
join categories c on c.id = p.category_id
cross join lateral (
  select min(pv.price) as from_price,
         (array_agg(pv.compare_at_price order by pv.price, pv.sort, pv.id))[1] as from_compare_at_price,
         coalesce(bool_or(pv.stock > 0), false) as in_stock,
         count(*)::integer as variant_count,
         -- cheapest in-stock variant first (used by "add to cart" on single-variant cards)
         (array_agg(pv.id    order by (pv.stock > 0) desc, pv.price, pv.sort, pv.id))[1] as default_variant_id,
         (array_agg(pv.stock order by (pv.stock > 0) desc, pv.price, pv.sort, pv.id))[1] as default_variant_stock
  from product_variants pv
  where pv.product_id = p.id and pv.active
) v
left join lateral (
  select i.path, i.alt_ar from product_images i where i.product_id = p.id order by i.sort, i.id limit 1
) img on true
where p.active and c.active and v.variant_count > 0;

-- Approved reviews for a product (reviews belong to orders, which guests can't read).
-- Returns { count, average, reviews: [{ rating, body, display_name, governorate_name, created_at }] }.
create or replace function product_reviews(product_id bigint, max_rows integer default 10)
returns jsonb language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_product_id bigint  := product_id;
  v_limit      integer := least(greatest(coalesce(max_rows, 10), 1), 50);
begin
  return (
    with r as (
      select rv.id, rv.rating, rv.body, rv.display_name, rv.governorate_name, rv.created_at
      from reviews rv
      where rv.status = 'approved'
        and exists (select 1 from order_items oi where oi.order_id = rv.order_id and oi.product_id = v_product_id)
    )
    select jsonb_build_object(
      'count',   (select count(*) from r),
      'average', (select round(avg(r.rating), 1) from r),
      'reviews', (select coalesce(jsonb_agg(to_jsonb(x) - 'id' order by x.created_at desc, x.id desc), '[]'::jsonb)
                  from (select * from r order by r.created_at desc, r.id desc limit v_limit) x))
  );
end $$;

-- API access (02b re-applies the full set)
grant select on catalog_products to anon, authenticated;
revoke execute on function product_reviews(bigint, integer) from public, anon, authenticated;
grant execute on function product_reviews(bigint, integer) to anon, authenticated;
