// /admin/categories.html (owner) — add / edit / reorder / deactivate categories.
// System categories (soap, TWINS…) have a stable `key` used by the code: they can be renamed and
// reordered but never deleted. A category that still has products can only be deactivated.
import { initAdmin, formDialog } from '../admin.js';
import { t, html, raw, ltr, showLoading, showError, showEmpty, toast, errorMessage, toAppError } from '../utils.js';
import { run } from '../supabase.js';
import { field, input, textarea, switchRow, setErr, runChecks, required, confirmDelete, swap, arrow } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'categories', ownerOnly: true });
document.title = t('admin.categories.meta');
const root = document.querySelector('[data-slot="categories"]');
let rows = [];

async function load() {
  showLoading(root);
  try {
    const [cats, counts] = await Promise.all([
      run(ctx.sb.from('categories').select('*').order('sort').order('id')),
      run(ctx.sb.from('products').select('category_id')),
    ]);
    const n = new Map();
    counts.forEach((p) => n.set(p.category_id, (n.get(p.category_id) || 0) + 1));
    rows = cats.map((c) => ({ ...c, products: n.get(c.id) || 0 }));
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

function paint() {
  if (!rows.length) { showEmpty(root, { title: t('admin.categories.emptyTitle') }); return; }
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>${t('admin.categories.order')}</th><th>${t('admin.categories.name')}</th><th>${t('admin.categories.slug')}</th>
        <th class="num">${t('admin.categories.products')}</th><th>${t('admin.common.active')}</th><th class="actions">${t('admin.common.actions')}</th></tr></thead>
      <tbody>${rows.map((c, i) => html`
        <tr class="${c.active ? '' : 'is-muted'}">
          <td style="white-space:nowrap">
            <button type="button" class="icon-btn" data-up="${i}" aria-label="${t('admin.common.moveUp')}" ${raw(i === 0 ? 'disabled' : '')}>${raw(arrow('up'))}</button>
            <button type="button" class="icon-btn" data-down="${i}" aria-label="${t('admin.common.moveDown')}" ${raw(i === rows.length - 1 ? 'disabled' : '')}>${raw(arrow('down'))}</button>
          </td>
          <td><div class="cell-main">${c.name_ar}</div>${c.name_en ? html`<div class="cell-sub" dir="ltr">${c.name_en}</div>` : ''}</td>
          <td>${ltr(c.slug)}</td>
          <td class="num">${c.products}</td>
          <td><input type="checkbox" class="switch" role="switch" data-toggle="${c.id}" aria-label="${t('admin.common.active')}: ${c.name_ar}" ${raw(c.active ? 'checked' : '')}></td>
          <td class="actions">
            <button type="button" class="btn ghost sm" data-edit="${c.id}">${t('common.edit')}</button>
            ${c.key || c.products ? '' : html`<button type="button" class="btn ghost sm" data-delete="${c.id}">${t('common.delete')}</button>`}
          </td>
        </tr>`)}</tbody>
    </table></div>
    <p class="hint" style="margin-top:10px">${t('admin.categories.hint')}</p>`.toString();
}

function body(c) {
  return html`
    ${field('c-name', t('admin.categories.name'), input({ id: 'c-name', name: 'name_ar', value: c?.name_ar || '', maxlength: 80 }))}
    ${field('c-name-en', t('admin.categories.nameEn'), input({ id: 'c-name-en', name: 'name_en', value: c?.name_en || '', dir: 'ltr', maxlength: 80 }), { optional: true })}
    ${field('c-slug', t('admin.categories.slug'), input({ id: 'c-slug', name: 'slug', value: c?.slug || '', dir: 'ltr', maxlength: 60, hint: t('admin.categories.slugHint') }), { hint: t('admin.categories.slugHint'), optional: true })}
    ${field('c-desc', t('admin.categories.description'), textarea({ id: 'c-desc', name: 'description_ar', value: c?.description_ar || '', rows: 3, maxlength: 400 }), { optional: true })}
    ${switchRow({ id: 'c-active', name: 'active', label: t('admin.common.active'), checked: c ? c.active : true, hint: t('admin.categories.activeHint') })}`;
}

function validate(form) {
  const v = (n) => form.elements[n].value.trim();
  const slug = v('slug');
  return runChecks(form, [
    ['c-name', required(v('name_ar'))],
    ['c-slug', slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ? t('errors.INVALID_SLUG') : ''],
  ]);
}

async function edit(c) {
  const data = await formDialog({
    title: t(c ? 'admin.categories.editTitle' : 'admin.categories.addTitle'), body: body(c), confirmLabel: t('common.save'), validate,
  });
  if (!data) return;
  const row = {
    name_ar: String(data.get('name_ar')).trim(), name_en: String(data.get('name_en') || '').trim() || null,
    slug: String(data.get('slug') || '').trim(), description_ar: String(data.get('description_ar') || '').trim() || null,
    active: data.get('active') === 'on',
  };
  try {
    const q = c
      ? ctx.sb.from('categories').update(row).eq('id', c.id)
      : ctx.sb.from('categories').insert({ ...row, sort: (rows.at(-1)?.sort ?? 0) + 1 });
    const { error } = await q;
    if (error) throw toAppError(error);
    toast(t('admin.common.saved'), { type: 'success' });
    await load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

async function move(i, j) {
  const list = rows.slice();
  if (!swap(list, i, j)) return;
  try {
    // Re-number 1..n so ties can never occur
    await Promise.all(list.map((c, idx) => (c.sort === idx + 1 ? null : ctx.sb.from('categories').update({ sort: idx + 1 }).eq('id', c.id).then(({ error }) => { if (error) throw toAppError(error); }))));
    await load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error' });
    await load();
  }
}

root.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.up !== undefined) move(Number(b.dataset.up), Number(b.dataset.up) - 1);
  else if (b.dataset.down !== undefined) move(Number(b.dataset.down), Number(b.dataset.down) + 1);
  else if (b.dataset.edit) edit(rows.find((c) => String(c.id) === b.dataset.edit));
  else if (b.dataset.delete) {
    const c = rows.find((x) => String(x.id) === b.dataset.delete);
    if (!(await confirmDelete(t('admin.categories.deleteConfirm', { name: c.name_ar })))) return;
    const { error } = await ctx.sb.from('categories').delete().eq('id', c.id);
    if (error) { toast(errorMessage(toAppError(error)), { type: 'error' }); return; }
    toast(t('admin.common.deleted'), { type: 'success' });
    load();
  }
});
root.addEventListener('change', async (e) => {
  const sw = e.target.closest('[data-toggle]');
  if (!sw) return;
  const { error } = await ctx.sb.from('categories').update({ active: sw.checked }).eq('id', sw.dataset.toggle);
  if (error) { sw.checked = !sw.checked; toast(errorMessage(toAppError(error)), { type: 'error' }); return; }
  toast(t('admin.common.saved'), { type: 'success' });
  load();
});
document.querySelector('[data-add]').addEventListener('click', () => edit(null));

load();
