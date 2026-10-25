// Cart: localStorage holds ONLY [{ variant_id, qty }]. Every price, bundle saving and total shown in
// the drawer comes from calculate_cart in Postgres. Loaded on every store page by layout.js.
import { STORAGE_KEYS } from './config.js';
import { t, html, raw, formatPrice, toast, errorMessage, debounce, toAppError } from './utils.js';
import { imageUrl, placeholderSvg, discountHtml } from './catalog.js';

const MAX_LINE_QTY = 99;
const MAX_LINES = 50;

/* ---------- Store ---------- */

// Reads and sanitizes: positive integer ids, quantities 1–99, duplicates merged, at most 50 lines.
export function getCart() {
  let raw_;
  try { raw_ = JSON.parse(localStorage.getItem(STORAGE_KEYS.cart) || '[]'); } catch { raw_ = []; }
  if (!Array.isArray(raw_)) return [];
  const merged = new Map();
  for (const item of raw_) {
    const id = Number(item?.variant_id);
    const qty = Math.floor(Number(item?.qty));
    if (!Number.isSafeInteger(id) || id <= 0 || !(qty > 0)) continue;
    merged.set(id, Math.min(MAX_LINE_QTY, (merged.get(id) || 0) + qty));
  }
  return [...merged].slice(0, MAX_LINES).map(([variant_id, qty]) => ({ variant_id, qty }));
}

function saveCart(items) {
  try {
    localStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(items.map(({ variant_id, qty }) => ({ variant_id, qty }))));
  } catch { /* storage full or blocked: the cart simply won't persist */ }
  window.dispatchEvent(new CustomEvent('cart:change'));
}

export function cartQty(variantId) {
  return getCart().find((i) => i.variant_id === Number(variantId))?.qty || 0;
}

// Adds up to `max` (known stock) in total for this variant. → { ok, qty, max }
export function addItem(variantId, qty = 1, { max = null } = {}) {
  const id = Number(variantId);
  const items = getCart();
  const line = items.find((i) => i.variant_id === id);
  const current = line?.qty || 0;
  const limit = Math.min(MAX_LINE_QTY, max != null && max >= 0 ? max : MAX_LINE_QTY);
  if (current >= limit || (!line && items.length >= MAX_LINES)) return { ok: false, qty: current, max: limit };
  const next = Math.min(current + Math.max(1, Math.floor(qty)), limit);
  if (line) line.qty = next; else items.push({ variant_id: id, qty: next });
  saveCart(items);
  return { ok: true, qty: next, max: limit, capped: next < current + qty };
}

export function setQty(variantId, qty) {
  const id = Number(variantId);
  const q = Math.min(MAX_LINE_QTY, Math.floor(Number(qty)));
  const items = getCart().filter((i) => i.variant_id !== id || q > 0);
  const line = items.find((i) => i.variant_id === id);
  if (line) line.qty = q;
  saveCart(items);
}

export function removeItem(variantId) {
  saveCart(getCart().filter((i) => i.variant_id !== Number(variantId)));
}

export function clearCart() {
  saveCart([]);
}

/* ---------- "Add to cart" buttons anywhere: <button data-add-variant="ID" data-max="STOCK"> ---------- */

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add-variant]');
  if (!btn || btn.disabled) return;
  const max = btn.dataset.max !== undefined && btn.dataset.max !== '' ? Number(btn.dataset.max) : null;
  const qty = Number(btn.dataset.qty) || 1;
  const result = addItem(btn.dataset.addVariant, qty, { max });
  if (result.ok && !result.capped) toast(t('catalog.added'), { type: 'success' });
  else toast(t('catalog.qtyLimit', { max: result.max }), { type: 'error' });
});

/* ---------- Drawer ---------- */

const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

let dialog = null;
let reqId = 0;
let lastData = null;

function ensureDrawer() {
  if (dialog) return;
  dialog = document.createElement('dialog');
  dialog.className = 'drawer cart-drawer';
  dialog.setAttribute('aria-labelledby', 'cart-title');
  dialog.innerHTML = html`
    <div class="drawer-head">
      <h2 class="h3" id="cart-title">${t('cart.title')}</h2>
      <button type="button" class="icon-btn" data-cart-close aria-label="${t('cart.close')}">${raw(ICON_CLOSE)}</button>
    </div>
    <div class="drawer-body" data-cart-body></div>
    <div class="drawer-foot" data-cart-foot hidden></div>`.toString();
  document.body.append(dialog);

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-cart-close]')) { dialog.close(); return; }
    const action = e.target.closest('[data-cart-action]');
    if (!action) return;
    const id = Number(action.dataset.variant);
    const line = lastData?.items?.find((l) => Number(l.variant_id) === id);
    const current = cartQty(id);
    switch (action.dataset.cartAction) {
      case 'inc': setQty(id, Math.min(current + 1, line?.available_stock ?? MAX_LINE_QTY)); break;
      case 'dec': setQty(id, current - 1); break;
      case 'max': setQty(id, Number(action.dataset.max)); break;
      case 'remove': removeItem(id); toast(t('cart.removed')); break;
      default: return;
    }
    // Optimistic quantity until the server answers
    const qtyEl = dialog.querySelector(`[data-qty-for="${id}"]`);
    if (qtyEl) qtyEl.textContent = String(cartQty(id));
  });
}

export function openDrawer() {
  ensureDrawer();
  if (!dialog.open) dialog.showModal();
  refresh();
}

window.addEventListener('cart:open', (e) => { e.preventDefault(); openDrawer(); });

const refreshSoon = debounce(() => refresh(), 350);
window.addEventListener('cart:change', () => { if (dialog?.open) refreshSoon(); });
window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEYS.cart && dialog?.open) refreshSoon(); });

async function refresh() {
  const body = dialog.querySelector('[data-cart-body]');
  const foot = dialog.querySelector('[data-cart-foot]');
  const items = getCart();
  const token = ++reqId;

  if (!items.length) {
    lastData = null;
    foot.hidden = true;
    body.removeAttribute('aria-busy');
    body.innerHTML = html`
      <div class="state state-empty">
        <svg class="state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>
        <p class="state-title">${t('cart.emptyTitle')}</p>
        <p class="state-text">${t('cart.emptyText')}</p>
        <a class="btn primary" href="/shop.html">${t('cart.browse')}</a>
      </div>`.toString();
    return;
  }

  body.setAttribute('aria-busy', 'true');
  if (!lastData) {
    body.innerHTML = html`<div class="state state-loading" role="status"><span class="spinner" aria-hidden="true"></span><p class="state-text">${t('cart.updating')}</p></div>`.toString();
  } else {
    body.classList.add('is-updating');
  }

  try {
    const { rpc } = await import('./supabase.js');
    const data = await rpc('calculate_cart', { items });
    if (token !== reqId) return;
    lastData = data;
    render(data);
  } catch (err) {
    if (token !== reqId) return;
    const code = toAppError(err).code;
    if (code === 'EMPTY_CART' || code === 'INVALID_CART') { clearCart(); return; }
    foot.hidden = true;
    body.innerHTML = html`
      <div class="state state-error" role="alert">
        <p class="state-title">${t('cart.loadError')}</p>
        <p class="state-text">${errorMessage(err)}</p>
        <button type="button" class="btn ghost" data-cart-retry>${t('common.retry')}</button>
      </div>`.toString();
    body.querySelector('[data-cart-retry]').addEventListener('click', () => refresh(), { once: true });
  } finally {
    if (token === reqId) {
      body.removeAttribute('aria-busy');
      body.classList.remove('is-updating');
    }
  }
}

function lineHtml(l) {
  const id = Number(l.variant_id);
  const url = l.product_slug ? `/product.html?slug=${encodeURIComponent(l.product_slug)}` : null;
  const name = l.product_name_ar || t('cart.unknownItem');
  const thumb = l.image_path
    ? html`<img src="${imageUrl(l.image_path)}" alt="" width="72" height="72" loading="lazy">`
    : raw(placeholderSvg(null, l.product_id || id));
  const qty = cartQty(id);
  const canChangeQty = !l.error || l.error === 'INSUFFICIENT_STOCK';

  let problem = '';
  if (l.error === 'VARIANT_NOT_FOUND' || l.error === 'VARIANT_INACTIVE') problem = html`<p class="cart-problem">${t('cart.unavailable')}</p>`;
  else if (l.error === 'OUT_OF_STOCK') problem = html`<p class="cart-problem">${t('cart.outOfStock')}</p>`;
  else if (l.error === 'INSUFFICIENT_STOCK') {
    problem = html`<p class="cart-problem">${t('cart.onlyLeft', { max: l.available_stock })}
      <button type="button" class="btn link" data-cart-action="max" data-variant="${id}" data-max="${l.available_stock}">${t('cart.setToMax', { max: l.available_stock })}</button></p>`;
  }

  return html`
    <li class="cart-line ${l.error ? 'has-problem' : ''}">
      ${url ? html`<a class="cart-thumb" href="${url}" tabindex="-1" aria-hidden="true">${thumb}</a>` : html`<span class="cart-thumb">${thumb}</span>`}
      <div class="cart-info">
        ${url ? html`<a class="cart-name" href="${url}">${name}</a>` : html`<span class="cart-name">${name}</span>`}
        ${l.variant_label ? html`<span class="cart-variant">${l.variant_label}</span>` : ''}
        ${l.unit_price != null && !l.error ? html`<span class="cart-unit">${formatPrice(l.unit_price)}</span>` : ''}
        ${problem}
        <div class="cart-controls">
          ${canChangeQty ? html`
            <div class="qty" role="group" aria-label="${t('cart.qtyLabel')}">
              <button type="button" data-cart-action="dec" data-variant="${id}" aria-label="${t('cart.decrease')}">−</button>
              <span class="qty-value num" data-qty-for="${id}" aria-live="polite">${qty}</span>
              <button type="button" data-cart-action="inc" data-variant="${id}" aria-label="${t('cart.increase')}"
                ${raw(qty >= Math.min(l.available_stock ?? MAX_LINE_QTY, MAX_LINE_QTY) ? 'disabled' : '')}>+</button>
            </div>` : ''}
          <button type="button" class="cart-remove" data-cart-action="remove" data-variant="${id}"
            aria-label="${t('cart.removeAria', { name })}">${raw(ICON_TRASH)}<span>${t('cart.remove')}</span></button>
        </div>
      </div>
      ${!l.error ? html`<span class="cart-line-total price">${formatPrice(l.line_total)}</span>` : ''}
    </li>`;
}

function render(data) {
  const body = dialog.querySelector('[data-cart-body]');
  const foot = dialog.querySelector('[data-cart-foot]');
  const focusedAction = document.activeElement?.closest?.('[data-cart-action]');
  const focusKey = focusedAction ? `${focusedAction.dataset.cartAction}:${focusedAction.dataset.variant}` : null;

  body.innerHTML = html`<ul class="cart-lines">${data.items.map(lineHtml)}</ul>`.toString();

  const threshold = data.free_delivery_threshold != null ? Number(data.free_delivery_threshold) : null;
  const goods = Number(data.total);
  let delivery = '';
  if (threshold != null && !data.has_errors) {
    delivery = goods >= threshold
      ? html`<p class="cart-free is-reached">${t('cart.freeDeliveryReached')}</p>`
      : html`<p class="cart-free">${t('cart.freeDeliveryLeft', { amount: formatPrice(threshold - goods) })}</p>`;
  }
  const blocked = data.has_errors || !data.store_open;

  foot.innerHTML = html`
    <div class="summary">
      <div class="summary-row"><span>${t('cart.subtotal')}</span><span class="num">${formatPrice(data.subtotal)}</span></div>
      ${(data.bundles || []).map((b) => html`
        <div class="summary-row discount"><span>${t('cart.bundleSaving', { name: b.name_ar })}</span><span>${discountHtml(b.discount)}</span></div>`)}
      <div class="summary-row total"><span>${t('cart.total')}</span><span class="num">${formatPrice(data.total)}</span></div>
    </div>
    ${delivery}
    <p class="cart-note">${t('cart.deliveryNote')}</p>
    ${data.has_errors ? html`<p class="alert warning" role="alert">${t('cart.fixErrors')}</p>` : ''}
    ${!data.store_open ? html`<p class="alert warning" role="alert">${t('errors.STORE_CLOSED')}</p>` : ''}
    ${blocked
      ? html`<a class="btn primary block" role="link" aria-disabled="true">${t('cart.checkout')}</a>`
      : html`<a class="btn primary block" href="/checkout.html">${t('cart.checkout')}</a>`}`.toString();
  foot.hidden = false;

  // Keep keyboard focus on the same control after re-rendering (or on the drawer title)
  if (focusKey) {
    const [action, variant] = focusKey.split(':');
    const again = dialog.querySelector(`[data-cart-action="${action}"][data-variant="${variant}"]:not([disabled])`);
    (again || dialog.querySelector('[data-cart-close]')).focus();
  }
}
