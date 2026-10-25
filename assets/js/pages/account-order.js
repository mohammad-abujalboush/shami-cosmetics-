// /account/order.html?id=<order uuid> — order detail for the signed-in customer.
// Cancel while status = new (cancel_my_order) and CliQ receipt upload while awaiting transfer.
import '../layout.js';
import { t, html, getParam, showLoading, showError, setButtonLoading, confirmDialog, toast, errorMessage, toAppError } from '../utils.js';
import { requireClient, run, rpc } from '../supabase.js';
import { requireSession } from '../account.js';
import { metaHtml, itemsHtml, totalsHtml, addressHtml, timelineHtml, cliqHtml, bindProofForm, bindCopy,
         orderWhatsappText, waLink, storeWhatsapp } from '../order-view.js';

const root = document.querySelector('[data-slot="account"]');
document.title = t('account.orderMeta');
await requireSession();

const id = getParam('id');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let orderId = null;
let wa = null;

function notFound() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`<div class="state state-empty"><p class="state-title">${t('account.orderNotFoundTitle')}</p>
    <p class="state-text">${t('account.orderNotFoundText')}</p><a class="btn primary" href="/account/">${t('account.backToOrders')}</a></div>`.toString();
}

function render(order) {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="acc-head">
      <h1>${t('account.orderTitle')}</h1>
      <a class="btn ghost sm" href="/account/#orders">${t('account.backToOrders')}</a>
    </div>
    <div class="co-grid">
      <div class="co-main">
        <section class="co-card">${metaHtml(order)}</section>
        ${cliqHtml(order, { whatsapp: wa })}
        <section class="co-card"><h2>${t('order.itemsTitle')}</h2>${itemsHtml(order)}</section>
        <section class="co-card"><h2>${t('order.deliveryTitle')}</h2>${addressHtml(order)}</section>
      </div>
      <aside class="co-aside">
        <section class="co-card"><h2>${t('order.timelineTitle')}</h2>${timelineHtml(order)}</section>
        <section class="co-card"><h2>${t('order.totalsTitle')}</h2>${totalsHtml(order)}</section>
        ${order.can_cancel ? html`<div class="action-row"><button type="button" class="btn danger" data-cancel>${t('account.cancelButton')}</button></div>
          <p class="hint">${t('account.cancelNote')}</p>` : ''}
        ${wa ? html`<div class="action-row"><a class="btn ghost" href="${waLink(wa, orderWhatsappText(order))}" target="_blank" rel="noopener">${t('order.whatsappButton')}</a></div>` : ''}
      </aside>
    </div>`.toString();
  bindProofForm(root, order, { onDone: render });
  root.querySelector('[data-cancel]')?.addEventListener('click', () => cancel(order));
}

async function cancel(order) {
  const ok = await confirmDialog({
    title: t('account.cancelButton'),
    message: t('account.cancelConfirm', { number: order.order_number }),
    confirmLabel: t('account.cancelConfirmYes'),
    cancelLabel: t('account.cancelKeep'),
    danger: true,
  });
  if (!ok) return;
  const btn = root.querySelector('[data-cancel]');
  setButtonLoading(btn, true);
  try {
    render(await rpc('cancel_my_order', { order_id: orderId }));
    toast(t('account.cancelled'), { type: 'success' });
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
    if (toAppError(err).code === 'CANNOT_CANCEL') load(); else setButtonLoading(btn, false);
  }
}

async function load() {
  if (!id || !UUID.test(id)) { notFound(); return; }
  showLoading(root);
  try {
    const row = await run(requireClient().from('orders').select('id, public_token').eq('id', id).maybeSingle());
    if (!row) { notFound(); return; }
    orderId = row.id;
    wa = await storeWhatsapp();
    render(await rpc('get_order_by_token', { token: row.public_token }));
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

bindCopy(root);
load();
