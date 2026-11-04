// /admin/profile.html — every staff member edits their OWN name, phone, email and password.
// Also the only page reachable while a temporary password is pending (?force=1): it then shows
// the password card only, and the redirect to /admin/ happens once the new password is saved.
import { initAdmin } from '../admin.js';
import { t, html, AppError, formatPhone, normalizePhone, isValidPhone, normalizeName, isValidName, showLoading, showError, toast, errorMessage } from '../utils.js';
import { rpc, run } from '../supabase.js';
import { field, input, runChecks, setErr, withSave } from '../admin-ui.js';
import { isEmail } from '../account.js';

const ctx = await initAdmin({ page: 'profile' });
document.title = t('admin.profile.meta');
const root = document.querySelector('[data-slot="profile"]');
const forced = ctx.forced === true;

async function load() {
  showLoading(root);
  try {
    const [profile, userRes] = await Promise.all([
      run(ctx.sb.from('profiles').select('full_name, phone').eq('id', ctx.userId).maybeSingle()),
      ctx.sb.auth.getUser(),
    ]);
    paint(profile || { full_name: '', phone: '' }, userRes?.data?.user?.new_email || '');
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

const card = (title, body) => html`<section class="panel"><div class="panel-head"><h2 class="panel-title">${title}</h2></div><div class="panel-body form" style="max-width:520px">${body}</div></section>`;

function paint(profile, pendingEmail) {
  root.removeAttribute('aria-busy');
  const pwCard = card(t('admin.profile.passwordTitle'), html`
    <form data-pw novalidate>
      ${field('pw-current', t('admin.profile.currentPassword'), input({ id: 'pw-current', type: 'password', dir: 'ltr' }))}
      ${field('pw-new', t('admin.profile.newPassword'), input({ id: 'pw-new', type: 'password', dir: 'ltr' }))}
      ${field('pw-confirm', t('admin.profile.confirmPassword'), input({ id: 'pw-confirm', type: 'password', dir: 'ltr' }))}
      <div class="form-actions"><button type="submit" class="btn primary">${t('admin.profile.changePassword')}</button></div>
    </form>`);

  if (forced) {
    root.innerHTML = html`
      <div class="alert warning" role="status"><strong>${t('admin.profile.forcedTitle')}</strong><br>${t('admin.profile.forcedText')}</div>
      ${pwCard}`.toString();
  } else {
    root.innerHTML = html`
      ${card(t('admin.profile.infoTitle'), html`
        <form data-info novalidate>
          ${field('p-name', t('admin.profile.name'), input({ id: 'p-name', value: profile.full_name || '', maxlength: 60 }))}
          ${field('p-phone', t('admin.profile.phone'), input({ id: 'p-phone', value: profile.phone ? formatPhone(profile.phone) : '', dir: 'ltr', inputmode: 'tel', hint: t('admin.profile.phoneHint') }), { hint: t('admin.profile.phoneHint'), optional: true })}
          <div class="form-actions"><button type="submit" class="btn primary">${t('admin.profile.saveInfo')}</button></div>
        </form>`)}
      ${card(t('admin.profile.emailTitle'), html`
        <p style="margin:0" dir="ltr">${ctx.email}</p>
        ${pendingEmail ? html`<p class="hint">${t('admin.profile.emailPending', { email: pendingEmail })}</p>` : ''}
        <form data-email novalidate>
          ${field('e-new', t('admin.profile.emailNew'), input({ id: 'e-new', type: 'email', dir: 'ltr', inputmode: 'email' }), { hint: t('admin.profile.emailHint') })}
          ${field('e-pass', t('admin.profile.currentPassword'), input({ id: 'e-pass', type: 'password', dir: 'ltr' }))}
          <div class="form-actions"><button type="submit" class="btn primary">${t('admin.profile.changeEmail')}</button></div>
        </form>`)}
      ${pwCard}`.toString();
    root.querySelector('[data-info]').addEventListener('submit', saveInfo);
    root.querySelector('[data-email]').addEventListener('submit', changeEmail);
  }
  root.querySelector('[data-pw]').addEventListener('submit', changePassword);
}

// Re-verifies the current password (also proves the person at the keyboard is the account owner).
async function verifyCurrent(password) {
  const { error } = await ctx.sb.auth.signInWithPassword({ email: ctx.email, password });
  if (error) {
    throw new AppError('WRONG_CURRENT_PASSWORD', error);
  }
}

async function saveInfo(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const name = normalizeName(form.elements['p-name'].value);
  const phoneRaw = form.elements['p-phone'].value.trim();
  const phone = phoneRaw ? normalizePhone(phoneRaw) : '';
  if (!runChecks(form, [
    ['p-name', !name ? t('admin.profile.nameRequired') : isValidName(name) ? '' : t('checkout.nameInvalid')],
    ['p-phone', phoneRaw && !isValidPhone(phoneRaw) ? t('validation.phoneInvalid') : ''],
  ])) return;
  await withSave(form.querySelector('button[type="submit"]'), async () => {
    await rpc('update_my_profile', { p_full_name: name, p_phone: phone || '' });
  });
}

async function changeEmail(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.elements['e-new'].value.trim().toLowerCase();
  const pass = form.elements['e-pass'].value;
  if (!runChecks(form, [
    ['e-new', !email ? t('auth.emailRequired') : !isEmail(email) ? t('validation.emailInvalid') : email === ctx.email.toLowerCase() ? t('admin.profile.emailSame') : ''],
    ['e-pass', pass ? '' : t('admin.profile.currentRequired')],
  ])) return;
  const { ok, error } = await withSave(form.querySelector('button[type="submit"]'), async () => {
    await verifyCurrent(pass);
    const { error: err } = await ctx.sb.auth.updateUser({ email }, { emailRedirectTo: `${location.origin}/admin/login.html` });
    if (err) throw err;
  }, t('admin.profile.emailSent'));
  if (ok) form.reset();
  else if (error?.code === 'WRONG_CURRENT_PASSWORD') setErr(form, 'e-pass', t('admin.profile.wrongCurrent'));
}

async function changePassword(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const cur = form.elements['pw-current'].value;
  const next = form.elements['pw-new'].value;
  const again = form.elements['pw-confirm'].value;
  if (!runChecks(form, [
    ['pw-current', cur ? '' : t('admin.profile.currentRequired')],
    ['pw-new', next.length < 8 ? t('admin.profile.newShort') : next === cur ? t('admin.profile.sameAsOld') : ''],
    ['pw-confirm', again === next ? '' : t('validation.passwordMismatch')],
  ])) return;
  const { ok, error } = await withSave(form.querySelector('button[type="submit"]'), async () => {
    await verifyCurrent(cur);
    const { error: err } = await ctx.sb.auth.updateUser({ password: next });
    if (err) throw err;
    await rpc('complete_password_change');   // clears the forced-change flag (only if the password really changed)
  }, t('admin.profile.passwordChanged'));
  if (ok) {
    form.reset();
    if (forced) setTimeout(() => location.replace('/admin/'), 700);
  } else if (error?.code === 'WRONG_CURRENT_PASSWORD') {
    setErr(form, 'pw-current', t('admin.profile.wrongCurrent'));
  }
}

load();
