// /admin/offers.html (owner) — bundle offers: "any N units of a category for a fixed price".
// One active offer per category at any moment (database exclusion constraint; checked here first for a clear message).
// The preview is an illustration only: the real price comes from calculate_cart in Postgres
// (eligible units sorted by price descending, grouped into sets of N, each full set costs bundle_price).
import { initAdmin, formDialog, ammanLocalToISO, isoToAmmanLocal } from '../admin.js';
import { t, html, raw, formatPrice, formatNumber, formatDate, showLoading, showError, showEmpty, toast, errorMessage, toAppError } from '../utils.js';
import { run } from '../supabase.js';
import { field, input, numberInput, select, textarea, switchRow, setErr, runChecks, required, parseNum, parseIntStrict, decimals, confirmDelete } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'offers', ownerOnly: true });
document.title = t('admin.offers.meta');
const root = document.querySelector('[data-slot="offers"]');
let rows = [];
let cats = [];
let avgPrice = new Map();   // category_id → average active variant price (sample for the preview)

async function load() {
  showLoading(root);
  try {
    const [offers, categories, variants] = await Promise.all([
      run(ctx.sb.from('offers').select('*').order('starts_at', { ascending: false })),
      run(ctx.sb.from('categories').select('id, name_ar').order('sort')),
      run(ctx.sb.from('product_variants').select('price, active, products(category_id, active)').eq('active', true)),
    ]);
    rows = offers; cats = categories;
    const acc = new Map();
    variants.filter((v) => v.products?.active).forEach((v) => { const a = acc.get(v.products.category_id) || [0, 0]; a[0] += Number(v.price); a[1] += 1; acc.set(v.products.category_id, a); });
    avgPrice = new Map([...acc].map(([k, [s, n]]) => [k, Math.round((s / n) * 1000) / 1000]));
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

const catName = (id) => cats.find((c) => c.id === id)?.name_ar ?? '';
function state(o) {
  const now = Date.now();
  if (!o.active) return ['inactive', 'danger'];
  if (new Date(o.starts_at) > now) return ['scheduled', 'info'];
  if (new Date(o.ends_at) <= now) return ['ended', 'warning'];
  return ['running', 'success'];
}

function paint() {
  if (!rows.length) { showEmpty(root, { title: t('admin.offers.emptyTitle'), text: t('admin.offers.emptyText') }); return; }
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="data-table-wrap"><table class="data-table wide">
      <thead><tr><th>${t('admin.offers.name')}</th><th>${t('admin.offers.category')}</th><th>${t('admin.offers.deal')}</th><th>${t('admin.offers.period')}</th><th>${t('admin.common.status')}</th><th class="actions">${t('admin.common.actions')}</th></tr></thead>
      <tbody>${rows.map((o) => { const [st, tone] = state(o); return html`
        <tr class="${o.active ? '' : 'is-muted'}">
          <td class="cell-main">${o.name_ar}${o.show_countdown ? '' : html`<div class="cell-sub">${t('admin.offers.noCountdown')}</div>`}</td>
          <td>${catName(o.category_id)}</td>
          <td>${t('admin.offers.dealText', { n: o.quantity, price: formatPrice(o.bundle_price) })}</td>
          <td class="cell-sub">${formatDate(o.starts_at)}<br>${formatDate(o.ends_at)}</td>
          <td><span class="badge ${tone}">${t(`admin.offers.st.${st}`)}</span></td>
          <td class="actions"><button type="button" class="btn ghost sm" data-edit="${o.id}">${t('common.edit')}</button>
            <button type="button" class="btn ghost sm" data-flip="${o.id}">${t(o.active ? 'admin.common.deactivate' : 'admin.common.activate')}</button>
            ${new Date(o.starts_at) > Date.now() ? html`<button type="button" class="btn ghost sm" data-delete="${o.id}">${t('common.delete')}</button>` : ''}</td></tr>`; })}</tbody>
    </table></div>`.toString();
}

function body(o) {
  const defStart = o ? isoToAmmanLocal(o.starts_at) : isoToAmmanLocal(new Date().toISOString());
  return html`
    ${field('o-name', t('admin.offers.name'), input({ id: 'o-name', name: 'name_ar', value: o?.name_ar || '', maxlength: 100 }))}
    ${field('o-desc', t('admin.offers.description'), textarea({ id: 'o-desc', name: 'description_ar', value: o?.description_ar || '', rows: 2, maxlength: 300 }), { optional: true })}
    <div class="form-grid">
      ${field('o-cat', t('admin.offers.category'), select({ id: 'o-cat', name: 'category_id', value: o?.category_id ?? '', options: [{ value: '', label: t('admin.offers.chooseCategory') }, ...cats.map((c) => ({ value: c.id, label: c.name_ar }))] }))}
      ${field('o-qty', t('admin.offers.quantity'), numberInput({ id: 'o-qty', name: 'quantity', value: o?.quantity ?? '' }), { hint: t('admin.offers.quantityHint') })}
      ${field('o-price', t('admin.offers.bundlePrice'), numberInput({ id: 'o-price', name: 'bundle_price', value: o ? Number(o.bundle_price) : '' }))}
      <span></span>
      ${field('o-start', t('admin.offers.startsAt'), input({ id: 'o-start', name: 'starts_at', type: 'datetime-local', dir: 'ltr', value: defStart }))}
      ${field('o-end', t('admin.offers.endsAt'), input({ id: 'o-end', name: 'ends_at', type: 'datetime-local', dir: 'ltr', value: isoToAmmanLocal(o?.ends_at) }))}
    </div>
    ${switchRow({ id: 'o-countdown', name: 'show_countdown', label: t('admin.offers.showCountdown'), checked: o ? o.show_countdown : true, hint: t('admin.offers.countdownHint') })}
    ${switchRow({ id: 'o-active', name: 'active', label: t('admin.common.active'), checked: o ? o.active : true })}
    <section class="card soft" style="padding:14px 16px" aria-live="polite">
      <h3 style="font-size:15px;margin-bottom:8px">${t('admin.offers.previewTitle')}</h3>
      <div class="form-grid">
        ${field('o-p-units', t('admin.offers.previewUnits'), numberInput({ id: 'o-p-units', name: 'p_units', value: '' }))}
        ${field('o-p-price', t('admin.offers.previewPrice'), numberInput({ id: 'o-p-price', name: 'p_price', value: '' }))}
      </div>
      <div data-preview class="hint" style="margin-top:6px"></div>
    </section>`;
}

function readForm(form) {
  const v = (n) => form.elements[n].value;
  return {
    name: v('name_ar').trim(), category: Number(v('category_id')) || null, qty: parseIntStrict(v('quantity')), price: parseNum(v('bundle_price')),
    start: v('starts_at') ? ammanLocalToISO(v('starts_at')) : null, end: v('ends_at') ? ammanLocalToISO(v('ends_at')) : null,
  };
}

function preview(form) {
  const o = readForm(form);
  const box = form.querySelector('[data-preview]');
  const unitsEl = form.elements.p_units; const priceEl = form.elements.p_price;
  if (!priceEl.dataset.touched && o.category && avgPrice.has(o.category)) priceEl.value = String(avgPrice.get(o.category));
  if (!unitsEl.dataset.touched && o.qty >= 2) unitsEl.value = String(o.qty * 2 + 1);
  const units = parseIntStrict(unitsEl.value); const price = parseNum(priceEl.value);
  if (!(o.qty >= 2) || !(o.price > 0) || !(units >= 1) || !(price > 0)) { box.textContent = t('admin.offers.previewHint'); return; }
  const sets = Math.floor(units / o.qty);
  const full = units * price;
  const withOffer = sets * o.price + (units - sets * o.qty) * price;
  const saving = full - withOffer;
  box.innerHTML = html`
    <div>${t('admin.offers.previewSets', { sets, n: o.qty, rest: units - sets * o.qty })}</div>
    <div>${t('admin.offers.previewFull', { amount: formatPrice(full) })} ← ${t('admin.offers.previewWith', { amount: formatPrice(withOffer) })}</div>
    <strong style="color:${saving > 0 ? 'var(--success)' : 'var(--danger)'}">${saving > 0 ? t('admin.offers.previewSaving', { amount: formatPrice(saving) }) : t('admin.offers.previewNoSaving')}</strong>`.toString();
}

async function overlap(o, selfId) {
  if (!o.category || !o.start || !o.end) return null;
  const others = rows.filter((x) => x.active && x.category_id === o.category && x.id !== selfId
    && new Date(x.starts_at) < new Date(o.end) && new Date(x.ends_at) > new Date(o.start));
  return others[0] || null;
}

async function edit(o) {
  let selfId = o?.id;
  const data = await formDialog({
    title: t(o ? 'admin.offers.editTitle' : 'admin.offers.addTitle'), body: body(o), large: true, confirmLabel: t('common.save'),
    onOpen: (form) => {
      ['p_units', 'p_price'].forEach((n) => form.elements[n].addEventListener('input', (e) => { e.target.dataset.touched = '1'; preview(form); }));
      ['category_id', 'quantity', 'bundle_price'].forEach((n) => form.elements[n].addEventListener('input', () => preview(form)));
      preview(form);
    },
    validate: (form) => {
      const p = readForm(form);
      const active = form.elements.active.checked;
      const conflict = active ? rows.find((x) => x.active && x.category_id === p.category && x.id !== selfId && p.start && p.end
        && new Date(x.starts_at) < new Date(p.end) && new Date(x.ends_at) > new Date(p.start)) : null;
      return runChecks(form, [
        ['o-name', required(p.name)],
        ['o-cat', p.category ? '' : t('admin.offers.chooseCategoryError')],
        ['o-qty', p.qty === null ? t('validation.required') : (Number.isNaN(p.qty) || p.qty < 2 ? t('admin.offers.quantityInvalid') : '')],
        ['o-price', p.price === null ? t('validation.required') : (Number.isNaN(p.price) || p.price <= 0 || decimals(p.price) > 3 ? t('admin.common.invalidAmount') : '')],
        ['o-start', p.start ? '' : t('validation.required')],
        ['o-end', !p.end ? t('validation.required') : (p.start && new Date(p.end) <= new Date(p.start) ? t('errors.INVALID_DATE_RANGE') : (conflict ? t('admin.offers.overlap', { name: conflict.name_ar }) : ''))],
      ]);
    },
  });
  if (!data) return;
  const row = {
    name_ar: String(data.get('name_ar')).trim(), description_ar: String(data.get('description_ar') || '').trim() || null,
    category_id: Number(data.get('category_id')), quantity: parseIntStrict(data.get('quantity')), bundle_price: parseNum(data.get('bundle_price')),
    starts_at: ammanLocalToISO(data.get('starts_at')), ends_at: ammanLocalToISO(data.get('ends_at')),
    show_countdown: data.get('show_countdown') === 'on', active: data.get('active') === 'on',
  };
  try {
    const { error } = o ? await ctx.sb.from('offers').update(row).eq('id', o.id) : await ctx.sb.from('offers').insert(row);
    if (error) throw toAppError(error);     // 23P01 → OFFER_OVERLAP if another tab created a clash meanwhile
    toast(t('admin.common.saved'), { type: 'success' });
    load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

root.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const o = rows.find((x) => String(x.id) === (b.dataset.edit || b.dataset.flip || b.dataset.delete));
  if (b.dataset.edit) edit(o);
  if (b.dataset.flip) {
    const { error } = await ctx.sb.from('offers').update({ active: !o.active }).eq('id', o.id);
    if (error) toast(errorMessage(toAppError(error)), { type: 'error', duration: 7000 }); else { toast(t('admin.common.saved'), { type: 'success' }); load(); }
  }
  if (b.dataset.delete) {
    if (!(await confirmDelete(t('admin.offers.deleteConfirm', { name: o.name_ar })))) return;
    const { error } = await ctx.sb.from('offers').delete().eq('id', o.id);
    if (error) toast(errorMessage(toAppError(error)), { type: 'error' }); else { toast(t('admin.common.deleted'), { type: 'success' }); load(); }
  }
});
document.querySelector('[data-add]').addEventListener('click', () => edit(null));
load();
