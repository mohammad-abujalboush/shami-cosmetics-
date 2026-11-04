// /admin/staff.html (owner) — promote an existing account by email (add_staff), change role,
// deactivate / reactivate (set_staff_active). Staff are never deleted so order history keeps their names.
import { initAdmin, formDialog } from '../admin.js';
import { t, html, ltr, formatDate, showLoading, showError, showEmpty, toast, errorMessage, confirmDialog } from '../utils.js';
import { rpc } from '../supabase.js';
import { field, input, select, runChecks, required } from '../admin-ui.js';
import { isEmail } from '../account.js';

const ctx = await initAdmin({ page: 'staff', ownerOnly: true });
document.title = t('admin.staff.meta');
const root = document.querySelector('[data-slot="staff"]');
let rows = [];

async function load() {
  showLoading(root);
  try {
    rows = await rpc('list_staff');
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

function paint() {
  if (!rows.length) { showEmpty(root, { title: t('admin.staff.emptyTitle') }); return; }
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>${t('admin.staff.name')}</th><th>${t('admin.staff.email')}</th><th>${t('admin.staff.role')}</th><th>${t('admin.common.status')}</th><th>${t('admin.staff.since')}</th><th class="actions">${t('admin.common.actions')}</th></tr></thead>
      <tbody>${rows.map((r) => html`
        <tr class="${r.active ? '' : 'is-muted'}">
          <td class="cell-main">${r.full_name || t('admin.staff.noName')}${r.user_id === ctx.userId ? html` <span class="badge gold">${t('admin.detail.byYou')}</span>` : ''}</td>
          <td>${ltr(r.email)}</td>
          <td><span class="badge ${r.role === 'owner' ? 'dark' : 'info'}">${t(r.role === 'owner' ? 'admin.roleOwner' : 'admin.roleStaff')}</span></td>
          <td><span class="badge ${r.active ? 'success' : 'danger'}">${t(r.active ? 'admin.common.active' : 'admin.common.inactive')}</span></td>
          <td class="cell-sub">${formatDate(r.created_at, { time: false })}</td>
          <td class="actions">${r.user_id === ctx.userId ? '' : html`
            ${r.active ? html`<button type="button" class="btn ghost sm" data-role="${r.user_id}">${t('admin.staff.changeRole')}</button>` : ''}
            <button type="button" class="btn ghost sm" data-active="${r.user_id}">${t(r.active ? 'admin.staff.deactivate' : 'admin.staff.reactivate')}</button>`}</td>
        </tr>`)}</tbody>
    </table></div>
    <p class="hint" style="margin-top:10px">${t('admin.staff.hint')}</p>`.toString();
}

const roleOptions = () => [{ value: 'staff', label: t('admin.roleStaff') }, { value: 'owner', label: t('admin.roleOwner') }];

async function add() {
  const data = await formDialog({
    title: t('admin.staff.addTitle'), confirmLabel: t('admin.staff.add'),
    body: html`<p class="hint" style="margin:0">${t('admin.staff.addHint')}</p>
      ${field('s-email', t('auth.emailLabel'), input({ id: 's-email', name: 'email', type: 'email', dir: 'ltr', inputmode: 'email' }))}
      ${field('s-role', t('admin.staff.role'), select({ id: 's-role', name: 'role', options: roleOptions(), value: 'staff' }))}`,
    validate: (form) => runChecks(form, [['s-email', !form.elements.email.value.trim() ? t('auth.emailRequired') : isEmail(form.elements.email.value) ? '' : t('validation.emailInvalid')]]),
  });
  if (!data) return;
  try {
    await rpc('add_staff', { email: String(data.get('email')).trim(), role: data.get('role') });
    toast(t('admin.staff.added'), { type: 'success' });
    load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

async function changeRole(r) {
  const data = await formDialog({
    title: t('admin.staff.changeRole'), confirmLabel: t('common.save'),
    body: html`<p style="margin:0"><strong>${r.full_name || r.email}</strong></p>${field('s-role', t('admin.staff.role'), select({ id: 's-role', name: 'role', options: roleOptions(), value: r.role }))}`,
  });
  if (!data || data.get('role') === r.role) return;
  try {
    await rpc('add_staff', { email: r.email, role: data.get('role') });   // upserts the role; also reactivates
    toast(t('admin.common.saved'), { type: 'success' });
    load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

async function toggle(r) {
  const next = !r.active;
  if (!next && !(await confirmDialog({ message: t('admin.staff.deactivateConfirm', { name: r.full_name || r.email }), confirmLabel: t('admin.staff.deactivate'), danger: true }))) return;
  try {
    await rpc('set_staff_active', { user_id: r.user_id, make_active: next });
    toast(t(next ? 'admin.staff.reactivated' : 'admin.staff.deactivated'), { type: 'success' });
    load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

root.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const find = (id) => rows.find((r) => r.user_id === id);
  if (b.dataset.role) changeRole(find(b.dataset.role));
  if (b.dataset.active) toggle(find(b.dataset.active));
});
document.querySelector('[data-add]').addEventListener('click', add);
load();
