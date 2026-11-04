// /admin/coupons.html (owner) — coupons with usage stats (coupon_stats RPC).
// Applied in Postgres after bundle discounts and never below zero; here we only manage the rows.
// A coupon that was ever used is deactivated, not deleted.
import { initAdmin, formDialog, ammanLocalToISO, isoToAmmanLocal } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatNumber, formatDate, toWesternDigits, showLoading, showError, showEmpty, toast, errorMessage, toAppError } from '../utils.js';
import { run, rpc } from '../supabase.js';
import { field, input, numberInput, select, switchRow, runChecks, parseNum, parseIntStrict, decimals, confirmDelete } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'coupons', ownerOnly: true });
document.title = t('admin.coupons.meta');
const root = document.querySelector('[data-slot="coupons"]');
let rows = [];
let stats = new Map();

async function load() {
  showLoading(root);
  try {
    const [coupons, st] = await Promise.all([run(ctx.sb.from('coupons').select('*').order('created_at', { ascending: false })), rpc('coupon_stats')]);
    rows = coupons;
    stats = new Map(st.map((s) => [s.coupon_id, s]));
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

function status(c) {
  const now = Date.now();
  if (!c.active) return ['inactive', 'danger'];
  if (c.starts_at && new Date(c.starts_at) > now) return ['scheduled', 'info'];
  if (c.ends_at && new Date(c.ends_at) <= now) return ['expired', 'danger'];
  if (c.max_uses && c.used_count >= c.max_uses) return ['exhausted', 'warning'];
  return ['running', 'success'];
}

function paint() {
  if (!rows.length) { showEmpty(root, { title: t('admin.coupons.emptyTitle'), text: t('admin.coupons.emptyText') }); return; }
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="data-table-wrap"><table class="data-table wide">
      <thead><tr><th>${t('admin.coupons.code')}</th><th>${t('admin.coupons.discount')}</th><th>${t('admin.coupons.conditions')}</th><th>${t('admin.coupons.period')}</th>
        <th class="num">${t('admin.coupons.usage')}</th><th class="num">${t('admin.coupons.given')}</th><th>${t('admin.common.status')}</th><th class="actions">${t('admin.common.actions')}</th></tr></thead>
      <tbody>${rows.map((c) => {
        const [st, tone] = status(c);
        const s = stats.get(c.id) || {};
        return html`<tr class="${c.active ? '' : 'is-muted'}">
          <td class="cell-main">${ltr(c.code)}</td>
          <td>${c.type === 'percent' ? html`${formatNumber(c.value)}%${c.max_discount ? html`<div class="cell-sub">${t('admin.coupons.maxShort', { amount: formatPrice(c.max_discount) })}</div>` : ''}` : formatPrice(c.value)}</td>
          <td class="cell-sub">${Number(c.min_order) > 0 ? html`<div>${t('admin.coupons.minShort', { amount: formatPrice(c.min_order) })}</div>` : ''}
            ${c.max_per_phone ? html`<div>${t('admin.coupons.perPhoneShort', { n: c.max_per_phone })}</div>` : ''}
            ${c.combinable_with_offers ? '' : html`<div>${t('admin.coupons.noCombo')}</div>`}</td>
          <td class="cell-sub">${c.starts_at ? formatDate(c.starts_at) : '—'}<br>${c.ends_at ? formatDate(c.ends_at) : '—'}</td>
          <td class="num">${c.used_count}${c.max_uses ? ` / ${c.max_uses}` : ''}<div class="cell-sub">${t('admin.coupons.orders', { n: s.orders ?? 0 })}</div></td>
          <td class="num">${formatPrice(s.discount_total ?? 0)}${s.last_used ? html`<div class="cell-sub">${formatDate(s.last_used, { time: false })}</div>` : ''}</td>
          <td><span class="badge ${tone}">${t(`admin.coupons.st.${st}`)}</span></td>
          <td class="actions"><button type="button" class="btn ghost sm" data-edit="${c.id}">${t('common.edit')}</button>
            ${c.used_count === 0 && !(s.orders > 0) ? html`<button type="button" class="btn ghost sm" data-delete="${c.id}">${t('common.delete')}</button>`
              : html`<button type="button" class="btn ghost sm" data-flip="${c.id}">${t(c.active ? 'admin.common.deactivate' : 'admin.common.activate')}</button>`}</td></tr>`;
      })}</tbody></table></div>`.toString();
}

function body(c) {
  const used = c && c.used_count > 0;
  return html`
    <div class="form-grid">
      ${field('k-code', t('admin.coupons.code'), input({ id: 'k-code', name: 'code', value: c?.code || '', dir: 'ltr', maxlength: 32, hint: t('admin.coupons.codeHint'), extra: used ? 'readonly' : '' }), { hint: t('admin.coupons.codeHint') })}
      ${field('k-type', t('admin.coupons.type'), select({ id: 'k-type', name: 'type', value: c?.type || 'percent', options: [{ value: 'percent', label: t('admin.coupons.percent') }, { value: 'fixed', label: t('admin.coupons.fixed') }] }))}
      ${field('k-value', t('admin.coupons.value'), numberInput({ id: 'k-value', name: 'value', value: c ? Number(c.value) : '' }))}
      ${field('k-max', t('admin.coupons.maxDiscount'), numberInput({ id: 'k-max', name: 'max_discount', value: c?.max_discount ? Number(c.max_discount) : '' }), { optional: true, hint: t('admin.coupons.maxDiscountHint'), cls: 'js-percent-only' })}
      ${field('k-min', t('admin.coupons.minOrder'), numberInput({ id: 'k-min', name: 'min_order', value: c ? Number(c.min_order) : 0 }))}
      ${field('k-uses', t('admin.coupons.maxUses'), numberInput({ id: 'k-uses', name: 'max_uses', value: c?.max_uses ?? '' }), { optional: true, hint: t('admin.coupons.unlimited') })}
      ${field('k-phone', t('admin.coupons.maxPerPhone'), numberInput({ id: 'k-phone', name: 'max_per_phone', value: c?.max_per_phone ?? '' }), { optional: true, hint: t('admin.coupons.unlimited') })}
      <span></span>
      ${field('k-start', t('admin.coupons.startsAt'), input({ id: 'k-start', name: 'starts_at', type: 'datetime-local', value: isoToAmmanLocal(c?.starts_at), dir: 'ltr' }), { optional: true })}
      ${field('k-end', t('admin.coupons.endsAt'), input({ id: 'k-end', name: 'ends_at', type: 'datetime-local', value: isoToAmmanLocal(c?.ends_at), dir: 'ltr' }), { optional: true })}
    </div>
    ${switchRow({ id: 'k-combo', name: 'combinable', label: t('admin.coupons.combinable'), checked: c ? c.combinable_with_offers : true, hint: t('admin.coupons.combinableHint') })}
    ${switchRow({ id: 'k-active', name: 'active', label: t('admin.common.active'), checked: c ? c.active : true })}`;
}

function parseForm(form) {
  const v = (n) => form.elements[n].value;
  const code = toWesternDigits(v('code')).trim().toUpperCase();
  const type = v('type');
  const value = parseNum(v('value'));
  const max = parseNum(v('max_discount'));
  const min = parseNum(v('min_order'));
  const uses = parseIntStrict(v('max_uses'));
  const phone = parseIntStrict(v('max_per_phone'));
  const startsISO = v('starts_at') ? ammanLocalToISO(v('starts_at')) : null;
  const endsISO = v('ends_at') ? ammanLocalToISO(v('ends_at')) : null;
  return { code, type, value, max, min, uses, phone, startsISO, endsISO };
}

function validate(form, existing) {
  const p = parseForm(form);
  const money = (n, allowNull = false) => (n === null ? (allowNull ? '' : t('validation.required')) : (Number.isNaN(n) || n < 0 || decimals(n) > 3 ? t('admin.common.invalidAmount') : ''));
  const intOpt = (n) => (n === null ? '' : (Number.isNaN(n) || n < 1 ? t('admin.common.invalidWhole') : ''));
  return runChecks(form, [
    ['k-code', !p.code ? t('validation.required') : /^[A-Z0-9_-]{3,32}$/.test(p.code) ? '' : t('admin.coupons.codeInvalid')],
    ['k-value', p.value === null ? t('validation.required') : (Number.isNaN(p.value) || p.value <= 0 || decimals(p.value) > 3 ? t('admin.common.invalidAmount') : (p.type === 'percent' && p.value > 100 ? t('admin.coupons.percentMax') : ''))],
    ['k-max', p.type === 'percent' ? (money(p.max, true) || (p.max === 0 ? t('admin.common.invalidAmount') : '')) : ''],
    ['k-min', money(p.min)],
    ['k-uses', intOpt(p.uses) || (existing && p.uses !== null && p.uses < existing.used_count ? t('admin.coupons.usesBelowUsed', { n: existing.used_count }) : '')],
    ['k-phone', intOpt(p.phone)],
    ['k-end', p.startsISO && p.endsISO && new Date(p.endsISO) <= new Date(p.startsISO) ? t('errors.INVALID_DATE_RANGE') : ''],
  ]);
}

async function edit(c) {
  const data = await formDialog({
    title: t(c ? 'admin.coupons.editTitle' : 'admin.coupons.addTitle'), body: body(c), large: true, confirmLabel: t('common.save'),
    validate: (form) => validate(form, c),
    onOpen: (form) => {
      const sync = () => { form.querySelector('.js-percent-only').style.display = form.elements.type.value === 'percent' ? '' : 'none'; };
      form.elements.type.addEventListener('change', sync); sync();
    },
  });
  if (!data) return;
  const f = { elements: Object.fromEntries([...data.keys()].map((k) => [k, { value: data.get(k) }])) };
  const p = parseForm(f);
  const row = {
    code: p.code, type: p.type, value: p.value, max_discount: p.type === 'percent' ? p.max || null : null, min_order: p.min,
    max_uses: p.uses, max_per_phone: p.phone, starts_at: p.startsISO, ends_at: p.endsISO,
    combinable_with_offers: data.get('combinable') === 'on', active: data.get('active') === 'on',
  };
  try {
    const { error } = c ? await ctx.sb.from('coupons').update(row).eq('id', c.id) : await ctx.sb.from('coupons').insert(row);
    if (error) throw toAppError(error);
    toast(t('admin.common.saved'), { type: 'success' });
    load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

root.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const c = rows.find((x) => String(x.id) === (b.dataset.edit || b.dataset.delete || b.dataset.flip));
  if (b.dataset.edit) edit(c);
  if (b.dataset.flip) {
    const { error } = await ctx.sb.from('coupons').update({ active: !c.active }).eq('id', c.id);
    if (error) toast(errorMessage(toAppError(error)), { type: 'error' }); else { toast(t('admin.common.saved'), { type: 'success' }); load(); }
  }
  if (b.dataset.delete) {
    if (!(await confirmDelete(t('admin.coupons.deleteConfirm', { code: c.code })))) return;
    const { error } = await ctx.sb.from('coupons').delete().eq('id', c.id);
    if (error) toast(errorMessage(toAppError(error)), { type: 'error' }); else { toast(t('admin.common.deleted'), { type: 'success' }); load(); }
  }
});
document.querySelector('[data-add]').addEventListener('click', () => edit(null));
load();
