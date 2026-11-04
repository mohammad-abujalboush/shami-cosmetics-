// /admin/products.html (owner) — product list: search, filters, quick active / bestseller toggles, delete.
// A product that appears in any order can only be deactivated (orders keep snapshots, but the history stays honest).
import { initAdmin } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatNumber, normalizeArabic, showLoading, showError, showEmpty, toast, errorMessage, toAppError } from '../utils.js';
import { run } from '../supabase.js';
import { imageUrl, placeholderSvg } from '../catalog.js';
import { confirmDelete } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'products', ownerOnly: true });
document.title = t('admin.products.meta');
const root = document.querySelector('[data-slot="products"]');
const PAGE = 30;
const q0 = new URLSearchParams(location.search);
const f = { q: q0.get('q') || '', cat: q0.get('cat') || '', status: q0.get('status') || '', page: 1 };
let rows = [];
let cats = [];

async function load() {
  showLoading(root);
  try {
    const [products, categories] = await Promise.all([
      run(ctx.sb.from('products').select('id, slug, name_ar, name_en, active, is_bestseller, sort, category_id, product_variants(id, price, stock, active, low_stock_threshold), product_images(path, sort)').order('sort').order('id', { ascending: false })),
      run(ctx.sb.from('categories').select('id, name_ar, key').order('sort')),
    ]);
    rows = products; cats = categories;
    buildShell(); paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

const info = (p) => {
  const act = p.product_variants.filter((v) => v.active);
  const from = act.length ? Math.min(...act.map((v) => Number(v.price))) : null;
  const stock = act.reduce((s, v) => s + v.stock, 0);
  const low = act.some((v) => v.stock <= v.low_stock_threshold);
  const img = p.product_images.slice().sort((a, b) => a.sort - b.sort)[0]?.path;
  return { act, from, stock, low, img };
};

function buildShell() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <form class="toolbar" data-filters role="search">
      <div class="grow search-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <label class="sr-only" for="p-q">${t('admin.products.search')}</label>
        <input class="input" id="p-q" type="search" value="${f.q}" placeholder="${t('admin.products.searchPlaceholder')}" autocomplete="off"></div>
      <label class="sr-only" for="p-cat">${t('admin.products.category')}</label>
      <select class="select" id="p-cat"><option value="">${t('admin.products.category')}: ${t('admin.orders.all')}</option>${cats.map((c) => html`<option value="${c.id}" ${raw(String(c.id) === f.cat ? 'selected' : '')}>${c.name_ar}</option>`)}</select>
      <label class="sr-only" for="p-status">${t('admin.common.status')}</label>
      <select class="select" id="p-status"><option value="">${t('admin.common.status')}: ${t('admin.orders.all')}</option>
        ${['active', 'inactive', 'low', 'noimage'].map((s) => html`<option value="${s}" ${raw(s === f.status ? 'selected' : '')}>${t(`admin.products.status.${s}`)}</option>`)}</select>
    </form>
    <div data-list aria-live="polite"></div>`.toString();
  const set = () => { f.q = root.querySelector('#p-q').value; f.cat = root.querySelector('#p-cat').value; f.status = root.querySelector('#p-status').value; f.page = 1; paint(); };
  root.querySelector('[data-filters]').addEventListener('input', set);
  root.querySelector('[data-filters]').addEventListener('submit', (e) => e.preventDefault());
  root.querySelector('[data-list]').addEventListener('click', onClick);
  root.querySelector('[data-list]').addEventListener('change', onToggle);
}

function filtered() {
  const text = normalizeArabic(f.q);
  return rows.filter((p) => {
    const i = info(p);
    if (f.cat && String(p.category_id) !== f.cat) return false;
    if (f.status === 'active' && !p.active) return false;
    if (f.status === 'inactive' && p.active) return false;
    if (f.status === 'low' && !i.low) return false;
    if (f.status === 'noimage' && i.img) return false;
    if (!text) return true;
    return normalizeArabic(`${p.name_ar} ${p.name_en || ''} ${p.slug}`).includes(text);
  });
}

function paint() {
  const list = root.querySelector('[data-list]');
  const all = filtered();
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  f.page = Math.min(f.page, pages);
  if (!all.length) { showEmpty(list, { title: t('admin.products.emptyTitle'), text: t('admin.products.emptyText'), actionLabel: t('admin.products.add'), actionHref: '/admin/product-edit.html' }); return; }
  list.removeAttribute('aria-busy');
  list.innerHTML = html`
    <p class="hint" style="margin:0 0 8px">${t('admin.products.count', { count: all.length })}</p>
    <div class="data-table-wrap"><table class="data-table wide">
      <thead><tr><th></th><th>${t('admin.products.name')}</th><th>${t('admin.products.category')}</th><th class="num">${t('admin.products.fromPrice')}</th><th class="num">${t('admin.products.stock')}</th><th>${t('admin.common.active')}</th><th>${t('admin.products.bestseller')}</th><th class="actions">${t('admin.common.actions')}</th></tr></thead>
      <tbody>${all.slice((f.page - 1) * PAGE, f.page * PAGE).map((p) => { const i = info(p); return html`
        <tr class="${p.active ? '' : 'is-muted'}">
          <td>${i.img ? html`<img class="thumb" src="${imageUrl(i.img)}" alt="" width="44" height="44" loading="lazy">` : html`<span class="thumb" style="display:inline-flex;width:44px;height:44px;align-items:center;justify-content:center;background:var(--cream-2);border-radius:8px">${raw(placeholderSvg(null, p.id).replace('<svg', '<svg width="28"'))}</span>`}</td>
          <td><a class="cell-main link-inline" href="/admin/product-edit.html?id=${p.id}">${p.name_ar}</a><div class="cell-sub">${ltr(p.slug)} · ${t('admin.products.variantsCount', { n: p.product_variants.length })}</div></td>
          <td>${cats.find((c) => c.id === p.category_id)?.name_ar ?? ''}</td>
          <td class="num">${i.from === null ? html`<span class="badge danger">${t('admin.products.noVariant')}</span>` : formatPrice(i.from)}</td>
          <td class="num"><span class="${i.stock === 0 ? 'badge danger' : i.low ? 'badge warning' : ''}">${formatNumber(i.stock)}</span></td>
          <td><input type="checkbox" class="switch" role="switch" data-active="${p.id}" aria-label="${t('admin.common.active')}: ${p.name_ar}" ${raw(p.active ? 'checked' : '')}></td>
          <td><input type="checkbox" class="switch" role="switch" data-best="${p.id}" aria-label="${t('admin.products.bestseller')}: ${p.name_ar}" ${raw(p.is_bestseller ? 'checked' : '')}></td>
          <td class="actions"><a class="btn ghost sm" href="/admin/product-edit.html?id=${p.id}">${t('common.edit')}</a>
            <button type="button" class="btn ghost sm" data-delete="${p.id}">${t('common.delete')}</button></td></tr>`; })}</tbody>
    </table></div>
    <div class="pagination"><span>${t('admin.orders.page', { page: f.page, pages })}</span><span class="pages">
      <button type="button" class="btn ghost sm" data-goto="${f.page - 1}" ${raw(f.page <= 1 ? 'disabled' : '')}>${t('admin.orders.prev')}</button>
      <button type="button" class="btn ghost sm" data-goto="${f.page + 1}" ${raw(f.page >= pages ? 'disabled' : '')}>${t('admin.orders.next')}</button></span></div>`.toString();
}

async function onToggle(e) {
  const a = e.target.closest('[data-active]');
  const b = e.target.closest('[data-best]');
  const el = a || b;
  if (!el) return;
  const p = rows.find((x) => String(x.id) === (a ? a.dataset.active : b.dataset.best));
  const patch = a ? { active: el.checked } : { is_bestseller: el.checked };
  if (a && el.checked && !info(p).act.length) {
    el.checked = false;
    toast(t('admin.products.needVariant'), { type: 'error', duration: 6000 });
    return;
  }
  const { error } = await ctx.sb.from('products').update(patch).eq('id', p.id);
  if (error) { el.checked = !el.checked; toast(errorMessage(toAppError(error)), { type: 'error' }); return; }
  Object.assign(p, patch);
  toast(t('admin.common.saved'), { type: 'success' });
  paint();
}

async function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.goto && !b.disabled) { f.page = Number(b.dataset.goto); paint(); window.scrollTo({ top: 0 }); return; }
  if (!b.dataset.delete) return;
  const p = rows.find((x) => String(x.id) === b.dataset.delete);
  try {
    const { count, error } = await ctx.sb.from('order_items').select('id', { count: 'exact', head: true }).eq('product_id', p.id);
    if (error) throw toAppError(error);
    if (count > 0) { toast(t('admin.products.usedInOrders', { n: count }), { type: 'error', duration: 8000 }); return; }
    if (!(await confirmDelete(t('admin.products.deleteConfirm', { name: p.name_ar })))) return;
    // images: remove the files too (rows cascade with the product)
    const paths = p.product_images.map((i) => i.path);
    const { error: de } = await ctx.sb.from('products').delete().eq('id', p.id);
    if (de) throw toAppError(de);
    if (paths.length) await ctx.sb.storage.from('product-images').remove(paths).catch(() => {});
    toast(t('admin.common.deleted'), { type: 'success' });
    load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

load();
