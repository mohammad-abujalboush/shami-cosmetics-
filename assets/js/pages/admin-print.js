// /admin/print.html?ids=<uuid>,<uuid>,… — packing slips for staff and owner (A4 or 80mm thermal).
// "Amount to collect" is 0 when the order is already paid; otherwise the order total (delivery included).
import { initAdmin } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatDate, formatPhone, getParam, showLoading, showError, showEmpty, errorMessage } from '../utils.js';
import { run } from '../supabase.js';

const ctx = await initAdmin({ page: 'orders', shell: false });
document.title = t('admin.print.meta');
const root = document.querySelector('[data-slot="print"]');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FMT_KEY = 'shami_admin_print_format';
const MAX = 50;

let format = 'a4';
try { format = localStorage.getItem(FMT_KEY) === 'thermal' ? 'thermal' : 'a4'; } catch { /* default */ }

const pageStyle = document.createElement('style');
document.head.append(pageStyle);
function applyFormat() {
  document.body.classList.toggle('fmt-a4', format === 'a4');
  document.body.classList.toggle('fmt-thermal', format === 'thermal');
  // @page can't be switched with a class, so the rule is rewritten.
  pageStyle.textContent = format === 'thermal' ? '@page { size: 80mm auto; margin: 3mm; }' : '@page { size: A4; margin: 10mm; }';
  root.querySelectorAll('[data-format]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.format === format)));
  try { localStorage.setItem(FMT_KEY, format); } catch { /* not persisted */ }
}

const collect = (o) => (o.payment_status === 'paid' ? 0 : Number(o.total));

function slipHtml(o) {
  const amount = collect(o);
  return html`
    <article class="slip">
      <header class="slip-head">
        <div class="slip-brand">${t('meta.brand')}</div>
        <div class="slip-number">${ltr(o.order_number)}</div>
      </header>
      <div class="slip-meta">${t('admin.print.slipDate')}: ${formatDate(o.created_at)} · ${t('admin.print.slipPayment')}: ${t(`order.methods.${o.payment_method}`)}</div>
      <section class="slip-block">
        <div><strong>${t('admin.print.slipCustomer')}:</strong> ${o.customer_name}</div>
        <div><strong>${t('admin.print.slipPhone')}:</strong> ${ltr(formatPhone(o.phone))}</div>
        <div><strong>${t('admin.print.slipAddress')}:</strong> ${[o.governorate_name, o.area, o.address_details].filter(Boolean).join('، ')}</div>
        ${o.notes ? html`<div><strong>${t('admin.print.slipNotes')}:</strong> ${o.notes}</div>` : ''}
      </section>
      <table class="slip-items">
        <thead><tr><th>${t('admin.print.slipItems')}</th><th class="q">${t('admin.print.slipQty')}</th></tr></thead>
        <tbody>${o.order_items.slice().sort((a, b) => a.id - b.id).map((i) => html`
          <tr><td>${i.product_name_ar}${i.variant_label ? html`<span class="v"> — ${i.variant_label}</span>` : ''}</td><td class="q">${i.quantity}</td></tr>`)}</tbody>
      </table>
      <section class="slip-sum">
        <div><span>${t('admin.print.slipDelivery')}</span><span>${formatPrice(o.delivery_fee)}</span></div>
        <div><span>${t('admin.print.slipTotal')}</span><span>${formatPrice(o.total)}</span></div>
        <div class="collect"><span>${t('admin.print.slipCollect')}</span><span>${formatPrice(amount)}</span></div>
        ${amount === 0 ? html`<div class="paid-note">${t('admin.print.slipPaid')}</div>` : ''}
      </section>
    </article>`;
}

async function load() {
  const raws = String(getParam('ids') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ids = [...new Set(raws.filter((x) => UUID.test(x)))].slice(0, MAX);
  if (!ids.length) {
    showEmpty(root, { title: t('admin.print.emptyTitle'), text: t('admin.print.emptyText'), actionLabel: t('admin.print.back'), actionHref: '/admin/orders.html' });
    return;
  }
  showLoading(root);
  try {
    const rows = await run(ctx.sb.from('orders')
      .select('id, order_number, customer_name, phone, governorate_name, area, address_details, notes, payment_method, payment_status, delivery_fee, total, created_at, order_items(id, product_name_ar, variant_label, quantity)')
      .in('id', ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((i) => byId.get(i)).filter(Boolean);
    if (!ordered.length) {
      showEmpty(root, { title: t('admin.print.emptyTitle'), text: t('admin.print.emptyText'), actionLabel: t('admin.print.back'), actionHref: '/admin/orders.html' });
      return;
    }
    root.removeAttribute('aria-busy');
    root.innerHTML = html`
      <div class="print-bar no-print">
        <div>
          <strong>${t('admin.print.title')}</strong>
          <span class="hint">${t('admin.print.count', { count: ordered.length })}${raws.length > MAX ? ` — ${t('admin.print.tooMany')}` : ''}</span>
        </div>
        <div class="print-bar-actions">
          <span class="label">${t('admin.print.format')}</span>
          <button type="button" class="chip" data-format="a4" aria-pressed="false">${t('admin.print.a4')}</button>
          <button type="button" class="chip" data-format="thermal" aria-pressed="false">${t('admin.print.thermal')}</button>
          <button type="button" class="btn primary sm" data-do-print>${t('admin.print.print')}</button>
          <a class="btn ghost sm" href="/admin/orders.html">${t('admin.print.back')}</a>
        </div>
      </div>
      <div class="slips">${ordered.map(slipHtml)}</div>`.toString();
    root.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', () => { format = b.dataset.format; applyFormat(); }));
    root.querySelector('[data-do-print]').addEventListener('click', () => window.print());
    applyFormat();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

applyFormat();
load();
