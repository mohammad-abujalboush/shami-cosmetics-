// Checkout: /checkout.html
// Cart lines (editable) priced by calculate_cart; delivery fee / free-delivery hint follow the governorate;
// coupon via calculate_cart; submit via place_order. The browser never sends or computes prices.
import '../layout.js';
import { t, html, raw, ltr, formatPrice, formatPhone, normalizePhone, normalizeName, isValidName, toWesternDigits,
         showLoading, showError, setButtonLoading, toast, errorMessage, toAppError, debounce } from '../utils.js';
import { rpc, run, requireClient, getSession } from '../supabase.js';
import { getCart, setQty, removeItem, clearCart, cartQty } from '../cart.js';
import { imageUrl, placeholderSvg, discountHtml } from '../catalog.js';
import { waLink, storeWhatsapp } from '../order-view.js';

const root = document.querySelector('[data-slot="checkout"]');
const MAX_QTY = 99;
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
const ITEM_ERRORS = ['VARIANT_NOT_FOUND', 'VARIANT_INACTIVE', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK', 'EMPTY_CART', 'INVALID_CART', 'INVALID_QUANTITY'];

const state = {
  data: null,            // last calculate_cart result
  coupon: null,          // code the customer applied (uppercase) or null
  governorates: [],
  addresses: [],
  method: 'cod',
  submitting: false,
  whatsapp: null,
};
let seq = 0;
let ui = null;           // element refs after the page is built

/* ---------- Boot ---------- */

async function init() {
  const items = getCart();
  if (!items.length) { renderEmpty(); return; }
  showLoading(root);
  try {
    const [cart, governorates, prefill, whatsapp] = await Promise.all([
      rpc('calculate_cart', { items }),
      run(requireClient().from('governorates').select('id, name_ar').eq('active', true).order('sort').order('id')),
      loadPrefill(),
      storeWhatsapp(),
    ]);
    state.data = cart;
    state.governorates = governorates ?? [];
    state.whatsapp = whatsapp;
    state.addresses = prefill.addresses;
    if (!cart.store_open) { renderClosed(); return; }
    buildPage(prefill);
    paintCart();
  } catch (err) {
    const code = toAppError(err).code;
    if (code === 'EMPTY_CART' || code === 'INVALID_CART') { clearCart(); renderEmpty(); return; }
    showError(root, { message: `${t('checkout.loadError')} ${errorMessage(err)}`, onRetry: init });
  }
}

// Signed-in customers get name / phone / default address prefilled. Never blocks checkout.
async function loadPrefill() {
  const out = { name: '', phone: '', address: null, addresses: [] };
  try {
    const session = await getSession();
    if (!session) return out;
    const sb = requireClient();
    const [profile, addresses] = await Promise.all([
      run(sb.from('profiles').select('full_name, phone').eq('id', session.user.id).maybeSingle()),
      run(sb.from('addresses').select('id, label, full_name, phone, governorate_id, area, details, is_default')
        .order('is_default', { ascending: false }).order('created_at')),
    ]);
    out.addresses = addresses ?? [];
    out.address = out.addresses.find((a) => a.is_default) ?? out.addresses[0] ?? null;
    out.name = out.address?.full_name || profile?.full_name || '';
    out.phone = localPhone(out.address?.phone || profile?.phone);
  } catch (err) {
    console.warn('[checkout] prefill skipped', err);
  }
  return out;
}

const localPhone = (stored) => (stored ? formatPhone(stored).replace(/\s/g, '') : '');

function renderEmpty() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="state state-empty">
      <p class="state-title">${t('checkout.emptyTitle')}</p>
      <p class="state-text">${t('checkout.emptyText')}</p>
      <a class="btn primary" href="/shop.html">${t('checkout.browse')}</a>
    </div>`.toString();
}

function renderClosed() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="state state-error" role="alert">
      <p class="state-title">${t('checkout.storeClosedTitle')}</p>
      <p class="state-text">${t('checkout.storeClosedText')}</p>
      <a class="btn ghost" href="/">${t('notFound.home')}</a>
    </div>`.toString();
}

/* ---------- Page skeleton (built once so typed values survive re-pricing) ---------- */

function field(id, label, control, { hint = '', optional = false } = {}) {
  return html`
    <div class="field">
      <label class="label" for="${id}">${label}${optional ? html` <span class="opt">(${t('common.optional')})</span>` : ''}</label>
      ${control}
      ${hint ? html`<span class="hint" id="${id}-hint">${hint}</span>` : ''}
      <p class="field-error" id="${id}-err" role="alert"></p>
    </div>`;
}

function buildPage(prefill) {
  const addr = prefill.address;
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <h1>${t('checkout.title')}</h1>
    <form class="co-grid" data-form novalidate>
      <div class="co-main">
        <section class="co-card" aria-labelledby="co-items-title">
          <h2 id="co-items-title">${t('checkout.itemsTitle')}</h2>
          <div data-lines aria-live="polite"></div>
        </section>

        <section class="co-card" aria-labelledby="co-details-title">
          <h2 id="co-details-title">${t('checkout.detailsTitle')}</h2>
          <div class="form">
            ${state.addresses.length > 1 ? field('co-saved', t('checkout.savedAddress'), html`
              <select class="select" id="co-saved" data-saved>
                ${state.addresses.map((a) => html`<option value="${a.id}" ${raw(a.id === addr?.id ? 'selected' : '')}>${a.label || a.area}</option>`)}
                <option value="">${t('checkout.savedAddressNone')}</option>
              </select>`) : ''}
            ${field('co-name', t('checkout.name'), html`<input class="input" id="co-name" name="name" type="text" autocomplete="name" maxlength="60" value="${prefill.name}" aria-describedby="co-name-err">`)}
            ${field('co-phone', t('checkout.phone'), html`<input class="input" id="co-phone" name="phone" type="tel" dir="ltr" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="07XXXXXXXX" value="${prefill.phone}" aria-describedby="co-phone-hint co-phone-err">`, { hint: t('checkout.phoneHint') })}
            <div class="form-row">
              ${field('co-gov', t('checkout.governorate'), html`
                <select class="select" id="co-gov" name="governorate" aria-describedby="co-gov-err">
                  <option value="">${t('checkout.governorateChoose')}</option>
                  ${state.governorates.map((g) => html`<option value="${g.id}" ${raw(g.id === addr?.governorate_id ? 'selected' : '')}>${g.name_ar}</option>`)}
                </select>`)}
              ${field('co-area', t('checkout.area'), html`<input class="input" id="co-area" name="area" type="text" autocomplete="address-level2" maxlength="80" placeholder="${t('checkout.areaPlaceholder')}" value="${addr?.area || ''}" aria-describedby="co-area-err">`)}
            </div>
            ${field('co-address', t('checkout.address'), html`<textarea class="textarea" id="co-address" name="address" rows="3" maxlength="300" autocomplete="street-address" placeholder="${t('checkout.addressPlaceholder')}" aria-describedby="co-address-err">${addr?.details || ''}</textarea>`)}
            ${field('co-notes', t('checkout.notes'), html`<textarea class="textarea" id="co-notes" name="notes" rows="2" maxlength="500" placeholder="${t('checkout.notesPlaceholder')}" aria-describedby="co-notes-err"></textarea>`, { optional: true })}
          </div>
        </section>

        <section class="co-card">
          <fieldset class="pay-options" data-methods aria-describedby="co-pay-err"></fieldset>
          <p class="field-error" id="co-pay-err" role="alert"></p>
        </section>
      </div>

      <aside class="co-aside">
        <section class="co-card" aria-labelledby="co-summary-title">
          <h2 id="co-summary-title">${t('checkout.summaryTitle')}</h2>
          <div class="field" data-coupon></div>
          <div data-summary style="margin-top:16px"></div>
        </section>
        <div class="alert danger form-alert" data-alert role="alert" tabindex="-1" hidden></div>
        <button type="submit" class="btn primary block lg co-submit" data-submit>${t('checkout.submit')}</button>
        <p class="co-fine">${t('checkout.termsNote')} <a href="/returns.html" target="_blank" rel="noopener">${t('checkout.returnsLink')}</a></p>
      </aside>
    </form>`.toString();

  ui = {
    form: root.querySelector('[data-form]'),
    lines: root.querySelector('[data-lines]'),
    summary: root.querySelector('[data-summary]'),
    coupon: root.querySelector('[data-coupon]'),
    methods: root.querySelector('[data-methods]'),
    alert: root.querySelector('[data-alert]'),
    submit: root.querySelector('[data-submit]'),
    name: root.querySelector('#co-name'), phone: root.querySelector('#co-phone'), gov: root.querySelector('#co-gov'),
    area: root.querySelector('#co-area'), address: root.querySelector('#co-address'), notes: root.querySelector('#co-notes'),
  };
  bind();
}

/* ---------- Painting ---------- */

function paintCart() {
  const data = state.data;
  paintLines(data);
  paintMethods(data);
  paintCoupon(data);
  paintSummary(data);
  ui.submit.disabled = state.submitting || data.has_errors || Boolean(data.coupon?.error);
  ui.form.classList.remove('is-updating');
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
      <button type="button" class="btn link" data-co-action="max" data-variant="${id}" data-max="${l.available_stock}">${t('cart.setToMax', { max: l.available_stock })}</button></p>`;
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
              <button type="button" data-co-action="dec" data-variant="${id}" aria-label="${t('cart.decrease')}">−</button>
              <span class="qty-value num" data-qty-for="${id}" aria-live="polite" style="min-width:32px;text-align:center;font-weight:700">${qty}</span>
              <button type="button" data-co-action="inc" data-variant="${id}" aria-label="${t('cart.increase')}"
                ${raw(qty >= Math.min(l.available_stock ?? MAX_QTY, MAX_QTY) ? 'disabled' : '')}>+</button>
            </div>` : ''}
          <button type="button" class="cart-remove" data-co-action="remove" data-variant="${id}"
            aria-label="${t('cart.removeAria', { name })}">${raw(ICON_TRASH)}<span>${t('cart.remove')}</span></button>
        </div>
      </div>
      ${!l.error ? html`<span class="cart-line-total price">${formatPrice(l.line_total)}</span>` : ''}
    </li>`;
}

function paintLines(data) {
  const focused = document.activeElement?.closest?.('[data-co-action]');
  const key = focused ? `${focused.dataset.coAction}:${focused.dataset.variant}` : null;
  ui.lines.innerHTML = html`<ul class="cart-lines">${data.items.map(lineHtml)}</ul>
    ${data.has_errors ? html`<p class="alert warning" role="alert" style="margin-top:12px">${t('checkout.fixItems')}</p>` : ''}`.toString();
  if (key) {
    const [action, variant] = key.split(':');
    ui.lines.querySelector(`[data-co-action="${action}"][data-variant="${variant}"]:not([disabled])`)?.focus();
  }
}

function paintMethods(data) {
  const allowed = Array.isArray(data.payment_methods) ? data.payment_methods : ['cod'];
  if (!allowed.includes(state.method)) state.method = allowed[0] || 'cod';
  const sig = allowed.join(',');
  if (ui.methods.dataset.sig === sig) return;
  ui.methods.dataset.sig = sig;
  ui.methods.innerHTML = html`
    <legend>${t('checkout.paymentTitle')}</legend>
    ${allowed.map((m) => html`
      <label class="pay-option">
        <input type="radio" name="payment" value="${m}" ${raw(m === state.method ? 'checked' : '')}>
        <span><strong>${t(`checkout.${m}`)}</strong><span>${t(`checkout.${m}Text`)}</span></span>
      </label>`)}`.toString();
}

function paintCoupon(data) {
  const box = ui.coupon;
  const code = state.coupon;
  const error = code ? data.coupon?.error : null;
  if (!code) {
    if (box.querySelector('#co-coupon')) return;   // keep what is being typed

    box.innerHTML = html`
      <label class="label" for="co-coupon">${t('checkout.couponLabel')} <span class="opt">(${t('common.optional')})</span></label>
      <div class="coupon-row">
        <input class="input" id="co-coupon" type="text" dir="ltr" data-digits autocomplete="off" maxlength="40" placeholder="${t('checkout.couponPlaceholder')}" aria-describedby="co-coupon-err">
        <button type="button" class="btn ghost" data-coupon-apply>${t('checkout.couponApply')}</button>
      </div>
      <p class="field-error" id="co-coupon-err" role="alert"></p>`.toString();
    return;
  }
  box.innerHTML = html`
    <span class="label">${t('checkout.couponLabel')}</span>
    <div class="coupon-ok" style="${error ? 'color:var(--danger)' : ''}">
      <span>${error ? ltr(code) : t('checkout.couponApplied', { code })}</span>
      <button type="button" class="btn link" data-coupon-remove>${t('checkout.couponRemove')}</button>
    </div>
    <p class="field-error" id="co-coupon-err" role="alert">${error ? t(`errors.${error}`) : ''}</p>`.toString();
}

function paintSummary(data) {
  const fee = data.delivery_fee != null ? Number(data.delivery_fee) : null;
  const total = Number(data.total);
  const goods = fee != null ? total - fee : total;
  const threshold = data.free_delivery_threshold != null ? Number(data.free_delivery_threshold) : null;
  const couponOk = state.coupon && !data.coupon?.error && Number(data.coupon_discount) > 0;
  let hint = '';
  if (threshold != null && !data.has_errors) {
    hint = data.free_delivery_applied || goods >= threshold
      ? html`<p class="cart-free is-reached">${t('checkout.freeReached')}</p>`
      : html`<p class="cart-free">${t('checkout.freeLeft', { amount: formatPrice(threshold - goods) })}</p>`;
  }
  ui.summary.innerHTML = html`
    <div class="summary">
      <div class="summary-row"><span>${t('checkout.subtotal')}</span><span class="num">${formatPrice(data.subtotal)}</span></div>
      ${(data.bundles || []).map((b) => html`
        <div class="summary-row discount"><span>${t('checkout.bundle', { name: b.name_ar })}</span><span>${discountHtml(b.discount)}</span></div>`)}
      ${couponOk ? html`<div class="summary-row discount"><span>${t('checkout.couponDiscount', { code: state.coupon })}</span><span>${discountHtml(data.coupon_discount)}</span></div>` : ''}
      <div class="summary-row"><span>${t('checkout.delivery')}</span>
        <span class="num">${fee == null ? t('checkout.deliveryChoose') : fee > 0 ? formatPrice(fee) : t('checkout.deliveryFree')}</span></div>
      <div class="summary-row total"><span>${t('checkout.total')}</span><span class="num">${formatPrice(data.total)}</span></div>
    </div>
    ${hint}`.toString();
}

/* ---------- Pricing ---------- */

function currentArgs() {
  const items = getCart();
  const gov = Number(ui.gov.value);
  return {
    items,
    governorate_id: gov > 0 ? gov : null,
    coupon_code: state.coupon,
    phone: normalizePhone(ui.phone.value) ?? null,
  };
}

async function reprice({ immediate = false } = {}) {
  const items = getCart();
  if (!items.length) { renderEmpty(); return; }
  ui.form.classList.add('is-updating');
  const mine = ++seq;
  try {
    const data = await rpc('calculate_cart', currentArgs());
    if (mine !== seq) return;
    state.data = data;
    if (!data.store_open) { renderClosed(); return; }
    paintCart();
  } catch (err) {
    if (mine !== seq) return;
    const code = toAppError(err).code;
    if (code === 'EMPTY_CART' || code === 'INVALID_CART') { clearCart(); renderEmpty(); return; }
    ui.form.classList.remove('is-updating');
    showAlert(errorMessage(err));
  }
}
const repriceSoon = debounce(() => reprice(), 300);

/* ---------- Validation ---------- */

function setError(input, id, message) {
  const el = root.querySelector(`#${id}-err`);
  if (el) el.textContent = message || '';
  if (input) { if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
}

const checks = {
  name: () => {
    const v = normalizeName(ui.name.value);
    return !v ? t('validation.required') : isValidName(v) ? '' : t('checkout.nameInvalid');
  },
  phone: () => {
    const v = ui.phone.value.trim();
    return !v ? t('validation.required') : normalizePhone(v) ? '' : t('validation.phoneInvalid');
  },
  gov: () => (Number(ui.gov.value) > 0 ? '' : t('checkout.governorateRequired')),
  area: () => {
    const v = ui.area.value.trim();
    return !v ? t('validation.required') : v.length < 2 || v.length > 80 ? t('checkout.areaInvalid') : '';
  },
  address: () => {
    const v = ui.address.value.trim();
    return !v ? t('validation.required') : v.length < 3 || v.length > 300 ? t('checkout.addressInvalid') : '';
  },
  notes: () => (ui.notes.value.trim().length > 500 ? t('checkout.notesInvalid') : ''),
};
const ids = { name: 'co-name', phone: 'co-phone', gov: 'co-gov', area: 'co-area', address: 'co-address', notes: 'co-notes' };

function validate() {
  let first = null;
  for (const key of Object.keys(checks)) {
    const message = checks[key]();
    setError(ui[key], ids[key], message);
    if (message && !first) first = ui[key];
  }
  const payOk = Boolean(root.querySelector('input[name="payment"]:checked'));
  root.querySelector('#co-pay-err').textContent = payOk ? '' : t('checkout.paymentRequired');
  if (!payOk && !first) first = ui.methods.querySelector('input');
  return first;
}

function showAlert(message, { whatsapp = false } = {}) {
  ui.alert.innerHTML = html`${message}${whatsapp && state.whatsapp
    ? html` <a href="${waLink(state.whatsapp, t('checkout.contactMessage'))}" target="_blank" rel="noopener">${t('checkout.contactWhatsapp')}</a>` : ''}`.toString();
  ui.alert.hidden = false;
  ui.alert.focus();
}
const hideAlert = () => { ui.alert.hidden = true; ui.alert.textContent = ''; };

/* ---------- Events ---------- */

function bind() {
  // Cart line actions
  ui.lines.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-co-action]');
    if (!btn) return;
    const id = Number(btn.dataset.variant);
    const line = state.data?.items?.find((l) => Number(l.variant_id) === id);
    const current = cartQty(id);
    switch (btn.dataset.coAction) {
      case 'inc': setQty(id, Math.min(current + 1, line?.available_stock ?? MAX_QTY)); break;
      case 'dec': setQty(id, current - 1); break;
      case 'max': setQty(id, Number(btn.dataset.max)); break;
      case 'remove': removeItem(id); toast(t('cart.removed')); break;
      default: return;
    }
    const q = ui.lines.querySelector(`[data-qty-for="${id}"]`);
    if (q) q.textContent = String(cartQty(id));
  });
  window.addEventListener('cart:change', () => { if (ui) { hideAlert(); repriceSoon(); } });
  window.addEventListener('storage', (e) => { if (ui && e.key && e.key.includes('cart')) repriceSoon(); });

  // Coupon
  ui.coupon.addEventListener('click', (e) => {
    if (e.target.closest('[data-coupon-apply]')) applyCoupon();
    if (e.target.closest('[data-coupon-remove]')) { state.coupon = null; paintCoupon(state.data); reprice(); }
  });
  ui.coupon.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#co-coupon')) { e.preventDefault(); applyCoupon(); }
  });

  // Delivery fee follows the governorate immediately; phone re-checks per-phone coupon limits.
  ui.gov.addEventListener('change', () => { setError(ui.gov, 'co-gov', checks.gov()); reprice(); });
  ui.phone.addEventListener('change', () => { if (state.coupon) reprice(); });
  ui.methods.addEventListener('change', (e) => {
    if (e.target.name === 'payment') { state.method = e.target.value; root.querySelector('#co-pay-err').textContent = ''; }
  });

  // Live validation after the first blur
  for (const key of Object.keys(checks)) {
    ui[key].addEventListener('blur', () => setError(ui[key], ids[key], checks[key]()));
    ui[key].addEventListener('input', () => { if (ui[key].getAttribute('aria-invalid')) setError(ui[key], ids[key], checks[key]()); });
  }

  // Saved address picker
  root.querySelector('[data-saved]')?.addEventListener('change', (e) => {
    const a = state.addresses.find((x) => x.id === e.target.value);
    if (!a) return;
    ui.name.value = a.full_name; ui.phone.value = localPhone(a.phone); ui.gov.value = String(a.governorate_id);
    ui.area.value = a.area; ui.address.value = a.details;
    reprice();
  });

  ui.form.addEventListener('input', () => { if (!ui.alert.hidden) hideAlert(); });
  ui.form.addEventListener('submit', submit);
}

async function applyCoupon() {
  const input = ui.coupon.querySelector('#co-coupon');
  const code = toWesternDigits(input?.value ?? '').trim().toUpperCase();
  const err = ui.coupon.querySelector('#co-coupon-err');
  if (!code) { err.textContent = t('validation.required'); input?.setAttribute('aria-invalid', 'true'); input?.focus(); return; }
  state.coupon = code;
  paintCoupon(state.data);
  await reprice();
}

/* ---------- Submit ---------- */

const FIELD_ERRORS = {
  INVALID_NAME: ['name', 'co-name'], INVALID_PHONE: ['phone', 'co-phone'], INVALID_GOVERNORATE: ['gov', 'co-gov'],
  INVALID_ADDRESS: ['address', 'co-address'], TEXT_TOO_LONG: ['notes', 'co-notes'],
};

async function submit(e) {
  e.preventDefault();
  if (state.submitting) return;
  hideAlert();
  const invalid = validate();
  if (invalid) { showAlert(t('checkout.fixFields')); invalid.focus(); return; }
  if (state.data.has_errors) { showAlert(t('checkout.fixItems')); return; }
  if (state.data.coupon?.error) { showAlert(t(`errors.${state.data.coupon.error}`)); return; }

  state.submitting = true;
  setButtonLoading(ui.submit, true);
  const payload = {
    items: getCart(),
    customer_name: normalizeName(ui.name.value),
    phone: normalizePhone(ui.phone.value),
    governorate_id: Number(ui.gov.value),
    area: ui.area.value.trim(),
    address_details: ui.address.value.trim(),
    notes: ui.notes.value.trim() || null,
    payment_method: root.querySelector('input[name="payment"]:checked').value,
    coupon_code: state.coupon,
  };
  try {
    const order = await rpc('place_order', { payload });
    clearCart();   // only after the order exists
    location.assign(`/order.html?token=${encodeURIComponent(order.public_token)}`);
    // Stay in the loading state while the browser navigates: no second submission possible.
  } catch (err) {
    state.submitting = false;
    setButtonLoading(ui.submit, false);
    handleSubmitError(err);
  }
}

function handleSubmitError(err) {
  const code = toAppError(err).code;
  const message = errorMessage(err);
  if (code === 'STORE_CLOSED') { renderClosed(); return; }
  if (FIELD_ERRORS[code]) {
    const [key, id] = FIELD_ERRORS[code];
    setError(ui[key], id, message);
    ui[key].focus();
    return;
  }
  if (code === 'RATE_LIMITED') { showAlert(message, { whatsapp: true }); return; }
  if (ITEM_ERRORS.includes(code) || code.startsWith('COUPON_')) {
    // Stock or coupon changed since the cart was priced: re-price so the problem line / coupon message shows.
    showAlert(message);
    reprice().then(() => {
      (code.startsWith('COUPON_') ? ui.coupon : ui.lines).scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return;
  }
  if (code === 'INVALID_PAYMENT_METHOD') { root.querySelector('#co-pay-err').textContent = message; reprice(); return; }
  showAlert(message);
}

init();
