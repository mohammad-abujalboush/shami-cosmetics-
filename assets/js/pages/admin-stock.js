// /admin/stock.html (staff + owner) — every variant with its stock, filters (low / out), search,
// adjustment via adjust_stock (always logged, with a reason) and the movement history of a variant.
import { initAdmin, formDialog, loadStaffNames, whoName } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatDate, formatNumber, toWesternDigits, normalizeArabic, showLoading, showError, showEmpty, toast, errorMessage, getParam } from '../utils.js';
import { run, rpc } from '../supabase.js';
import { field, textarea, input, runChecks, parseSignedInt } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'stock' });
document.title = t('admin.stock.meta');
const root = document.querySelector('[data-slot="stock"]');
const PAGE = 40;
let rows = [];
let names = new Map();
const f = { q: getParam('q') || '', filter: ['low', 'out', 'inactive'].includes(getParam('f')) ? getParam('f') : '', page: 1 };

async function load() {
  showLoading(root);
  try {
    names = await loadStaffNames();
    const data = await run(ctx.sb.from('product_variants')
      .select('id, label, sku, stock, low_stock_threshold, active, product_id, products(name_ar, name_en, active, category_id)')
      .order('product_id').order('sort').order('id'));
    rows = data.filter((v) => v.products);
    buildShell();
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

const level = (v) => (v.stock === 0 ? 'out' : v.stock <= v.low_stock_threshold ? 'low' : 'ok');

function buildShell() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <form class="toolbar" data-filters role="search">
      <div class="grow search-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <label class="sr-only" for="st-q">${t('admin.stock.search')}</label>
        <input class="input" id="st-q" type="search" value="${f.q}" placeholder="${t('admin.stock.searchPlaceholder')}" autocomplete="off"></div>
      <div class="chip-row" role="group" aria-label="${t('admin.stock.filter')}" style="justify-content:flex-start">
        ${['', 'low', 'out', 'inactive'].map((k) => html`<button type="button" class="chip" data-filter="${k}" aria-pressed="${String(f.filter === k)}">${t(`admin.stock.filters.${k || 'all'}`)}</button>`)}
      </div>
    </form>
    <div data-list aria-live="polite"></div>`.toString();
  const q = root.querySelector('#st-q');
  q.addEventListener('input', () => { f.q = q.value; f.page = 1; paint(); });
  root.querySelector('[data-filters]').addEventListener('submit', (e) => e.preventDefault());
  root.querySelector('.chip-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    f.filter = b.dataset.filter; f.page = 1;
    root.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.filter === f.filter)));
    paint();
  });
  root.querySelector('[data-list]').addEventListener('click', onClick);
}

function filtered() {
  const text = normalizeArabic(f.q);
  return rows.filter((v) => {
    if (f.filter === 'low' && !(level(v) === 'low' || level(v) === 'out')) return false;
    if (f.filter === 'out' && level(v) !== 'out') return false;
    if (f.filter === 'inactive' && v.active && v.products.active) return false;
    if (!text) return true;
    return normalizeArabic(`${v.products.name_ar} ${v.products.name_en || ''} ${v.label} ${v.sku || ''}`).includes(text);
  });
}

function paint() {
  const list = root.querySelector('[data-list]');
  const all = filtered();
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  f.page = Math.min(f.page, pages);
  const slice = all.slice((f.page - 1) * PAGE, f.page * PAGE);
  if (!all.length) { showEmpty(list, { title: t('admin.stock.emptyTitle'), text: t('admin.stock.emptyText') }); return; }
  list.removeAttribute('aria-busy');
  list.innerHTML = html`
    <p class="hint" style="margin:0 0 8px">${t('admin.stock.count', { count: all.length })}</p>
    <div class="data-table-wrap"><table class="data-table wide">
      <thead><tr><th>${t('admin.stock.product')}</th><th>${t('admin.stock.sku')}</th><th class="num">${t('admin.stock.stock')}</th><th class="num">${t('admin.stock.threshold')}</th><th>${t('admin.common.status')}</th><th class="actions">${t('admin.common.actions')}</th></tr></thead>
      <tbody>${slice.map((v) => { const l = level(v); return html`
        <tr class="${l === 'out' ? 'is-flagged' : ''} ${v.active && v.products.active ? '' : 'is-muted'}">
          <td><div class="cell-main">${v.products.name_ar}</div><div class="cell-sub">${v.label}</div></td>
          <td>${v.sku ? ltr(v.sku) : '—'}</td>
          <td class="num"><strong>${formatNumber(v.stock)}</strong></td>
          <td class="num">${formatNumber(v.low_stock_threshold)}</td>
          <td><span class="badge ${l === 'out' ? 'danger' : l === 'low' ? 'warning' : 'success'}">${t(`admin.stock.level.${l}`)}</span>${v.active && v.products.active ? '' : html` <span class="badge">${t('admin.common.inactive')}</span>`}</td>
          <td class="actions"><button type="button" class="btn primary sm" data-adjust="${v.id}">${t('admin.stock.adjust')}</button>
            <button type="button" class="btn ghost sm" data-history="${v.id}">${t('admin.stock.history')}</button></td></tr>`; })}</tbody>
    </table></div>
    <div class="pagination"><span>${t('admin.orders.page', { page: f.page, pages })}</span><span class="pages">
      <button type="button" class="btn ghost sm" data-goto="${f.page - 1}" ${raw(f.page <= 1 ? 'disabled' : '')}>${t('admin.orders.prev')}</button>
      <button type="button" class="btn ghost sm" data-goto="${f.page + 1}" ${raw(f.page >= pages ? 'disabled' : '')}>${t('admin.orders.next')}</button></span></div>`.toString();
}

async function adjust(v) {
  const data = await formDialog({
    title: t('admin.stock.adjustTitle', { name: v.products.name_ar, label: v.label }), confirmLabel: t('admin.stock.apply'),
    body: html`<p style="margin:0">${t('admin.stock.current', { n: v.stock })}</p>
      ${field('a-change', t('admin.stock.change'), input({ id: 'a-change', name: 'change', dir: 'ltr', inputmode: 'numeric', hint: t('admin.stock.changeHint') }), { hint: t('admin.stock.changeHint') })}
      ${field('a-note', t('admin.stock.reason'), textarea({ id: 'a-note', name: 'note', rows: 2, maxlength: 500 }), { hint: t('admin.stock.reasonHint') })}
      <p class="hint" data-after style="margin:0"></p>`,
    onOpen: (form) => form.elements.change.addEventListener('input', () => {
      const n = parseSignedInt(form.elements.change.value);
      form.querySelector('[data-after]').textContent = Number.isInteger(n) && n !== 0 ? t('admin.stock.after', { n: v.stock + n }) : '';
    }),
    validate: (form) => {
      const n = parseSignedInt(form.elements.change.value);
      const note = form.elements.note.value.trim();
      return runChecks(form, [
        ['a-change', n === null ? t('validation.required') : (!Number.isInteger(n) || n === 0 || Math.abs(n) > 100000 ? t('admin.stock.changeInvalid') : (v.stock + n < 0 ? t('errors.INSUFFICIENT_STOCK') : ''))],
        ['a-note', note ? '' : t('admin.stock.reasonRequired')],
      ]);
    },
  });
  if (!data) return;
  const n = parseSignedInt(data.get('change'));
  try {
    const r = await rpc('adjust_stock', { variant_id: v.id, change: n, note: String(data.get('note')).trim() });
    v.stock = r.stock;
    toast(t('admin.stock.adjusted', { n: r.stock }), { type: 'success' });
    paint();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
    load();
  }
}

async function history(v) {
  let moves = [];
  try {
    moves = await run(ctx.sb.from('stock_movements').select('id, change, balance_after, reason, note, created_at, created_by, orders(order_number)')
      .eq('variant_id', v.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100));
  } catch (err) {
    toast(errorMessage(err), { type: 'error' });
    return;
  }
  await formDialog({
    title: t('admin.stock.historyTitle', { name: v.products.name_ar, label: v.label }), large: true, confirmLabel: t('common.close'),
    body: moves.length ? html`<div class="data-table-wrap"><table class="data-table"><thead><tr><th>${t('admin.stock.when')}</th><th class="num">${t('admin.stock.changeCol')}</th><th class="num">${t('admin.stock.balance')}</th><th>${t('admin.stock.reasonCol')}</th><th>${t('admin.stock.by')}</th></tr></thead>
      <tbody>${moves.map((m) => html`<tr><td class="cell-sub" style="white-space:nowrap">${formatDate(m.created_at)}</td>
        <td class="num" dir="ltr" style="color:${m.change > 0 ? 'var(--success)' : 'var(--danger)'}">${m.change > 0 ? '+' : ''}${m.change}</td>
        <td class="num">${m.balance_after}</td>
        <td>${t(`admin.stock.reasons.${m.reason}`)}${m.orders?.order_number ? html` ${ltr(m.orders.order_number)}` : ''}${m.note ? html`<div class="cell-sub">${m.note}</div>` : ''}</td>
        <td class="cell-sub">${m.created_by ? whoName(names, m.created_by) : t('admin.detail.bySystem')}</td></tr>`)}</tbody></table></div>`
      : html`<p class="hint">${t('admin.stock.noHistory')}</p>`,
  });
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  const find = (id) => rows.find((v) => String(v.id) === String(id));
  if (b.dataset.adjust) adjust(find(b.dataset.adjust));
  if (b.dataset.history) history(find(b.dataset.history));
  if (b.dataset.goto && !b.disabled) { f.page = Number(b.dataset.goto); paint(); window.scrollTo({ top: 0 }); }
}

load();
