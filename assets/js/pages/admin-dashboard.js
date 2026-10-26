// /admin/ — Owner: dashboard_stats (today / 7 days / 30 days / custom) + refunds + flagged CliQ + low stock.
// Staff: pending orders, flagged CliQ orders and low stock only (staff_overview). No revenue for staff:
// dashboard_stats is owner-only in Postgres.
import { initAdmin, ammanDate } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatNumber, formatDate, showLoading, showError, setButtonLoading, toast, errorMessage } from '../utils.js';
import { rpc } from '../supabase.js';

const ctx = await initAdmin({ page: 'dashboard' });
document.title = t('admin.dash.meta');
const root = document.querySelector('[data-slot="dash"]');
let range = 'today';
let custom = { from: ammanDate(-6), to: ammanDate() };
let overview = null;

const kpi = (label, value, meta = '', cls = '', href = '') => {
  const body = html`<div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${meta ? html`<div class="kpi-meta">${meta}</div>` : ''}`;
  return href ? html`<a class="kpi ${cls}" href="${href}">${body}</a>` : html`<div class="kpi ${cls}">${body}</div>`;
};

function rangeDates() {
  const today = ammanDate();
  if (range === 'today') return { from: today, to: today };
  if (range === '7') return { from: ammanDate(-6), to: today };
  if (range === '30') return { from: ammanDate(-29), to: today };
  return custom;
}

function pendingHtml(o) {
  return html`
    <section class="panel-block" aria-labelledby="pend-title">
      <h2 class="panel-title" id="pend-title" style="margin-bottom:12px">${t('admin.dash.pendingTitle')}</h2>
      <div class="kpi-grid">
        ${kpi(t('admin.dash.newCount'), formatNumber(o.new_count), '', Number(o.new_count) > 0 ? 'alert-kpi' : '', '/admin/orders.html?status=new')}
        ${kpi(t('admin.dash.confirmedCount'), formatNumber(o.confirmed_count), '', '', '/admin/orders.html?status=confirmed')}
        ${kpi(t('admin.dash.courierCount'), formatNumber(o.with_courier_count), '', '', '/admin/orders.html?status=with_courier')}
      </div>
    </section>`;
}

function flaggedHtml(o) {
  const rows = o.flagged_cliq_orders || [];
  return html`
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">${t('admin.dash.flaggedTitle')}</h2>
        <span class="hint">${t('admin.dash.flaggedHint', { hours: o.cliq_window_hours ?? ctx.cliqWindow })}</span></div>
      <div class="panel-body flush">${rows.length ? html`
        <div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table"><tbody>
          ${rows.map((r) => html`<tr class="is-flagged"><td><a class="cell-main link-inline" href="/admin/order.html?id=${r.id}">${ltr(r.order_number)}</a>
              <div class="cell-sub">${r.customer_name}</div></td>
            <td class="num">${formatPrice(r.total)}</td>
            <td><span class="badge" data-status="${r.payment_status}">${t(`order.payStatuses.${r.payment_status}`)}</span></td>
            <td class="cell-sub">${formatDate(r.created_at)}</td></tr>`)}
        </tbody></table></div>` : html`<p class="panel-body hint">${t('admin.dash.flaggedEmpty')}</p>`}</div>
    </section>`;
}

function lowStockHtml(o) {
  const rows = o.low_stock || [];
  return html`
    <section class="panel">
      <div class="panel-head"><h2 class="panel-title">${t('admin.dash.lowStockTitle')}</h2></div>
      <div class="panel-body flush">${rows.length ? html`
        <div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table"><tbody>
          ${rows.map((r) => html`<tr><td><div class="cell-main">${r.product_name_ar}</div><div class="cell-sub">${r.variant_label}${r.sku ? html` · ${ltr(r.sku)}` : ''}</div></td>
            <td class="num"><span class="badge ${Number(r.stock) === 0 ? 'danger' : 'warning'}">${Number(r.stock) === 0 ? t('catalog.soldOut') : t('admin.dash.stockLeft', { n: r.stock })}</span></td></tr>`)}
        </tbody></table></div>` : html`<p class="panel-body hint">${t('admin.dash.lowStockEmpty')}</p>`}</div>
    </section>`;
}

function statsHtml(s) {
  const due = Number(s.refund_due_count) || 0;
  const statuses = Object.entries(s.orders_by_status || {});
  return html`
    <div class="kpi-grid">
      ${kpi(t('admin.dash.ordersTotal'), formatNumber(s.orders_total))}
      ${kpi(t('admin.dash.delivered'), formatNumber(s.delivered_orders))}
      ${kpi(t('admin.dash.revenue'), formatPrice(s.revenue))}
      ${kpi(t('admin.dash.aov'), formatPrice(s.average_order_value))}
      ${kpi(t('admin.dash.deliveryFees'), formatPrice(s.delivery_fees))}
      ${kpi(t('admin.dash.discounts'), formatPrice(s.discounts))}
      ${kpi(t('admin.dash.refundDue'), formatPrice(s.refund_due_amount), t('admin.dash.refundDueMeta', { count: formatNumber(due), amount: formatPrice(s.refund_due_amount) }),
        due > 0 ? 'alert-kpi' : '', '/admin/orders.html?pay=refund_due')}
    </div>
    <div class="admin-grid split">
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">${t('admin.dash.topProducts')}</h2></div>
        <div class="panel-body flush">${(s.top_products || []).length ? html`
          <div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table">
            <thead><tr><th>${t('admin.dash.product')}</th><th class="num">${t('admin.dash.qty')}</th><th class="num">${t('admin.dash.sales')}</th></tr></thead>
            <tbody>${s.top_products.map((p) => html`<tr><td class="cell-main">${p.product_name_ar}</td><td class="num">${formatNumber(p.quantity)}</td><td class="num">${formatPrice(p.gross_sales)}</td></tr>`)}</tbody>
          </table></div>` : html`<p class="panel-body hint">${t('admin.dash.topEmpty')}</p>`}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">${t('admin.dash.byStatus')}</h2></div>
        <div class="panel-body flush"><div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table"><tbody>
          ${statuses.map(([k, n]) => html`<tr><td><span class="badge" data-status="${k}">${t(`order.statuses.${k}`)}</span></td><td class="num">${formatNumber(n)}</td></tr>`)}
        </tbody></table></div></div>
      </section>
    </div>`;
}

function shell() {
  root.innerHTML = html`
    <div data-pending></div>
    ${ctx.isOwner ? html`
      <section aria-label="${t('admin.dash.rangeLabel')}">
        <div class="toolbar" role="group" aria-label="${t('admin.dash.rangeLabel')}">
          ${[['today', 'rangeToday'], ['7', 'range7'], ['30', 'range30'], ['custom', 'rangeCustom']].map(([k, label]) => html`
            <button type="button" class="chip" data-range="${k}" aria-pressed="${String(range === k)}">${t(`admin.dash.${label}`)}</button>`)}
          <span class="custom-range" data-custom hidden style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <label class="label" for="r-from">${t('admin.dash.from')}</label><input class="input" id="r-from" type="date" value="${custom.from}">
            <label class="label" for="r-to">${t('admin.dash.to')}</label><input class="input" id="r-to" type="date" value="${custom.to}">
            <button type="button" class="btn primary sm" data-apply>${t('admin.dash.apply')}</button>
          </span>
        </div>
        <div data-stats aria-live="polite" style="margin-top:18px"></div>
      </section>` : ''}
    <div class="admin-grid" style="margin-top:22px" data-lists></div>`.toString();
  root.querySelector('.toolbar')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (b) { range = b.dataset.range; syncRange(); if (range !== 'custom') loadStats(); }
    if (e.target.closest('[data-apply]')) applyCustom();
  });
  syncRange();
}

function syncRange() {
  root.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
  const c = root.querySelector('[data-custom]');
  if (c) c.hidden = range !== 'custom';
}

function applyCustom() {
  const from = root.querySelector('#r-from').value;
  const to = root.querySelector('#r-to').value;
  if (!from || !to || to < from) { toast(t(from && to ? 'errors.INVALID_DATE_RANGE' : 'admin.dash.customRange'), { type: 'error' }); return; }
  custom = { from, to };
  loadStats();
}

async function loadStats() {
  const box = root.querySelector('[data-stats]');
  const { from, to } = rangeDates();
  showLoading(box);
  try {
    const s = await rpc('dashboard_stats', { date_from: from, date_to: to });
    box.removeAttribute('aria-busy');
    box.innerHTML = statsHtml(s).toString();
  } catch (err) {
    showError(box, { error: err, onRetry: loadStats });
  }
}

async function load() {
  shell();
  const lists = root.querySelector('[data-lists]');
  showLoading(lists);
  try {
    overview = await rpc('staff_overview');
    root.querySelector('[data-pending]').innerHTML = pendingHtml(overview).toString();
    lists.removeAttribute('aria-busy');
    lists.classList.add('split');
    lists.innerHTML = html`${flaggedHtml(overview)}${lowStockHtml(overview)}`.toString();
  } catch (err) {
    showError(lists, { message: `${t('admin.dash.loadError')} ${errorMessage(err)}`, onRetry: load });
  }
  if (ctx.isOwner) loadStats();
}

window.addEventListener('admin:new-order', () => { if (overview) rpc('staff_overview').then((o) => { overview = o; root.querySelector('[data-pending]').innerHTML = pendingHtml(o).toString(); }).catch(() => {}); });
load();
