// Product: /product.html?slug=<slug>[&v=<variant id>]
// Gallery, variant selector (price / compare price / stock), quantity limited by stock minus what is
// already in the cart, add to cart, approved reviews, related products, title + meta tags.
import '../layout.js';
import { t, html, raw, formatPrice, formatNumber, getParam, showLoading, showError, toast, toWesternDigits } from '../utils.js';
import { fetchProduct, fetchProductReviews, queryCatalog, productCards, skeletonCards, imageUrl, placeholderSvg,
         hasCompare, starsHtml, GENDERED_CATEGORIES } from '../catalog.js';
import { addItem, cartQty } from '../cart.js';

const root = document.querySelector('[data-slot="product"]');
const slug = getParam('slug');
let product = null;
let variant = null;

function setMeta(name, value, attr = 'name') {
  let el = document.head.querySelector(`meta[${attr}="${name}"]`);
  if (!el) { el = document.createElement('meta'); el.setAttribute(attr, name); document.head.append(el); }
  el.setAttribute('content', value);
}

function applySeo(p) {
  const title = t('product.metaTitle', { name: p.name_ar });
  const description = String(p.description_ar || '').replace(/\s+/g, ' ').trim().slice(0, 155);
  document.title = title;
  setMeta('description', description);
  setMeta('og:title', title, 'property');
  setMeta('og:description', description, 'property');
  setMeta('og:url', location.href, 'property');
  setMeta('og:image', p.product_images[0] ? imageUrl(p.product_images[0].path) : '', 'property');
  // Structured data for search engines (display prices only; the cart re-prices in Postgres)
  const prices = p.product_variants.map((v) => Number(v.price));
  const ld = document.createElement('script');
  ld.type = 'application/ld+json';
  ld.textContent = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', name: p.name_ar, description,
    image: p.product_images.map((i) => imageUrl(i.path)), brand: { '@type': 'Brand', name: 'Shami Cosmetics' },
    offers: { '@type': 'AggregateOffer', priceCurrency: 'JOD', lowPrice: Math.min(...prices), highPrice: Math.max(...prices),
              availability: p.product_variants.some((v) => v.stock > 0) ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
  });
  document.head.append(ld);
}

/* ---------- Render ---------- */

function galleryHtml(p) {
  const images = p.product_images;
  const main = images.length
    ? html`<img src="${imageUrl(images[0].path)}" alt="${images[0].alt_ar || p.name_ar}" width="800" height="800" data-main-img>`
    : raw(placeholderSvg(p.categories?.key, p.id));
  return html`
    <div class="gallery" role="region" aria-label="${t('product.gallery')}">
      <div class="gallery-main">${main}</div>
      ${images.length > 1 ? html`
        <div class="gallery-thumbs">
          ${images.map((img, i) => html`
            <button type="button" data-thumb="${i}" aria-label="${t('product.thumb', { n: i + 1 })}" aria-current="${String(i === 0)}">
              <img src="${imageUrl(img.path)}" alt="" width="72" height="72" loading="lazy">
            </button>`)}
        </div>` : ''}
    </div>`;
}

function productHtml(p) {
  const c = p.categories;
  const gender = p.gender && GENDERED_CATEGORIES.includes(c?.key) ? t(`catalog.gender.${p.gender}`) : '';
  const multi = p.product_variants.length > 1;
  return html`
    <nav class="breadcrumb" aria-label="${t('product.breadcrumb')}">
      <a href="/">${t('product.home')}</a>
      <svg class="sep icon-dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      ${c ? html`<a href="/shop.html?c=${encodeURIComponent(c.slug)}">${c.name_ar}</a>
      <svg class="sep icon-dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>` : ''}
      <span aria-current="page">${p.name_ar}</span>
    </nav>
    <div class="product-grid">
      ${galleryHtml(p)}
      <div class="product-info">
        ${p.is_bestseller ? html`<span class="badge dark">${t('catalog.bestseller')}</span>` : ''}
        <h1>${p.name_ar}</h1>
        ${p.name_en || gender ? html`<p class="name-en">${p.name_en ? html`<span dir="ltr">${p.name_en}</span>` : ''}${p.name_en && gender ? ' · ' : ''}${gender}</p>` : ''}
        <div class="product-price" aria-live="polite" data-slot="price"></div>
        <p class="stock-line" data-slot="stock" aria-live="polite"></p>
        <form class="product-form" data-slot="form" novalidate>
          ${multi ? html`
            <fieldset class="field">
              <legend class="label">${t('product.variantLabel')}</legend>
              <div class="pills">
                ${p.product_variants.map((v) => html`
                  <label class="pill">
                    <input type="radio" name="variant" value="${v.id}" ${v.id === variant.id ? raw('checked') : ''}>
                    <span>${v.label}</span>
                  </label>`)}
              </div>
            </fieldset>` : ''}
          <div class="field">
            <label class="label" for="qty">${t('product.qtyLabel')}</label>
            <div class="buy-row">
              <div class="qty">
                <button type="button" data-step="-1" aria-label="${t('cart.decrease')}">−</button>
                <input id="qty" name="qty" type="text" inputmode="numeric" value="1" autocomplete="off">
                <button type="button" data-step="1" aria-label="${t('cart.increase')}">+</button>
              </div>
              <button type="submit" class="btn primary" data-slot="add">${t('catalog.addToCart')}</button>
            </div>
            <p class="field-error" data-slot="qty-error" aria-live="polite"></p>
          </div>
        </form>
        <div class="product-desc">
          <h2>${t('product.description')}</h2>
          <p>${p.description_ar}</p>
        </div>
      </div>
    </div>`;
}

// Max that can still be added = stock − what is already in the cart
const remaining = () => Math.max(0, Math.min(99, variant.stock) - cartQty(variant.id));

function updateVariant() {
  const priceEl = root.querySelector('[data-slot="price"]');
  const onSale = hasCompare(variant.price, variant.compare_at_price);
  priceEl.innerHTML = html`
    <span class="price">${formatPrice(variant.price)}${onSale ? html`<span class="compare">${formatPrice(variant.compare_at_price)}</span>` : ''}</span>
    ${onSale ? html`<span class="badge success save">${t('product.save', { amount: formatPrice(variant.compare_at_price - variant.price) })}</span>` : ''}`.toString();

  const stockEl = root.querySelector('[data-slot="stock"]');
  const low = variant.stock > 0 && variant.stock <= (variant.low_stock_threshold ?? 5);
  stockEl.className = `stock-line ${variant.stock <= 0 ? 'out' : low ? 'low' : 'ok'}`;
  stockEl.textContent = variant.stock <= 0 ? t('product.outOfStock')
    : low ? t('product.lowStock', { count: formatNumber(variant.stock) }) : t('product.inStock');

  const qtyInput = root.querySelector('#qty');
  const addBtn = root.querySelector('[data-slot="add"]');
  const max = remaining();
  qtyInput.value = String(Math.min(Math.max(1, Number(qtyInput.value) || 1), Math.max(1, max)));
  const sold = variant.stock <= 0;
  addBtn.disabled = sold || max <= 0;
  addBtn.textContent = sold ? t('catalog.soldOut') : t('catalog.addToCart');
  root.querySelector('[data-step="1"]').disabled = sold || Number(qtyInput.value) >= max;
  root.querySelector('[data-step="-1"]').disabled = sold || Number(qtyInput.value) <= 1;
  root.querySelector('[data-slot="qty-error"]').textContent = !sold && max <= 0 ? t('catalog.qtyLimit', { max: variant.stock }) : '';
}

function bind() {
  const form = root.querySelector('[data-slot="form"]');
  const qtyInput = root.querySelector('#qty');

  form.addEventListener('change', (e) => {
    if (e.target.name !== 'variant') return;
    variant = product.product_variants.find((v) => v.id === Number(e.target.value));
    qtyInput.value = '1';
    updateVariant();
  });
  form.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (!step) return;
    qtyInput.value = String((Number(qtyInput.value) || 1) + Number(step.dataset.step));
    updateVariant();
  });
  qtyInput.addEventListener('change', () => {
    qtyInput.value = toWesternDigits(qtyInput.value).replace(/\D/g, '') || '1';
    updateVariant();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const qty = Math.max(1, Number(qtyInput.value) || 1);
    const result = addItem(variant.id, qty, { max: Math.min(99, variant.stock) });
    if (result.ok && !result.capped) toast(t('catalog.added'), { type: 'success' });
    else toast(t('catalog.qtyLimit', { max: result.max }), { type: 'error' });
    qtyInput.value = '1';
    updateVariant();
  });
  window.addEventListener('cart:change', updateVariant);

  // Gallery thumbnails
  root.querySelectorAll('[data-thumb]').forEach((btn) => btn.addEventListener('click', () => {
    const img = product.product_images[Number(btn.dataset.thumb)];
    const main = root.querySelector('[data-main-img]');
    main.src = imageUrl(img.path);
    main.alt = img.alt_ar || product.name_ar;
    root.querySelectorAll('[data-thumb]').forEach((b) => b.setAttribute('aria-current', String(b === btn)));
  }));
}

async function loadReviews() {
  const section = document.querySelector('[data-section="reviews"]');
  const slot = document.querySelector('[data-slot="reviews"]');
  try {
    const r = await fetchProductReviews(product.id, 10);
    section.hidden = false;
    if (!r.count) { slot.innerHTML = html`<p class="muted">${t('product.reviewsEmpty')}</p>`.toString(); return; }
    slot.innerHTML = html`
      <p class="reviews-summary">${starsHtml(r.average)} ${t('product.reviewsSummary', { avg: formatNumber(r.average), count: formatNumber(r.count) })}</p>
      <div class="reviews-list">
        ${r.reviews.map((rv) => html`
          <figure class="review-card">
            ${starsHtml(rv.rating)}
            ${rv.body ? html`<blockquote>${rv.body}</blockquote>` : ''}
            <figcaption class="who">— ${[rv.display_name, rv.governorate_name].filter(Boolean).join('، ')}</figcaption>
          </figure>`)}
      </div>`.toString();
  } catch (err) {
    console.error('[product] reviews', err);  // optional section: stay hidden on error
  }
}

async function loadRelated() {
  const section = document.querySelector('[data-section="related"]');
  const slot = document.querySelector('[data-slot="related"]');
  section.hidden = false;
  slot.innerHTML = skeletonCards(3).toString();
  try {
    const { rows } = await queryCatalog({ categorySlug: product.categories?.slug, excludeId: product.id, sort: 'best', limit: 3 });
    if (!rows.length) { section.hidden = true; return; }
    slot.innerHTML = productCards(rows).toString();
  } catch (err) {
    console.error('[product] related', err);
    section.hidden = true;
  }
}

async function main() {
  if (!slug) { notFound(); return; }
  showLoading(root);
  try {
    product = await fetchProduct(slug);
  } catch (err) {
    if (err.code === 'NOT_FOUND') notFound();
    else showError(root, { error: err, onRetry: main });
    return;
  }
  const requested = product.product_variants.find((v) => v.id === Number(getParam('v')));
  variant = requested
    || product.product_variants.find((v) => v.stock > 0)
    || product.product_variants[0];
  root.removeAttribute('aria-busy');
  root.innerHTML = productHtml(product).toString();
  applySeo(product);
  updateVariant();
  bind();
  loadReviews();
  loadRelated();
}

function notFound() {
  document.title = `${t('product.notFoundTitle')} | Shami Cosmetics`;
  setMeta('robots', 'noindex');
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="state state-empty">
      <p class="state-title">${t('product.notFoundTitle')}</p>
      <p class="state-text">${t('product.notFoundText')}</p>
      <a class="btn primary" href="/shop.html">${t('notFound.shop')}</a>
    </div>`.toString();
}

main();
