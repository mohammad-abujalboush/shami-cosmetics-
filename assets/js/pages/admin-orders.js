// /admin/orders.html — filterable, paginated order list with CliQ / refund flags, bulk print and live
// new-order refresh. All filters are plain PostgREST queries on `orders` (RLS: staff read all).
import { initAdmin, ammanDayStart, isOverdueCliq } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatDate, formatPhone, toWesternDigits, showLoading, showError, showEmpty,
         toast, debounce, errorMessage } from '../utils.js';
import { run } from '../supabase.js';

const ctx = await initAdmin({ page: 'orders' });
document.title = t('admin.orders.meta');
const PAGE_SIZE = 25;
const MAX_PRINT = 50;
const root = document.querySelector('[data-slot="orders"]');
const STATUSES = ['new', 'confirmed', 'with_courier', 'delivered', 'cancelled', 'returned'];
const PAY_STATUSES = ['unpaid', 'awaiting_transfer', 'awaiting_verification', 'paid', 'refund_due', 'refunded'];

const params = new URLSearchParams(location.search);
const f = {
  q: params.get('q') || '', status: params.get('status') || '', method: params.get('method') || '', pay: params.get('pay') || '',
  gov: params.get('gov') || '', from: params.get('from') || '', to: params.get('to') || '', overdue: params.get('overdue') === '1',
  page: Math.max(1, Number(params.get('page')) || 1),
};
const selected = new Map();   // id → order_number, kept across pages
const fresh = new Set();      // ids that arrived live (highlighted until the next filter change)
let total = 0;
let seq = 0;

const nextDay = (d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const clean = (s) => String(s).replace(/[,()*%\\":]/g, ' ').replace(/\s+/g, ' ').trim();

function applyFilters(q) {
  if (f.status) q = q.eq('status', f.status);
  if (f.method) q = q.eq('payment_method', f.method);
  if (f.pay) q = q.eq('payment_status', f.pay);
  if (f.gov) q = q.eq('governorate_id', Number(f.gov));
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from)) q = q.gte('created_at', ammanDayStart(f.from));
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) q = q.lt('created_at', ammanDayStart(nextDay(f.to)));
  if (f.overdue) {
    q = q.eq('payment_method', 'cliq').in('payment_status', ['awaiting_transfer', 'awaiting_verification'])
      .not('status', 'in', '(cancelled,returned)')
      .lt('created_at', new Date(Date.now() - ctx.cliqWindow * 3600000).toISOString());
  }
  const text = clean(toWesternDigits(f.q));
  if (text) {
    const clauses = [`order_number.ilike.%${text}%`, `customer_name.ilike.%${text}%`];
    const digits = text.replace(/\D/g, '').replace(/^(00)?962/, '').replace(/^0/, '');
    if (digits.length >= 3) clauses.push(`phone.ilike.%${digits}%`);
    q = q.or(clauses.join(','));
  }
  return q;
}

function syncUrl() {
  const p = new URLSearchParams();
  Object.entries({ q: f.q, status: f.status, method: f.method, pay: f.pay, gov: f.gov, from: f.from, to: f.to }).forEach(([k, v]) => { if (v) p.set(k, v); });
  if (f.overdue) p.set('overdue', '1');
  if (f.page > 1) p.set('page', String(f.page));
  history.replaceState(null, '', `${location.pathname}${p.toString() ? `?${p}` : ''}`);
}

/* ---------- Static shell ---------- */

const opt = (value, label, current) => html`<option value="${value}" ${raw(String(current) === String(value) ? 'selected' : '')}>${label}</option>`;

async function buildShell() {
  let govs = [];
  try { govs = await run(ctx.sb.from('governorates').select('id, name_ar').order('sort').order('id')); } catch { /* filter simply stays empty */ }
  root.innerHTML = html`
    <form class="toolbar" data-filters role="search" aria-label="${t('admin.orders.search')}">
      <div class="grow search-input">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <label class="sr-only" for="f-q">${t('admin.orders.search')}</label>
        <input class="input" id="f-q" type="search" name="q" value="${f.q}" placeholder="${t('admin.orders.searchPlaceholder')}" autocomplete="off">
      </div>
      <label class="sr-only" for="f-status">${t('admin.orders.status')}</label>
      <select class="select" id="f-status" name="status"><option value="">${t('admin.orders.status')}: ${t('admin.orders.all')}</option>${STATUSES.map((s) => opt(s, t(`order.statuses.${s}`), f.status))}</select>
      <label class="sr-only" for="f-method">${t('admin.orders.payMethod')}</label>
      <select class="select" id="f-method" name="method"><option value="">${t('admin.orders.payMethod')}: ${t('admin.orders.all')}</option>${['cod', 'cliq'].map((m) => opt(m, t(`order.methods.${m}`), f.method))}</select>
      <label class="sr-only" for="f-pay">${t('admin.orders.payStatus')}</label>
      <select class="select" id="f-pay" name="pay"><option value="">${t('admin.orders.payStatus')}: ${t('admin.orders.all')}</option>${PAY_STATUSES.map((s) => opt(s, t(`order.payStatuses.${s}`), f.pay))}</select>
      <label class="sr-only" for="f-gov">${t('admin.orders.governorate')}</label>
      <select class="select" id="f-gov" name="gov"><option value="">${t('admin.orders.governorate')}: ${t('admin.orders.all')}</option>${govs.map((g) => opt(g.id, g.name_ar, f.gov))}</select>
      <label class="label" for="f-from">${t('admin.orders.from')}</label>
      <input class="input" id="f-from" type="date" name="from" value="${f.from}">
      <label class="label" for="f-to">${t('admin.orders.to')}</label>
      <input class="input" id="f-to" type="date" name="to" value="${f.to}">
      <label class="check"><input type="checkbox" name="overdue" ${raw(f.overdue ? 'checked' : '')}> <span>${t('admin.orders.overdueOnly')}</span></label>
      <button type="button" class="btn ghost sm" data-clear>${t('admin.orders.clear')}</button>
    </form>
    <div class="bulk-bar" data-bulk hidden>
      <span data-bulk-count></span>
      <button type="button" class="btn light sm" data-print>${t('admin.orders.printSelected')}</button>
      <button type="button" class="btn ghost sm" style="color:var(--cream);border-color:rgba(251,248,242,.4)" data-clear-selection>${t('admin.orders.clearSelection')}</button>
    </div>
    <div data-list aria-live="polite"></div>`.toString();

  const form = root.querySelector('[data-filters]');
  const read = () => {
    const d = new FormData(form);
    Object.assign(f, { q: String(d.get('q') || '').trim(), status: d.get('status') || '', method: d.get('method') || '', pay: d.get('pay') || '',
      gov: d.get('gov') || '', from: d.get('from') || '', to: d.get('to') || '', overdue: form.elements.overdue.checked, page: 1 });
    fresh.clear();
    load();
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); read(); });
  form.addEventListener('change', read);
  form.elements.q.addEventListener('input', debounce(read, 400));
  form.querySelector('[data-clear]').addEventListener('click', () => {
    form.reset();
    Object.assign(f, { q: '', status: '', method: '', pay: '', gov: '', from: '', to: '', overdue: false, page: 1 });
    form.querySelectorAll('select, input[type="search"], input[type="date"]').forEach((el) => { el.value = ''; });
    form.elements.overdue.checked = false;
    fresh.clear();
    load();
  });
  root.querySelector('[data-print]').addEventListener('click', () => {
    if (selected.size > MAX_PRINT) { toast(t('admin.orders.maxPrint'), { type: 'error' }); return; }
    window.open(`/admin/print.html?ids=${[...selected.keys()].join(',')}`, '_blank', 'noopener');
  });
  root.querySelector('[data-clear-selection]').addEventListener('click', () => { selected.clear(); paintSelection(); });
  root.querySelector('[data-list]').addEventListener('change', (e) => {
    const row = e.target.closest('[data-row-check]');
    if (row) { if (row.checked) selected.set(row.dataset.id, row.dataset.number); else selected.delete(row.dataset.id); paintSelection(); return; }
    if (e.target.matches('[data-check-all]')) {
      root.querySelectorAll('[data-row-check]').forEach((c) => { c.checked = e.target.checked; if (c.checked) selected.set(c.dataset.id, c.dataset.number); else selected.delete(c.dataset.id); });
      paintSelection();
    }
  });
  root.querySelector('[data-list]').addEventListener('click', (e) => {
    const p = e.target.closest('[data-goto]');
    if (p && !p.disabled) { f.page = Number(p.dataset.goto); load(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
}

function paintSelection() {
  const bar = root.querySelector('[data-bulk]');
  bar.hidden = selected.size === 0;
  root.querySelector('[data-bulk-count]').textContent = t('admin.orders.selected', { count: selected.size });
  root.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('is-selected', selected.has(tr.dataset.id)));
  const all = root.querySelector('[data-check-all]');
  const boxes = [...root.querySelectorAll('[data-row-check]')];
  if (all) all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
}

/* ---------- List ---------- */

function rowHtml(o) {
  const overdue = isOverdueCliq(o, ctx.cliqWindow);
  const due = o.payment_status === 'refund_due';
  const qty = o.order_items.reduce((s, i) => s + i.quantity, 0);
  return html`
    <tr data-id="${o.id}" class="${overdue || due ? 'is-flagged' : ''} ${fresh.has(o.id) ? 'is-new' : ''} ${selected.has(o.id) ? 'is-selected' : ''}">
      <td class="check-col"><input type="checkbox" data-row-check data-id="${o.id}" data-number="${o.order_number}" ${raw(selected.has(o.id) ? 'checked' : '')} aria-label="${t('admin.orders.selectRow', { number: o.order_number })}"></td>
      <td><a class="cell-main link-inline" href="/admin/order.html?id=${o.id}">${ltr(o.order_number)}</a><div class="cell-sub">${t('admin.orders.itemsCount', { n: qty })}</div></td>
      <td><div class="cell-main">${o.customer_name}</div><div class="cell-sub">${ltr(formatPhone(o.phone))}</div></td>
      <td>${o.governorate_name}</td>
      <td class="num">${formatPrice(o.total)}</td>
      <td><span class="badge" data-status="${o.status}">${t(`order.statuses.${o.status}`)}</span></td>
      <td><div>${t(`order.methods.${o.payment_method}`)}</div>
        <span class="badge" data-status="${o.payment_status}">${t(`order.payStatuses.${o.payment_status}`)}</span>
        ${overdue ? html` <span class="badge warning">${t('admin.orders.overdue')}</span>` : ''}
        ${due ? html` <span class="badge danger">${t('admin.orders.refundDue')}</span>` : ''}</td>
      <td class="cell-sub" style="white-space:nowrap">${formatDate(o.created_at)}</td>
      <td class="actions"><a class="btn ghost sm" href="/admin/order.html?id=${o.id}">${t('admin.orders.view')}</a></td>
    </tr>`;
}

async function load() {
  const list = root.querySelector('[data-list]');
  const mine = ++seq;
  syncUrl();
  showLoading(list);
  try {
    const from = (f.page - 1) * PAGE_SIZE;
    let q = ctx.sb.from('orders')
      .select('id, order_number, customer_name, phone, governorate_name, total, status, payment_method, payment_status, created_at, order_items(quantity)', { count: 'exact' });
    q = applyFilters(q).order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1);
    const { data, error, count } = await q;
    if (mine !== seq) return;
    if (error) throw error;
    total = count ?? 0;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (f.page > pages) { f.page = pages; load(); return; }
    if (!data.length) {
      showEmpty(list, { title: t('admin.orders.emptyTitle'), text: t('admin.orders.emptyText') });
      return;
    }
    list.removeAttribute('aria-busy');
    list.innerHTML = html`
      <p class="hint" style="margin:0 0 8px">${t('admin.orders.count', { count: total })}</p>
      <div class="data-table-wrap"><table class="data-table wide">
        <thead><tr>
          <th class="check-col"><input type="checkbox" data-check-all aria-label="${t('admin.orders.selectAll')}"></th>
          <th>${t('admin.orders.colNumber')}</th><th>${t('admin.orders.colCustomer')}</th><th>${t('admin.orders.colGovernorate')}</th>
          <th class="num">${t('admin.orders.colTotal')}</th><th>${t('admin.orders.colStatus')}</th><th>${t('admin.orders.colPayment')}</th>
          <th>${t('admin.orders.colDate')}</th><th class="actions">${t('admin.orders.colActions')}</th>
        </tr></thead>
        <tbody>${data.map(rowHtml)}</tbody></table></div>
      <div class="pagination">
        <span>${t('admin.orders.page', { page: f.page, pages })}</span>
        <span class="pages">
          <button type="button" class="btn ghost sm" data-goto="${f.page - 1}" ${raw(f.page <= 1 ? 'disabled' : '')}>${t('admin.orders.prev')}</button>
          <button type="button" class="btn ghost sm" data-goto="${f.page + 1}" ${raw(f.page >= pages ? 'disabled' : '')}>${t('admin.orders.next')}</button>
        </span>
      </div>`.toString();
    paintSelection();
  } catch (err) {
    if (mine !== seq) return;
    showError(list, { message: `${t('admin.orders.loadError')} ${errorMessage(err)}`, onRetry: load });
  }
}

// A new order arrived (Realtime): show it at the top when looking at page 1.
window.addEventListener('admin:new-order', (e) => {
  fresh.add(e.detail.id);
  if (f.page === 1) load();
});

await buildShell();
load();
