// /account/ — tabs: orders (status, details link, reorder) and profile (name, phone, email, password); logout.
import '../layout.js';
import { t, html, ltr, formatPrice, formatDate, normalizePhone, normalizeName, isValidName,
         showLoading, showEmpty, showError, setButtonLoading, toast, errorMessage, toAppError } from '../utils.js';
import { requireClient, run, rpc } from '../supabase.js';
import { requireSession, logout, guardedSubmit, setFieldError, fieldHtml, bindPasswordToggles, isEmail } from '../account.js';
import { addItem } from '../cart.js';
import { statusLabel, payLabel } from '../order-view.js';

const root = document.querySelector('[data-slot="account"]');
document.title = t('account.meta');
const session = await requireSession();
const sb = requireClient();
const TABS = ['orders', 'profile'];
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'orders';
let profile = { full_name: '', phone: '' };
let ordersLoaded = false;

/* ---------- Shell ---------- */

function shell() {
  root.innerHTML = html`
    <div class="acc-head">
      <h1 data-hello></h1>
      <div class="acc-links">
        <a class="btn ghost sm" href="/account/addresses.html">${t('account.addresses')}</a>
        <button type="button" class="btn ghost sm" data-logout>${t('account.logout')}</button>
      </div>
    </div>
    <div class="tabs" role="tablist" aria-label="${t('account.nav')}">
      ${TABS.map((k) => html`<button type="button" class="tab" role="tab" id="tab-${k}" aria-controls="panel-${k}" data-tab="${k}">${t(`account.tab${k === 'orders' ? 'Orders' : 'Profile'}`)}</button>`)}
    </div>
    ${TABS.map((k) => html`<section role="tabpanel" id="panel-${k}" aria-labelledby="tab-${k}" data-panel="${k}" tabindex="0" hidden></section>`)}`.toString();
  root.querySelector('[data-logout]').addEventListener('click', logout);
  root.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) select(b.dataset.tab, true); });
  root.querySelector('.tabs').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(tab);
    const dir = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;   // RTL: left arrow = next
    if (dir) { e.preventDefault(); select(TABS[(i + dir + TABS.length) % TABS.length], true); }
  });
}

function select(key, focus = false) {
  tab = key;
  history.replaceState(null, '', `#${key}`);
  root.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === key;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  root.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== key; });
  if (key === 'orders' && !ordersLoaded) loadOrders();
}

/* ---------- Orders ---------- */

async function loadOrders() {
  const panel = root.querySelector('[data-panel="orders"]');
  showLoading(panel);
  try {
    const orders = await run(sb.from('orders')
      .select('id, order_number, status, payment_status, payment_method, total, created_at, order_items(product_name_ar, quantity)')
      .order('created_at', { ascending: false }).limit(50));
    ordersLoaded = true;
    if (!orders.length) {
      showEmpty(panel, { title: t('account.ordersEmptyTitle'), text: t('account.ordersEmptyText'), actionLabel: t('checkout.browse'), actionHref: '/shop.html' });
      return;
    }
    panel.removeAttribute('aria-busy');
    panel.innerHTML = html`<div class="order-cards">${orders.map(orderCard)}</div>`.toString();
  } catch (err) {
    showError(panel, { error: err, onRetry: loadOrders });
  }
}

function orderCard(o) {
  const count = o.order_items.reduce((s, i) => s + i.quantity, 0);
  const names = o.order_items.map((i) => i.product_name_ar).slice(0, 3).join('، ') + (o.order_items.length > 3 ? '…' : '');
  return html`
    <article class="co-card order-card">
      <div class="order-card-head">
        <span class="order-number">${ltr(o.order_number)}</span>
        <span><span class="badge" data-status="${o.status}">${statusLabel(o.status)}</span>
          <span class="badge" data-status="${o.payment_status}">${payLabel(o)}</span></span>
      </div>
      <div class="order-card-sub">${formatDate(o.created_at)} · ${t('account.itemsCount', { count })}</div>
      <p class="order-card-items">${names}</p>
      <div class="order-card-foot">
        <strong class="price">${formatPrice(o.total)}</strong>
        <span class="action-row">
          <button type="button" class="btn ghost sm" data-reorder="${o.id}">${t('account.reorder')}</button>
          <a class="btn primary sm" href="/account/order.html?id=${encodeURIComponent(o.id)}">${t('account.orderDetails')}</a>
        </span>
      </div>
    </article>`;
}

// Adds every still-available item (quantity capped to current stock) to the cart. Prices come from the cart drawer.
async function reorder(orderId, button) {
  setButtonLoading(button, true);
  try {
    const items = await run(sb.from('order_items').select('variant_id, quantity').eq('order_id', orderId));
    const wanted = items.filter((i) => i.variant_id).map((i) => ({ variant_id: i.variant_id, qty: i.quantity }));
    if (!wanted.length) { toast(t('account.reorderNone'), { type: 'error' }); return; }
    const priced = await rpc('calculate_cart', { items: wanted });
    let added = 0;
    let capped = false;
    for (const l of priced.items) {
      const want = wanted.find((w) => w.variant_id === Number(l.variant_id))?.qty ?? 1;
      const avail = Number(l.available_stock) || 0;
      if (l.error && l.error !== 'INSUFFICIENT_STOCK') continue;
      const qty = Math.min(want, avail);
      if (qty < 1) continue;
      if (qty < want) capped = true;
      if (addItem(l.variant_id, qty, { max: avail }).ok) added += 1;
    }
    const skipped = items.length - added;
    if (!added) { toast(t('account.reorderNone'), { type: 'error' }); return; }
    toast(skipped > 0 ? t('account.reorderPartial', { count: added, skipped }) : capped ? `${t('account.reorderDone', { count: added })} — ${t('account.reorderCapped')}` : t('account.reorderDone', { count: added }), { type: skipped > 0 ? 'info' : 'success', duration: 6000 });
    window.dispatchEvent(new CustomEvent('cart:open', { cancelable: true }));
  } catch (err) {
    toast(errorMessage(err), { type: 'error' });
  } finally {
    setButtonLoading(button, false);
  }
}

/* ---------- Profile ---------- */

async function loadProfile() {
  try {
    const row = await run(sb.from('profiles').select('full_name, phone').eq('id', session.user.id).maybeSingle());
    if (row) profile = row;
  } catch (err) {
    console.warn('[account] profile', err);
  }
  const shown = (profile.full_name || session.user.user_metadata?.full_name || '').trim();
  root.querySelector('[data-hello]').textContent = shown ? t('account.hello', { name: shown.split(/\s+/)[0] }) : t('account.title');
  renderProfile();
}

function renderProfile() {
  const panel = root.querySelector('[data-panel="profile"]');
  panel.innerHTML = html`
    <div class="stack">
      <form class="co-card form" data-profile novalidate>
        <h2>${t('account.profileTitle')}</h2>
        ${fieldHtml({ id: 'p-name', name: 'name', label: t('auth.nameLabel'), autocomplete: 'name', maxlength: 60, value: profile.full_name || '' })}
        ${fieldHtml({ id: 'p-phone', name: 'phone', label: t('auth.phoneLabel'), type: 'tel', dir: 'ltr', autocomplete: 'tel', inputmode: 'tel', maxlength: 20, placeholder: '07XXXXXXXX', value: profile.phone ? `0${profile.phone.slice(3)}` : '' })}
        <p class="form-error" data-form-error role="alert"></p>
        <button type="submit" class="btn primary">${t('account.save')}</button>
      </form>

      <form class="co-card form" data-email novalidate>
        <h2>${t('account.emailTitle')}</h2>
        <p class="hint" style="margin:0">${t('account.emailCurrent')}: ${ltr(session.user.email)}</p>
        ${fieldHtml({ id: 'p-email', name: 'email', label: t('account.emailNew'), type: 'email', dir: 'ltr', autocomplete: 'email', inputmode: 'email' })}
        <p class="form-error" data-form-error role="alert"></p>
        <button type="submit" class="btn ghost">${t('account.emailChange')}</button>
      </form>

      <form class="co-card form" data-password novalidate>
        <h2>${t('account.passwordTitle')}</h2>
        ${fieldHtml({ id: 'p-pass', name: 'password', label: t('account.passwordNew'), autocomplete: 'new-password', password: true, hint: t('auth.passwordHint') })}
        <p class="form-error" data-form-error role="alert"></p>
        <button type="submit" class="btn ghost">${t('account.passwordChange')}</button>
      </form>
    </div>`.toString();
  bindPasswordToggles(panel);

  const pf = panel.querySelector('[data-profile]');
  guardedSubmit(pf, async () => {
    const name = normalizeName(pf.elements.name.value);
    const phoneRaw = pf.elements.phone.value.trim();
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    setFieldError(pf.elements.name, !name ? t('validation.required') : isValidName(name) ? '' : t('checkout.nameInvalid'));
    setFieldError(pf.elements.phone, phoneRaw && !phone ? t('validation.phoneInvalid') : '');
    if (!name || !isValidName(name)) { pf.elements.name.focus(); return; }
    if (phoneRaw && !phone) { pf.elements.phone.focus(); return; }
    const { error } = await sb.from('profiles').upsert({ id: session.user.id, full_name: name, phone });
    if (error) throw toAppError(error);
    profile = { full_name: name, phone };
    pf.elements.phone.value = phone ? `0${phone.slice(3)}` : '';
    root.querySelector('[data-hello]').textContent = t('account.hello', { name: name.split(' ')[0] });
    toast(t('account.profileSaved'), { type: 'success' });
  });

  const ef = panel.querySelector('[data-email]');
  guardedSubmit(ef, async () => {
    const input = ef.elements.email;
    const value = input.value.trim();
    const msg = !value ? t('auth.emailRequired') : !isEmail(value) ? t('validation.emailInvalid')
      : value.toLowerCase() === String(session.user.email).toLowerCase() ? t('account.emailSame') : '';
    setFieldError(input, msg);
    if (msg) { input.focus(); return; }
    const { error } = await sb.auth.updateUser({ email: value }, { emailRedirectTo: `${location.origin}/account/` });
    if (error) throw toAppError(error);
    input.value = '';
    toast(t('account.emailSent'), { type: 'success', duration: 9000 });
  });

  const wf = panel.querySelector('[data-password]');
  guardedSubmit(wf, async () => {
    const input = wf.elements.password;
    const msg = !input.value ? t('auth.passwordRequired') : input.value.length < 8 ? t('auth.passwordShort') : '';
    setFieldError(input, msg);
    if (msg) { input.focus(); return; }
    const { error } = await sb.auth.updateUser({ password: input.value });
    if (error) throw toAppError(error);
    input.value = '';
    toast(t('account.passwordChanged'), { type: 'success' });
  });
}

shell();
root.querySelector('[data-panel="orders"]').addEventListener('click', (e) => {
  const b = e.target.closest('[data-reorder]');
  if (b && !b.disabled) reorder(b.dataset.reorder, b);
});
select(tab);
loadProfile();
