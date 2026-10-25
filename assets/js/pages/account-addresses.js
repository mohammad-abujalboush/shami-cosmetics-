// /account/addresses.html — saved addresses: add, edit, delete, one default (the DB trigger keeps a single default).
import '../layout.js';
import { t, html, raw, ltr, formatPhone, normalizePhone, normalizeName, isValidName, showLoading, showEmpty, showError,
         toast, errorMessage, toAppError, confirmDialog } from '../utils.js';
import { requireClient, run } from '../supabase.js';
import { requireSession, guardedSubmit, setFieldError, fieldHtml } from '../account.js';

const root = document.querySelector('[data-slot="account"]');
document.title = t('addresses.meta');
const session = await requireSession();
const sb = requireClient();
let governorates = [];
let addresses = [];
let editing = null;   // address id, 'new', or null

root.innerHTML = html`
  <div class="acc-head">
    <h1>${t('addresses.title')}</h1>
    <div class="acc-links">
      <button type="button" class="btn primary sm" data-add>${t('addresses.add')}</button>
      <a class="btn ghost sm" href="/account/#profile">${t('addresses.back')}</a>
    </div>
  </div>
  <div data-form-slot></div>
  <div data-list></div>`.toString();
const listEl = root.querySelector('[data-list]');
const formSlot = root.querySelector('[data-form-slot]');

async function load() {
  showLoading(listEl);
  try {
    [governorates, addresses] = await Promise.all([
      run(sb.from('governorates').select('id, name_ar').eq('active', true).order('sort').order('id')),
      run(sb.from('addresses').select('id, label, full_name, phone, governorate_id, area, details, is_default')
        .order('is_default', { ascending: false }).order('created_at')),
    ]);
    paintList();
  } catch (err) {
    showError(listEl, { error: err, onRetry: load });
  }
}

const govName = (id) => governorates.find((g) => g.id === id)?.name_ar ?? '';

function paintList() {
  if (!addresses.length) {
    showEmpty(listEl, { title: t('addresses.emptyTitle'), text: t('addresses.emptyText') });
    return;
  }
  listEl.removeAttribute('aria-busy');
  listEl.innerHTML = html`<div class="addr-grid">${addresses.map((a) => html`
    <article class="co-card addr-card">
      <h3>${a.label || a.area}${a.is_default ? html`<span class="badge gold">${t('addresses.isDefault')}</span>` : ''}</h3>
      <p>${a.full_name}<br>${ltr(formatPhone(a.phone))}</p>
      <p>${[govName(a.governorate_id), a.area, a.details].filter(Boolean).join('، ')}</p>
      <div class="addr-actions">
        <button type="button" class="btn ghost sm" data-edit="${a.id}">${t('addresses.edit')}</button>
        ${!a.is_default ? html`<button type="button" class="btn ghost sm" data-default="${a.id}">${t('addresses.setDefault')}</button>` : ''}
        <button type="button" class="btn ghost sm" data-remove="${a.id}">${t('addresses.remove')}</button>
      </div>
    </article>`)}</div>`.toString();
}

/* ---------- Form ---------- */

function openForm(id) {
  editing = id;
  const a = id === 'new' ? null : addresses.find((x) => x.id === id);
  formSlot.innerHTML = html`
    <form class="co-card form" novalidate style="margin-bottom:22px;max-width:640px">
      <h2>${a ? t('addresses.formEdit') : t('addresses.formAdd')}</h2>
      ${fieldHtml({ id: 'a-label', name: 'label', label: t('addresses.label'), maxlength: 40, placeholder: t('addresses.labelPlaceholder'), value: a?.label || '', optional: true })}
      ${fieldHtml({ id: 'a-name', name: 'name', label: t('checkout.name'), autocomplete: 'name', maxlength: 60, value: a?.full_name || '' })}
      ${fieldHtml({ id: 'a-phone', name: 'phone', label: t('checkout.phone'), type: 'tel', dir: 'ltr', autocomplete: 'tel', inputmode: 'tel', maxlength: 20, placeholder: '07XXXXXXXX', value: a ? `0${a.phone.slice(3)}` : '', hint: t('checkout.phoneHint') })}
      <div class="form-row">
        <div class="field">
          <label class="label" for="a-gov">${t('checkout.governorate')}</label>
          <select class="select" id="a-gov" name="gov" aria-describedby="a-gov-err">
            <option value="">${t('checkout.governorateChoose')}</option>
            ${governorates.map((g) => html`<option value="${g.id}" ${raw(a?.governorate_id === g.id ? 'selected' : '')}>${g.name_ar}</option>`)}
          </select>
          <p class="field-error" id="a-gov-err" role="alert"></p>
        </div>
        ${fieldHtml({ id: 'a-area', name: 'area', label: t('checkout.area'), maxlength: 80, placeholder: t('checkout.areaPlaceholder'), value: a?.area || '' })}
      </div>
      <div class="field">
        <label class="label" for="a-details">${t('checkout.address')}</label>
        <textarea class="textarea" id="a-details" name="details" rows="3" maxlength="300" placeholder="${t('checkout.addressPlaceholder')}" aria-describedby="a-details-err">${a?.details || ''}</textarea>
        <p class="field-error" id="a-details-err" role="alert"></p>
      </div>
      <label class="check"><input type="checkbox" name="is_default" ${raw(a?.is_default ? 'checked' : '')}> <span>${t('addresses.makeDefault')}</span></label>
      <p class="form-error" data-form-error role="alert"></p>
      <div class="action-row">
        <button type="submit" class="btn primary">${t('addresses.save')}</button>
        <button type="button" class="btn ghost" data-cancel-form>${t('common.cancel')}</button>
      </div>
    </form>`.toString();
  const form = formSlot.querySelector('form');
  form.querySelector('[data-cancel-form]').addEventListener('click', closeForm);
  guardedSubmit(form, () => save(form));
  form.elements.label.focus();
  form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeForm() { editing = null; formSlot.innerHTML = ''; }

async function save(form) {
  const f = form.elements;
  const name = normalizeName(f.name.value);
  const phone = normalizePhone(f.phone.value);
  const area = f.area.value.trim();
  const details = f.details.value.trim();
  const gov = Number(f.gov.value);
  const checks = [
    [f.name, !name ? t('validation.required') : isValidName(name) ? '' : t('checkout.nameInvalid')],
    [f.phone, !f.phone.value.trim() ? t('validation.required') : phone ? '' : t('validation.phoneInvalid')],
    [f.gov, gov > 0 ? '' : t('checkout.governorateRequired')],
    [f.area, !area ? t('validation.required') : area.length < 2 || area.length > 80 ? t('checkout.areaInvalid') : ''],
    [f.details, !details ? t('validation.required') : details.length < 3 || details.length > 300 ? t('checkout.addressInvalid') : ''],
  ];
  let first = null;
  for (const [input, message] of checks) { setFieldError(input, message); if (message && !first) first = input; }
  if (first) { first.focus(); return; }

  const row = {
    label: f.label.value.trim() || null, full_name: name, phone, governorate_id: gov, area, details,
    is_default: f.is_default.checked,
  };
  const query = editing === 'new'
    ? sb.from('addresses').insert({ ...row, user_id: session.user.id })
    : sb.from('addresses').update(row).eq('id', editing);
  const { error } = await query;
  if (error) throw toAppError(error);
  toast(t('addresses.saved'), { type: 'success' });
  closeForm();
  await load();
}

/* ---------- Actions ---------- */

root.querySelector('[data-add]').addEventListener('click', () => openForm('new'));
listEl.addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  const def = e.target.closest('[data-default]');
  const rem = e.target.closest('[data-remove]');
  try {
    if (edit) { openForm(edit.dataset.edit); return; }
    if (def) {
      const { error } = await sb.from('addresses').update({ is_default: true }).eq('id', def.dataset.default);
      if (error) throw toAppError(error);
      toast(t('addresses.defaultSet'), { type: 'success' });
      await load();
    }
    if (rem) {
      const ok = await confirmDialog({ message: t('addresses.removeConfirm'), confirmLabel: t('addresses.removeConfirmYes'), danger: true });
      if (!ok) return;
      const target = addresses.find((a) => a.id === rem.dataset.remove);
      const { error } = await sb.from('addresses').delete().eq('id', rem.dataset.remove);
      if (error) throw toAppError(error);
      // Deleting the default leaves no default: promote the oldest remaining one.
      const rest = addresses.filter((a) => a.id !== rem.dataset.remove);
      if (target?.is_default && rest.length) await sb.from('addresses').update({ is_default: true }).eq('id', rest[0].id);
      if (editing === rem.dataset.remove) closeForm();
      toast(t('addresses.removed'));
      await load();
    }
  } catch (err) {
    toast(errorMessage(err), { type: 'error' });
  }
});

load();
