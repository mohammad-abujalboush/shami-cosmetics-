// /account/reset-password.html — opened from the email link. supabase-js turns the link into a recovery
// session (PASSWORD_RECOVERY); then the customer sets a new password with updateUser.
import '../layout.js';
import { t, html, raw, applyStrings, toAppError, showLoading } from '../utils.js';
import { requireClient, getSession } from '../supabase.js';
import { guardedSubmit, setFieldError, fieldHtml, bindPasswordToggles } from '../account.js';
import { ICON_OK } from '../order-view.js';

const card = document.querySelector('[data-slot="auth"]');
document.title = t('auth.resetMeta');
const linkFailed = /[?&#](error|error_code|error_description)=/.test(location.hash + location.search);

function invalid() {
  card.removeAttribute('aria-busy');
  card.innerHTML = html`
    <div class="auth-done">
      <h1>${t('auth.resetInvalidTitle')}</h1>
      <p>${t('auth.resetInvalidText')}</p>
      <a class="btn primary" href="/account/forgot-password.html">${t('auth.resetNewLink')}</a>
    </div>`.toString();
}

function showForm() {
  card.removeAttribute('aria-busy');
  card.innerHTML = html`
    <h1>${t('auth.resetTitle')}</h1>
    <p class="sub">${t('auth.resetSub')}</p>
    <form class="form" novalidate>
      ${fieldHtml({ id: 'password', label: t('account.passwordNew'), autocomplete: 'new-password', password: true, hint: t('auth.passwordHint') })}
      ${fieldHtml({ id: 'confirm', label: t('auth.confirmLabel'), autocomplete: 'new-password', password: true })}
      <p class="form-error" data-form-error role="alert"></p>
      <button type="submit" class="btn primary block">${t('auth.resetSubmit')}</button>
    </form>`.toString();
  applyStrings(card);
  bindPasswordToggles(card);
  const form = card.querySelector('form');
  const f = form.elements;
  guardedSubmit(form, async () => {
    const checks = [
      [f.password, !f.password.value ? t('auth.passwordRequired') : f.password.value.length < 8 ? t('auth.passwordShort') : ''],
      [f.confirm, f.confirm.value === f.password.value ? '' : t('validation.passwordMismatch')],
    ];
    let first = null;
    for (const [input, message] of checks) { setFieldError(input, message); if (message && !first) first = input; }
    if (first) { first.focus(); return; }
    const { error } = await requireClient().auth.updateUser({ password: f.password.value });
    if (error) throw toAppError(error);
    card.innerHTML = html`
      <div class="auth-done">
        ${raw(ICON_OK)}
        <h1>${t('auth.resetDone')}</h1>
        <p>${t('auth.resetDoneText')}</p>
        <a class="btn primary" href="/account/">${t('account.title')}</a>
      </div>`.toString();
    return 'keep';
  });
}

if (linkFailed) {
  invalid();
} else {
  showLoading(card, t('auth.resetChecking'));
  const sb = requireClient();
  const ready = new Promise((resolve) => {
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) { data.subscription.unsubscribe(); resolve(true); }
    });
    setTimeout(() => { data.subscription.unsubscribe(); resolve(false); }, 2500);
  });
  await ready;
  if (await getSession()) showForm(); else invalid();
}
