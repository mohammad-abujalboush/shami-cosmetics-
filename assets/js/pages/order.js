// Order confirmation: /order.html?token=<public_token>
// Summary from get_order_by_token; for CliQ orders: transfer details with copy buttons and receipt upload.
import '../layout.js';
import { t, html, raw, getParam, showLoading, showError, errorMessage, toAppError } from '../utils.js';
import { rpc } from '../supabase.js';
import { metaHtml, itemsHtml, totalsHtml, addressHtml, timelineHtml, cliqHtml, bindProofForm, bindCopy,
         orderWhatsappText, waLink, storeWhatsapp, ICON_OK } from '../order-view.js';

const root = document.querySelector('[data-slot="order"]');
const token = getParam('token');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let wa = null;

function render(order) {
  const cancelled = order.status === 'cancelled' || order.status === 'returned';
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="ok-head">
      ${cancelled ? '' : raw(ICON_OK)}
      <h1>${cancelled ? t(`order.statuses.${order.status}`) : t('order.successTitle')}</h1>
      ${cancelled ? '' : html`<p>${t('order.successText')}</p>`}
    </div>
    <div class="co-grid">
      <div class="co-main">
        <section class="co-card">${metaHtml(order)}</section>
        ${cliqHtml(order, { whatsapp: wa })}
        <section class="co-card"><h2>${t('order.itemsTitle')}</h2>${itemsHtml(order)}</section>
        <section class="co-card"><h2>${t('order.deliveryTitle')}</h2>${addressHtml(order)}</section>
      </div>
      <aside class="co-aside">
        <section class="co-card"><h2>${t('order.totalsTitle')}</h2>${totalsHtml(order)}</section>
        <section class="co-card"><h2>${t('order.timelineTitle')}</h2>${timelineHtml(order)}</section>
        <div class="action-row">
          ${wa ? html`<a class="btn primary" href="${waLink(wa, orderWhatsappText(order))}" target="_blank" rel="noopener">${t('order.whatsappButton')}</a>` : ''}
          <a class="btn ghost" href="/track.html">${t('order.trackButton')}</a>
          <a class="btn ghost" href="/shop.html">${t('order.continueShopping')}</a>
        </div>
      </aside>
    </div>`.toString();
  bindProofForm(root, order, { onDone: (updated) => { render(updated); } });
}

async function load() {
  if (!token || !UUID.test(token)) {
    showError(root, { message: t('order.notFoundText') });
    return;
  }
  showLoading(root);
  try {
    [wa] = await Promise.all([storeWhatsapp()]);
    const order = await rpc('get_order_by_token', { token });
    document.title = t('order.metaTitle');
    render(order);
  } catch (err) {
    const code = toAppError(err).code;
    if (code === 'ORDER_NOT_FOUND') {
      root.removeAttribute('aria-busy');
      root.innerHTML = html`<div class="state state-empty"><p class="state-title">${t('order.notFoundTitle')}</p>
        <p class="state-text">${t('order.notFoundText')}</p><a class="btn primary" href="/track.html">${t('order.trackButton')}</a></div>`.toString();
      return;
    }
    showError(root, { error: err, onRetry: load });
  }
}

bindCopy(root);
load();
