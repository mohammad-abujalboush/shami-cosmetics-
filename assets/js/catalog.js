// Storefront catalog: data access over the catalog_products view, product cards, image helpers.
// Prices shown here are display-only; the cart and checkout always re-price in Postgres.
import { SUPABASE_URL, PRODUCT_IMAGES_BUCKET, SHOP_PAGE_SIZE } from './config.js';
import { t, html, raw, formatPrice, formatNumber, normalizeArabic, toAppError, AppError } from './utils.js';

const client = async () => {
  const mod = await import('./supabase.js');
  return mod.requireClient();
};

export const CARD_COLUMNS = [
  'id', 'slug', 'name_ar', 'name_en', 'gender', 'is_bestseller', 'category_key', 'category_slug', 'category_name_ar',
  'from_price', 'from_compare_at_price', 'in_stock', 'variant_count', 'default_variant_id', 'default_variant_stock',
  'image_path', 'image_alt_ar',
].join(', ');

// Men / women filters also include unisex products.
export const GENDER_FILTER = { men: ['men', 'unisex'], women: ['women', 'unisex'] };

// Categories whose products have a gender (perfume lines).
export const GENDERED_CATEGORIES = ['twins_perfumes', 'twins_unity'];

const SORTS = {
  best: [['is_bestseller', false], ['sort', true], ['id', true]],
  new: [['created_at', false], ['id', false]],
  price_asc: [['from_price', true], ['id', true]],
  price_desc: [['from_price', false], ['id', true]],
};
export const SORT_KEYS = Object.keys(SORTS);

// Escape LIKE wildcards in what the user typed, then match the normalized search column.
function searchPattern(query) {
  return `%${normalizeArabic(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * queryCatalog({ categorySlug, categoryKey, gender, inStock, bestseller, search, sort,
 *                excludeId, ids, offset, limit, count }) → { rows, count }
 */
export async function queryCatalog(opts = {}) {
  const sb = await client();
  let q = sb.from('catalog_products').select(CARD_COLUMNS, opts.count ? { count: 'exact' } : undefined);
  if (opts.categorySlug) q = q.eq('category_slug', opts.categorySlug);
  if (opts.categoryKey) q = q.eq('category_key', opts.categoryKey);
  if (opts.gender && GENDER_FILTER[opts.gender]) q = q.in('gender', GENDER_FILTER[opts.gender]);
  if (opts.inStock) q = q.eq('in_stock', true);
  if (opts.bestseller) q = q.eq('is_bestseller', true);
  if (opts.excludeId) q = q.neq('id', opts.excludeId);
  if (opts.ids) q = q.in('id', opts.ids);
  if (opts.search && normalizeArabic(opts.search)) q = q.ilike('search', searchPattern(opts.search));
  for (const [col, ascending] of SORTS[opts.sort] || SORTS.best) q = q.order(col, { ascending });
  const offset = opts.offset || 0;
  const limit = opts.limit || SHOP_PAGE_SIZE;
  q = q.range(offset, offset + limit - 1);
  const { data, error, count } = await q;
  if (error) throw toAppError(error);
  return { rows: data ?? [], count: count ?? null };
}

// Full product for the product page (RLS returns visible products and active variants only).
export async function fetchProduct(slug) {
  const sb = await client();
  const { data, error } = await sb.from('products')
    .select(`id, slug, name_ar, name_en, description_ar, gender, tags, is_bestseller, category_id,
             categories ( key, slug, name_ar ),
             product_variants ( id, label, sku, price, compare_at_price, stock, low_stock_threshold, sort ),
             product_images ( path, alt_ar, sort )`)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw toAppError(error);
  if (!data || !data.product_variants?.length) throw new AppError('NOT_FOUND');
  data.product_variants.sort((a, b) => a.sort - b.sort || a.price - b.price || a.id - b.id);
  data.product_images = (data.product_images || []).sort((a, b) => a.sort - b.sort);
  return data;
}

export async function fetchProductReviews(productId, maxRows = 10) {
  const { rpc } = await import('./supabase.js');
  return rpc('product_reviews', { product_id: productId, max_rows: maxRows });
}

/* ---------- Images ---------- */

export function imageUrl(path) {
  if (!path) return '';
  const encoded = String(path).split('/').map(encodeURIComponent).join('/');
  return `${SUPABASE_URL}/storage/v1/object/public/${PRODUCT_IMAGES_BUCKET}/${encoded}`;
}

const TONES = [
  ['#1C1712', '#B8923F'], ['#2A2118', '#D9B96C'], ['#6B6255', '#EFE2C0'], ['#D9B96C', '#1C1712'],
];

// Brand-styled illustration used until the owner uploads real photos (same shapes as demo.html).
export function placeholderSvg(categoryKey, seed = 0) {
  const [body, accent] = TONES[Math.abs(Number(seed) || 0) % TONES.length];
  const shapes = {
    soap: `<rect x="20" y="30" width="60" height="46" rx="12" fill="${body}"/><path d="M32 30c0-12 8-18 18-18s18 6 18 18" stroke="${accent}" stroke-width="3" fill="none"/>`,
    twins_perfumes: `<rect x="34" y="34" width="32" height="46" rx="6" fill="${body}"/><rect x="42" y="20" width="16" height="16" rx="3" fill="${accent}"/>`,
    twins_unity: `<rect x="22" y="38" width="24" height="42" rx="5" fill="${body}"/><rect x="28" y="26" width="12" height="13" rx="3" fill="${accent}"/><rect x="54" y="38" width="24" height="42" rx="5" fill="${accent}"/><rect x="60" y="26" width="12" height="13" rx="3" fill="${body}"/>`,
    gift_boxes: `<rect x="18" y="40" width="64" height="40" rx="4" fill="${body}"/><path d="M18 54h64M50 40v40" stroke="${accent}" stroke-width="3"/><path d="M38 40c0-8 5-13 12-13s12 5 12 13" stroke="${accent}" stroke-width="3" fill="none"/>`,
  };
  return `<svg viewBox="0 0 100 100" fill="none" aria-hidden="true" focusable="false">${shapes[categoryKey] || shapes.soap}</svg>`;
}

export function productMedia(p, { eager = false } = {}) {
  if (p.image_path) {
    return html`<img src="${imageUrl(p.image_path)}" alt="${p.image_alt_ar || p.name_ar}" width="400" height="300"
      loading="${eager ? 'eager' : 'lazy'}" decoding="async">`;
  }
  return raw(placeholderSvg(p.category_key, p.id));
}

/* ---------- Prices & reviews ---------- */

export function hasCompare(price, compareAt) {
  return compareAt != null && Number(compareAt) > Number(price);
}

// "−2 د.أ" kept in LTR order inside RTL text
export function discountHtml(amount) {
  return html`<span dir="ltr" class="num">−${formatNumber(amount)}</span> ${t('common.currency')}`;
}

export function starsHtml(rating) {
  const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return html`<span class="stars" role="img" aria-label="${t('home.starsAria', { n })}">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;
}

/* ---------- Product card ---------- */

export function productCard(p, { reveal = '' } = {}) {
  const url = `/product.html?slug=${encodeURIComponent(p.slug)}`;
  const single = Number(p.variant_count) === 1;
  const onSale = single && hasCompare(p.from_price, p.from_compare_at_price);
  let badge = '';
  if (!p.in_stock) badge = html`<span class="prod-badge">${t('catalog.soldOut')}</span>`;
  else if (onSale) badge = html`<span class="prod-badge sale">${t('catalog.sale')}</span>`;
  else if (p.is_bestseller) badge = html`<span class="prod-badge">${t('catalog.bestseller')}</span>`;

  const sub = [p.category_name_ar, p.gender && GENDERED_CATEGORIES.includes(p.category_key) ? t(`catalog.gender.${p.gender}`) : '']
    .filter(Boolean).join(' · ');

  let action;
  if (!p.in_stock) {
    action = html`<button type="button" class="btn outline sm" disabled>${t('catalog.soldOut')}</button>`;
  } else if (!single) {
    action = html`<a class="btn outline sm" href="${url}">${t('catalog.chooseSize')}</a>`;
  } else {
    action = html`<button type="button" class="btn outline sm" data-add-variant="${p.default_variant_id}"
      data-max="${p.default_variant_stock}" aria-label="${t('catalog.addToCartAria', { name: p.name_ar })}">${t('catalog.addToCart')}</button>`;
  }

  return html`
    <article class="prod-card ${reveal} ${p.in_stock ? '' : 'is-soldout'}">
      <div class="prod-media">${badge}${productMedia(p)}</div>
      <div class="prod-body">
        <h3 class="prod-title"><a href="${url}">${p.name_ar}</a></h3>
        ${sub ? html`<p class="prod-desc">${sub}</p>` : ''}
        <div class="prod-foot">
          <span class="price">${single ? '' : html`<span class="from">${t('catalog.from')}</span> `}${formatPrice(p.from_price)}${onSale ? html`<span class="compare">${formatPrice(p.from_compare_at_price)}</span>` : ''}</span>
          ${action}
        </div>
      </div>
    </article>`;
}

export function productCards(rows, opts) {
  return html`${rows.map((p, i) => productCard(p, typeof opts === 'function' ? opts(p, i) : opts))}`;
}

export function skeletonCards(n = 6) {
  return raw(Array.from({ length: n }, () => `
    <div class="prod-card skeleton-card" aria-hidden="true">
      <div class="prod-media skeleton"></div>
      <div class="prod-body"><div class="skeleton sk-line"></div><div class="skeleton sk-line short"></div></div>
    </div>`).join(''));
}
