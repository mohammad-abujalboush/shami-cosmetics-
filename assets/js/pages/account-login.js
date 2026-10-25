// /account/login.html — email + password. Returns to ?next= (e.g. checkout) after signing in.
// The cart lives in localStorage, so a guest cart is kept as is on login (nothing to merge).
import '../layout.js';
import { t, html, applyStrings, toAppError } from '../utils.js';
import { requireClient } from '../supabase.js';
import { redirectIfSignedIn, nextParam, withNext, guardedSubmit, setFieldError, fieldHtml, bindPasswordToggles, isEmail } from '../account.js';

const card = document.querySelector('[data-slot="auth"]');
document.title = t('auth.loginMeta');

await redirectIfSignedIn();

card.innerHTML = html`
  <h1>${t('auth.loginTitle')}</h1>
  <p class="sub">${t('auth.loginSub')}</p>
  <form class="form" novalidate>
    ${fieldHtml({ id: 'email', label: t('auth.emailLabel'), type: 'email', dir: 'ltr', autocomplete: 'email', inputmode: 'email' })}
    ${fieldHtml({ id: 'password', label: t('auth.passwordLabel'), autocomplete: 'current-password', password: true })}
    <p class="form-error" data-form-error role="alert"></p>
    <button type="submit" class="btn primary block">${t('auth.loginSubmit')}</button>
    <div class="form-links"><a href="${withNext('/account/forgot-password.html')}">${t('auth.forgotLink')}</a></div>
  </form>
  <p class="alt">${t('auth.noAccount')} <a href="${withNext('/account/register.html')}">${t('auth.createAccountLink')}</a></p>`.toString();
applyStrings(card);
bindPasswordToggles(card);

const form = card.querySelector('form');
const email = form.elements.email;
const password = form.elements.password;

guardedSubmit(form, async () => {
  const emailOk = isEmail(email.value);
  setFieldError(email, emailOk ? '' : (email.value.trim() ? t('validation.emailInvalid') : t('auth.emailRequired')));
  setFieldError(password, password.value ? '' : t('auth.passwordRequired'));
  if (!emailOk) { email.focus(); return; }
  if (!password.value) { password.focus(); return; }
  const { error } = await requireClient().auth.signInWithPassword({ email: email.value.trim(), password: password.value });
  if (error) throw toAppError(error);
  location.assign(nextParam() || '/account/');
  return 'keep';
});
