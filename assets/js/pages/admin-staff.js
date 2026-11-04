// /admin/staff.html (owner) — create staff accounts (Edge Function admin-users), edit details, change role,
// deactivate / reactivate, reset password. Promoting an existing customer account by email stays available.
// Staff are never deleted so order history keeps their names.
import { initAdmin, formDialog } from '../admin.js';
import { t, html, raw, ltr, formatDate, formatPhone, normalizePhone, isValidPhone, normalizeName, isValidName,
         showLoading, showError, showEmpty, toast, errorMessage, confirmDialog } from '../utils.js';
import { rpc } from '../supabase.js';
import { field, input, select, textarea, runChecks, callAdminUsers, generatePassword, copyText } from '../admin-ui.js';
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
      <tbody>${rows.map((r) => {
        const self = r.user_id === ctx.userId;
        return html`
        <tr class="${r.active ? '' : 'is-muted'}">
          <td class="cell-main">${r.full_name || t('admin.staff.noName')}${self ? html` <span class="badge gold">${t('admin.detail.byYou')}</span>` : ''}
            ${r.job_title ? html`<div class="cell-sub">${r.job_title}</div>` : ''}
            ${r.phone ? html`<div class="cell-sub">${ltr(formatPhone(r.phone))}</div>` : ''}</td>
          <td>${ltr(r.email)}</td>
          <td><span class="badge ${r.role === 'owner' ? 'dark' : 'info'}">${t(r.role === 'owner' ? 'admin.roleOwner' : 'admin.roleStaff')}</span></td>
          <td><span class="badge ${r.active ? 'success' : 'danger'}">${t(r.active ? 'admin.common.active' : 'admin.common.inactive')}</span>
            ${r.must_change_password ? html` <span class="badge warning">${t('admin.staff.mustChange')}</span>` : ''}</td>
          <td class="cell-sub">${formatDate(r.created_at, { time: false })}</td>
          <td class="actions">${self ? html`<a class="btn ghost sm" href="/admin/profile.html">${t('admin.nav.profile')}</a>` : html`
            <button type="button" class="btn ghost sm" data-edit="${r.user_id}">${t('admin.staff.edit')}</button>
            ${r.active ? html`<button type="button" class="btn ghost sm" data-role="${r.user_id}">${t('admin.staff.changeRole')}</button>
              <button type="button" class="btn ghost sm" data-reset="${r.user_id}">${t('admin.staff.resetPassword')}</button>` : ''}
            <button type="button" class="btn ghost sm" data-active="${r.user_id}">${t(r.active ? 'admin.staff.deactivate' : 'admin.staff.reactivate')}</button>`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
    <p class="hint" style="margin-top:10px">${t('admin.staff.hint')}</p>`.toString();
}

const roleOptions = () => [{ value: 'staff', label: t('admin.roleStaff') }, { value: 'owner', label: t('admin.roleOwner') }];
const loginUrl = () => `${location.origin}/admin/login.html`;
const toastError = (err) => toast(errorMessage(err), { type: 'error', duration: 7000 });

/* ---------- Temporary password: shown ONCE ---------- */

function showCredentials({ name, email, phone, password, reset = false }) {
  return new Promise((resolve) => {
    const message = t(reset ? 'admin.staff.resetMessage' : 'admin.staff.whatsappMessage', { name: name || '', url: loginUrl(), email, password });
    const wa = `https://wa.me/${phone ? normalizePhone(phone) || '' : ''}?text=${encodeURIComponent(message)}`;
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.setAttribute('aria-labelledby', 'cred-title');
    dialog.innerHTML = html`
      <div class="modal-head"><h2 class="modal-title" id="cred-title">${t('admin.staff.credsTitle')}</h2></div>
      <div class="modal-body form">
        <div class="alert warning" role="alert">${t('admin.staff.credsWarn')}</div>
        <div class="field"><span class="label">${t('admin.staff.loginUrl')}</span><div dir="ltr" style="word-break:break-all">${loginUrl()}</div></div>
        <div class="field"><span class="label">${t('admin.staff.email')}</span><div dir="ltr">${email}</div></div>
        <div class="field"><span class="label">${t('admin.staff.tempPassword')}</span>
          <input class="input" dir="ltr" readonly value="${password}" data-pw aria-label="${t('admin.staff.tempPassword')}" style="font-family:monospace;font-size:17px"></div>
        <div class="toolbar" style="margin:0">
          <button type="button" class="btn ghost sm" data-copy-pw>${t('admin.staff.copyPassword')}</button>
          <button type="button" class="btn ghost sm" data-copy-msg>${t('admin.staff.copyMessage')}</button>
          <a class="btn ghost sm" href="${wa}" target="_blank" rel="noopener">${t('admin.staff.openWhatsapp')}</a>
        </div>
        <div class="field"><label class="label" for="cred-msg">${t('admin.staff.copyMessage')}</label>
          <textarea class="textarea" id="cred-msg" rows="6" readonly dir="auto">${message}</textarea></div>
      </div>
      <div class="modal-foot"><button type="button" class="btn primary sm" data-done>${t('admin.staff.done')}</button></div>`.toString();
    dialog.addEventListener('cancel', (e) => e.preventDefault());   // only the "تم" button closes it
    dialog.querySelector('[data-copy-pw]').addEventListener('click', () => copyText(password));
    dialog.querySelector('[data-copy-msg]').addEventListener('click', () => copyText(message));
    dialog.querySelector('[data-done]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('[data-copy-pw]').focus();
  });
}

/* ---------- Create staff account ---------- */

async function create(prefill = {}) {
  const v = { full_name: '', phone: '', email: '', role: 'staff', job_title: '', notes: '', password: generatePassword(), ...prefill };
  const data = await formDialog({
    title: t('admin.staff.createTitle'), confirmLabel: t('admin.staff.create'), large: true,
    body: html`<p class="hint" style="margin:0">${t('admin.staff.createHint')}</p>
      ${field('c-name', t('admin.staff.name'), input({ id: 'c-name', name: 'full_name', value: v.full_name, maxlength: 60 }))}
      ${field('c-phone', t('admin.staff.phone'), input({ id: 'c-phone', name: 'phone', value: v.phone, dir: 'ltr', inputmode: 'tel' }), { optional: true })}
      ${field('c-email', t('auth.emailLabel'), input({ id: 'c-email', name: 'email', type: 'email', value: v.email, dir: 'ltr', inputmode: 'email' }))}
      ${field('c-role', t('admin.staff.role'), select({ id: 'c-role', name: 'role', options: roleOptions(), value: v.role }))}
      ${field('c-title', t('admin.staff.jobTitle'), input({ id: 'c-title', name: 'job_title', value: v.job_title, maxlength: 100 }), { optional: true })}
      ${field('c-notes', t('admin.staff.notes'), textarea({ id: 'c-notes', name: 'notes', value: v.notes, rows: 2, maxlength: 1000 }), { optional: true, hint: t('admin.staff.notesHint') })}
      ${field('c-pass', t('admin.staff.tempPassword'), html`<div style="display:flex;gap:8px">${input({ id: 'c-pass', name: 'password', value: v.password, dir: 'ltr' })}<button type="button" class="btn ghost sm" data-gen>${t('admin.staff.generate')}</button></div>`, { hint: t('admin.staff.tempPasswordHint') })}`,
    onOpen: (form) => form.querySelector('[data-gen]').addEventListener('click', () => { form.elements.password.value = generatePassword(); }),
    validate: (form) => {
      const name = normalizeName(form.elements.full_name.value);
      const phone = form.elements.phone.value.trim();
      const email = form.elements.email.value.trim();
      return runChecks(form, [
        ['c-name', !name ? t('validation.required') : isValidName(name) ? '' : t('checkout.nameInvalid')],
        ['c-phone', phone && !isValidPhone(phone) ? t('validation.phoneInvalid') : ''],
        ['c-email', !email ? t('auth.emailRequired') : isEmail(email) ? '' : t('validation.emailInvalid')],
        ['c-pass', form.elements.password.value.length < 10 ? t('admin.staff.passwordShort') : ''],
      ]);
    },
  });
  if (!data) return;
  const payload = {
    full_name: normalizeName(data.get('full_name')), phone: data.get('phone') ? normalizePhone(data.get('phone')) : '',
    email: String(data.get('email')).trim().toLowerCase(), role: data.get('role'),
    job_title: String(data.get('job_title') || '').trim(), notes: String(data.get('notes') || '').trim(), password: String(data.get('password')),
  };
  try {
    await callAdminUsers('create_staff', payload);
  } catch (err) {
    toastError(err);
    return create({ ...payload, phone: String(data.get('phone') || '') });   // reopen with the same values
  }
  toast(t('admin.staff.created'), { type: 'success' });
  load();
  await showCredentials({ name: payload.full_name, email: payload.email, phone: payload.phone, password: payload.password });
}

/* ---------- Promote existing account ---------- */

async function promote() {
  const data = await formDialog({
    title: t('admin.staff.addExisting'), confirmLabel: t('admin.staff.add'),
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
  } catch (err) { toastError(err); }
}

/* ---------- Per-member owner actions ---------- */

async function edit(r) {
  const data = await formDialog({
    title: t('admin.staff.editTitle'), confirmLabel: t('common.save'), large: true,
    body: html`<p class="hint" style="margin:0">${ltr(r.email)} — ${t('admin.staff.emailNote')}</p>
      ${field('e-name', t('admin.staff.name'), input({ id: 'e-name', name: 'full_name', value: r.full_name || '', maxlength: 60 }))}
      ${field('e-phone', t('admin.staff.phone'), input({ id: 'e-phone', name: 'phone', value: r.phone ? formatPhone(r.phone) : '', dir: 'ltr', inputmode: 'tel' }), { optional: true })}
      ${field('e-title', t('admin.staff.jobTitle'), input({ id: 'e-title', name: 'job_title', value: r.job_title || '', maxlength: 100 }), { optional: true })}
      ${field('e-notes', t('admin.staff.notes'), textarea({ id: 'e-notes', name: 'notes', value: r.notes || '', rows: 3, maxlength: 1000 }), { optional: true, hint: t('admin.staff.notesHint') })}`,
    validate: (form) => {
      const name = normalizeName(form.elements.full_name.value);
      const phone = form.elements.phone.value.trim();
      return runChecks(form, [
        ['e-name', !name ? t('validation.required') : isValidName(name) ? '' : t('checkout.nameInvalid')],
        ['e-phone', phone && !isValidPhone(phone) ? t('validation.phoneInvalid') : ''],
      ]);
    },
  });
  if (!data) return;
  try {
    await rpc('owner_update_staff', {
      p_user_id: r.user_id, p_full_name: normalizeName(data.get('full_name')),
      p_phone: data.get('phone') ? normalizePhone(data.get('phone')) : '',
      p_job_title: String(data.get('job_title') || ''), p_notes: String(data.get('notes') || ''),
    });
    toast(t('admin.common.saved'), { type: 'success' });
    load();
  } catch (err) { toastError(err); }
}

async function changeRole(r) {
  const data = await formDialog({
    title: t('admin.staff.changeRole'), confirmLabel: t('common.save'),
    body: html`<p style="margin:0"><strong>${r.full_name || r.email}</strong></p>${field('s-role', t('admin.staff.role'), select({ id: 's-role', name: 'role', options: roleOptions(), value: r.role }))}`,
  });
  if (!data || data.get('role') === r.role) return;
  try {
    await rpc('set_staff_role', { p_user_id: r.user_id, p_role: data.get('role') });   // refuses demoting the last active owner
    toast(t('admin.common.saved'), { type: 'success' });
    load();
  } catch (err) { toastError(err); }
}

async function resetPassword(r) {
  const data = await formDialog({
    title: t('admin.staff.resetTitle'), confirmLabel: t('admin.staff.resetPassword'), danger: true,
    body: html`<p style="margin:0"><strong>${r.full_name || r.email}</strong></p><p class="hint" style="margin:0">${t('admin.staff.resetConfirmHint')}</p>
      ${field('r-pass', t('admin.staff.tempPassword'), html`<div style="display:flex;gap:8px">${input({ id: 'r-pass', name: 'password', value: generatePassword(), dir: 'ltr' })}<button type="button" class="btn ghost sm" data-gen>${t('admin.staff.generate')}</button></div>`, { hint: t('admin.staff.tempPasswordHint') })}`,
    onOpen: (form) => form.querySelector('[data-gen]').addEventListener('click', () => { form.elements.password.value = generatePassword(); }),
    validate: (form) => runChecks(form, [['r-pass', form.elements.password.value.length < 10 ? t('admin.staff.passwordShort') : '']]),
  });
  if (!data) return;
  const password = String(data.get('password'));
  try {
    await callAdminUsers('reset_password', { user_id: r.user_id, password });
  } catch (err) { toastError(err); return; }
  toast(t('admin.staff.resetDone'), { type: 'success' });
  load();
  await showCredentials({ name: r.full_name, email: r.email, phone: r.phone, password, reset: true });
}

async function toggle(r) {
  const next = !r.active;
  if (!next && !(await confirmDialog({ message: t('admin.staff.deactivateConfirm', { name: r.full_name || r.email }), confirmLabel: t('admin.staff.deactivate'), danger: true }))) return;
  try {
    await rpc('set_staff_active', { user_id: r.user_id, make_active: next });
    toast(t(next ? 'admin.staff.reactivated' : 'admin.staff.deactivated'), { type: 'success' });
    load();
  } catch (err) { toastError(err); }
}

root.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const find = (id) => rows.find((r) => r.user_id === id);
  if (b.dataset.edit) edit(find(b.dataset.edit));
  if (b.dataset.role) changeRole(find(b.dataset.role));
  if (b.dataset.reset) resetPassword(find(b.dataset.reset));
  if (b.dataset.active) toggle(find(b.dataset.active));
});
document.querySelector('[data-add]').addEventListener('click', () => create());
document.querySelector('[data-promote]').addEventListener('click', promote);
load();
