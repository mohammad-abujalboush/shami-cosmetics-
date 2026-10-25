// /account/forgot-password.html — sends the reset link. The answer never reveals whether the email exists.
import '../layout.js';
import { t, html, raw, applyStrings, toAppError } from '../utils.js';
import { requireClient } from '../supabase.js';
import { withNext, guardedSubmit, setFieldError, fieldHtml, isEmail } from '../account.js';
import { ICON_OK } from '../order-view.js';

const card = document.querySelector('[data-slot="auth"]');
document.title = t('auth.forgotMeta');

card.innerHTML = html`
  <h1>${t('auth.forgotTitle')}</h1>
  <p class="sub">${t('auth.forgotSub')}</p>
  <form class="form" novalidate>
    ${fieldHtml({ id: 'email', label: t('auth.emailLabel'), type: 'email', dir: 'ltr', autocomplete: 'email', inputmode: 'email' })}
    <p class="form-error" data-form-error role="alert"></p>
    <button type="submit" class="btn primary block">${t('auth.forgotSubmit')}</button>
  </form>
  <p class="alt"><a href="${withNext('/account/login.html')}">${t('auth.backToLogin')}</a></p>`.toString();
applyStrings(card);

const form = card.querySelector('form');
guardedSubmit(form, async () => {
  const input = form.elements.email;
  const ok = isEmail(input.value);
  setFieldError(input, ok ? '' : (input.value.trim() ? t('validation.emailInvalid') : t('auth.emailRequired')));
  if (!ok) { input.focus(); return; }
  const email = input.value.trim();
  const { error } = await requireClient().auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/account/reset-password.html` });
  // Supabase doesn't report unknown emails here; only real failures (rate limit, network) surface.
  if (error) throw toAppError(error);
  card.innerHTML = html`
    <div class="auth-done">
      ${raw(ICON_OK)}
      <h1>${t('auth.forgotSentTitle')}</h1>
      <p>${t('auth.forgotSentText', { email })}</p>
      <a class="btn ghost" href="${withNext('/account/login.html')}">${t('auth.backToLogin')}</a>
    </div>`.toString();
  return 'keep';
});
