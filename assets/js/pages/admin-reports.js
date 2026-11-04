// /admin/reports.html (owner) — sales by day, top products, sales by governorate, payment-method split and refunds
// for a date range (sales_report RPC, whole days in Asia/Amman) + CSV export (UTF-8 with BOM so Excel reads Arabic).
import { initAdmin, ammanDate } from '../admin.js';
import { t, html, raw, formatPrice, formatNumber, showLoading, showError, toast, errorMessage } from '../utils.js';
import { rpc } from '../supabase.js';

const ctx = await initAdmin({ page: 'reports', ownerOnly: true });
document.title = t('admin.reports.meta');
const root = document.querySelector('[data-slot="reports"]');
let range = { from: ammanDate(-29), to: ammanDate() };
let preset = '30';
let report = null;

function setPreset(p) {
  preset = p;
  const today = ammanDate();
  if (p === 'today') range = { from: today, to: today };
  if (p === '7') range = { from: ammanDate(-6), to: today };
  if (p === '30') range = { from: ammanDate(-29), to: today };
  if (p === '90') range = { from: ammanDate(-89), to: today };
  if (p === 'month') range = { from: `${today.slice(0, 8)}01`, to: today };
}

function shell() {
  root.innerHTML = html`
    <div class="toolbar" data-toolbar role="group" aria-label="${t('admin.reports.range')}">
      ${['today', '7', '30', '90', 'month', 'custom'].map((p) => html`<button type="button" class="chip" data-preset="${p}" aria-pressed="${String(preset === p)}">${t(`admin.reports.presets.${p}`)}</button>`)}
      <label class="label" for="rp-from">${t('admin.dash.from')}</label><input class="input" id="rp-from" type="date" value="${range.from}">
      <label class="label" for="rp-to">${t('admin.dash.to')}</label><input class="input" id="rp-to" type="date" value="${range.to}">
      <button type="button" class="btn primary sm" data-apply>${t('admin.dash.apply')}</button>
      <span class="grow"></span>
      <button type="button" class="btn ghost sm" data-csv disabled>${t('admin.reports.exportCsv')}</button>
    </div>
    <p class="hint" style="margin:0 0 14px">${t('admin.reports.basis')}</p>
    <div data-body aria-live="polite"></div>`.toString();
  const bar = root.querySelector('[data-toolbar]');
  bar.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) { if (p.dataset.preset === 'custom') { preset = 'custom'; } else { setPreset(p.dataset.preset); root.querySelector('#rp-from').value = range.from; root.querySelector('#rp-to').value = range.to; } sync(); if (preset !== 'custom') load(); }
    if (e.target.closest('[data-apply]')) {
      const from = root.querySelector('#rp-from').value; const to = root.querySelector('#rp-to').value;
      if (!from || !to) { toast(t('admin.dash.customRange'), { type: 'error' }); return; }
      if (to < from || (new Date(to) - new Date(from)) / 86400000 > 366) { toast(t('errors.INVALID_DATE_RANGE'), { type: 'error' }); return; }
      range = { from, to }; preset = 'custom'; sync(); load();
    }
    if (e.target.closest('[data-csv]')) exportCsv();
  });
}
const sync = () => root.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));

const share = (n, total) => (total > 0 ? `${formatNumber(Math.round((n / total) * 1000) / 10)}%` : '—');

function tableHtml(head, rows) {
  return html`<div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table">
    <thead><tr>${head.map(([label, num]) => html`<th class="${num ? 'num' : ''}">${label}</th>`)}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function render() {
  const r = report;
  const body = root.querySelector('[data-body]');
  const maxRev = Math.max(...r.by_day.map((d) => Number(d.revenue)), 0);
  const totalRev = Number(r.totals.revenue);
  body.removeAttribute('aria-busy');
  body.innerHTML = html`
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">${t('admin.dash.ordersTotal')}</div><div class="kpi-value">${formatNumber(r.totals.orders)}</div></div>
      <div class="kpi"><div class="kpi-label">${t('admin.dash.delivered')}</div><div class="kpi-value">${formatNumber(r.totals.delivered)}</div></div>
      <div class="kpi"><div class="kpi-label">${t('admin.dash.revenue')}</div><div class="kpi-value">${formatPrice(r.totals.revenue)}</div></div>
      <div class="kpi"><div class="kpi-label">${t('admin.dash.deliveryFees')}</div><div class="kpi-value">${formatPrice(r.totals.delivery_fees)}</div></div>
      <div class="kpi"><div class="kpi-label">${t('admin.dash.discounts')}</div><div class="kpi-value">${formatPrice(r.totals.discounts)}</div></div>
      <div class="kpi"><div class="kpi-label">${t('admin.reports.cancelledReturned')}</div><div class="kpi-value">${formatNumber(Number(r.totals.cancelled) + Number(r.totals.returned))}</div>
        <div class="kpi-meta">${t('admin.reports.cancelledReturnedMeta', { c: r.totals.cancelled, r: r.totals.returned })}</div></div>
    </div>

    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.reports.byDay')}</h2></div>
      <div class="panel-body flush">${tableHtml([[t('admin.reports.day')], [t('admin.reports.orders'), 1], [t('admin.dash.delivered'), 1], [t('admin.dash.sales'), 1], [t('admin.reports.chart')]],
        r.by_day.map((d) => html`<tr><td style="white-space:nowrap">${d.day}</td><td class="num">${formatNumber(d.orders)}</td><td class="num">${formatNumber(d.delivered)}</td>
          <td class="num">${formatPrice(d.revenue)}</td>
          <td style="min-width:120px"><div class="bar" style="height:10px;border-radius:6px;background:var(--gold);width:${maxRev ? Math.max(2, (Number(d.revenue) / maxRev) * 100) : 0}%" role="img" aria-label="${formatPrice(d.revenue)}"></div></td></tr>`))}</div></section>

    <div class="admin-grid split" style="margin-top:20px">
      <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.reports.topProducts')}</h2></div>
        <div class="panel-body flush">${r.top_products.length ? tableHtml([[t('admin.dash.product')], [t('admin.dash.qty'), 1], [t('admin.dash.sales'), 1]],
          r.top_products.map((p) => html`<tr><td class="cell-main">${p.product_name_ar}</td><td class="num">${formatNumber(p.quantity)}</td><td class="num">${formatPrice(p.gross_sales)}</td></tr>`))
          : html`<p class="panel-body hint">${t('admin.dash.topEmpty')}</p>`}</div></section>
      <div class="admin-grid" style="align-content:start">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.reports.byMethod')}</h2></div>
          <div class="panel-body flush">${tableHtml([[t('admin.orders.payMethod')], [t('admin.reports.orders'), 1], [t('admin.dash.sales'), 1], [t('admin.reports.share'), 1]],
            r.by_payment_method.map((m) => html`<tr><td class="cell-main">${t(`order.methods.${m.method}`)}</td><td class="num">${formatNumber(m.orders)}</td><td class="num">${formatPrice(m.revenue)}</td><td class="num">${share(Number(m.revenue), totalRev)}</td></tr>`))}</div></section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.reports.refunds')}</h2></div>
          <div class="panel-body"><dl class="kv">
            <dt>${t('admin.reports.refundDue')}</dt><dd>${formatNumber(r.refunds.refund_due_count)} — ${formatPrice(r.refunds.refund_due_amount)}</dd>
            <dt>${t('admin.reports.refunded')}</dt><dd>${formatNumber(r.refunds.refunded_count)} — ${formatPrice(r.refunds.refunded_amount)}</dd></dl></div></section>
      </div>
    </div>

    <section class="panel" style="margin-top:20px"><div class="panel-head"><h2 class="panel-title">${t('admin.reports.byGovernorate')}</h2></div>
      <div class="panel-body flush">${tableHtml([[t('admin.orders.governorate')], [t('admin.reports.orders'), 1], [t('admin.dash.delivered'), 1], [t('admin.dash.sales'), 1], [t('admin.reports.share'), 1]],
        r.by_governorate.map((g) => html`<tr><td class="cell-main">${g.governorate_name}</td><td class="num">${formatNumber(g.orders)}</td><td class="num">${formatNumber(g.delivered)}</td><td class="num">${formatPrice(g.revenue)}</td><td class="num">${share(Number(g.revenue), totalRev)}</td></tr>`))}</div></section>`.toString();
  root.querySelector('[data-csv]').disabled = false;
}

async function load() {
  const body = root.querySelector('[data-body]');
  root.querySelector('[data-csv]').disabled = true;
  showLoading(body);
  try {
    report = await rpc('sales_report', { date_from: range.from, date_to: range.to });
    render();
  } catch (err) {
    showError(body, { error: err, onRetry: load });
  }
}

/* ---------- CSV ---------- */

const cell = (v) => {
  const s = String(v ?? '');
  // Spreadsheet formula injection guard for text cells starting with = + - @
  const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const line = (arr) => arr.map(cell).join(',');

function exportCsv() {
  const r = report;
  const n = (x) => Number(x);
  const out = [
    line([t('admin.reports.title'), `${r.range.from} → ${r.range.to}`]), '',
    line([t('admin.reports.totals')]),
    line([t('admin.dash.ordersTotal'), n(r.totals.orders)]), line([t('admin.dash.delivered'), n(r.totals.delivered)]),
    line([t('admin.dash.revenue'), n(r.totals.revenue)]), line([t('admin.dash.deliveryFees'), n(r.totals.delivery_fees)]), line([t('admin.dash.discounts'), n(r.totals.discounts)]), '',
    line([t('admin.reports.byDay')]), line([t('admin.reports.day'), t('admin.reports.orders'), t('admin.dash.delivered'), t('admin.dash.sales')]),
    ...r.by_day.map((d) => line([d.day, n(d.orders), n(d.delivered), n(d.revenue)])), '',
    line([t('admin.reports.topProducts')]), line([t('admin.dash.product'), t('admin.dash.qty'), t('admin.dash.sales')]),
    ...r.top_products.map((p) => line([p.product_name_ar, n(p.quantity), n(p.gross_sales)])), '',
    line([t('admin.reports.byGovernorate')]), line([t('admin.orders.governorate'), t('admin.reports.orders'), t('admin.dash.delivered'), t('admin.dash.sales')]),
    ...r.by_governorate.map((g) => line([g.governorate_name, n(g.orders), n(g.delivered), n(g.revenue)])), '',
    line([t('admin.reports.byMethod')]), line([t('admin.orders.payMethod'), t('admin.reports.orders'), t('admin.dash.sales')]),
    ...r.by_payment_method.map((m) => line([t(`order.methods.${m.method}`), n(m.orders), n(m.revenue)])), '',
    line([t('admin.reports.refunds')]),
    line([t('admin.reports.refundDue'), n(r.refunds.refund_due_count), n(r.refunds.refund_due_amount)]),
    line([t('admin.reports.refunded'), n(r.refunds.refunded_count), n(r.refunds.refunded_amount)]),
  ];
  const blob = new Blob(['﻿', out.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shami-report-${r.range.from}_${r.range.to}.csv`;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

shell();
load();
