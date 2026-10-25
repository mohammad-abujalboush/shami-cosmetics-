// /account/register.html — name, phone, email, password (≥ 8). The profile row is created by the DB
// trigger from the sign-up metadata. With email confirmation on, the customer is told to check the inbox.
import '../layout.js';
import { t, html, raw, applyStrings, isValidName, normalizeName, normalizePhone, toAppError } from '../utils.js';
import { requireClient } from '../supabase.js';
import { redirectIfSignedIn, nextParam, withNext, guardedSubmit, setFieldError, fieldHtml, bindPasswordToggles, isEmail } from '../account.js';
import { ICON_OK } from '../order-view.js';

const card = document.querySelector('[data-slot="auth"]');
document.title = t('auth.registerMeta');

await redirectIfSignedIn();

card.innerHTML = html`
  <h1>${t('auth.registerTitle')}</h1>
  <p class="sub">${t('auth.registerSub')}</p>
  <form class="form" novalidate>
    ${fieldHtml({ id: 'name', label: t('auth.nameLabel'), autocomplete: 'name', maxlength: 60 })}
    ${fieldHtml({ id: 'phone', label: t('auth.phoneLabel'), type: 'tel', dir: 'ltr', autocomplete: 'tel', inputmode: 'tel', maxlength: 20, placeholder: '07XXXXXXXX', hint: t('checkout.phoneHint') })}
    ${fieldHtml({ id: 'email', label: t('auth.emailLabel'), type: 'email', dir: 'ltr', autocomplete: 'email', inputmode: 'email' })}
    ${fieldHtml({ id: 'password', label: t('auth.passwordLabel'), autocomplete: 'new-password', password: true, hint: t('auth.passwordHint') })}
    ${fieldHtml({ id: 'confirm', label: t('auth.confirmLabel'), autocomplete: 'new-password', password: true })}
    <p class="form-error" data-form-error role="alert"></p>
    <button type="submit" class="btn primary block">${t('auth.registerSubmit')}</button>
  </form>
  <p class="alt">${t('auth.haveAccount')} <a href="${withNext('/account/login.html')}">${t('auth.loginLink')}</a></p>`.toString();
applyStrings(card);
bindPasswordToggles(card);

const form = card.querySelector('form');
const f = form.elements;

guardedSubmit(form, async () => {
  const name = normalizeName(f.name.value);
  const phone = normalizePhone(f.phone.value);
  const checks = [
    [f.name, !name ? t('validation.required') : isValidName(name) ? '' : t('checkout.nameInvalid')],
    [f.phone, !f.phone.value.trim() ? t('validation.required') : phone ? '' : t('validation.phoneInvalid')],
    [f.email, !f.email.value.trim() ? t('auth.emailRequired') : isEmail(f.email.value) ? '' : t('validation.emailInvalid')],
    [f.password, !f.password.value ? t('auth.passwordRequired') : f.password.value.length < 8 ? t('auth.passwordShort') : ''],
    [f.confirm, f.confirm.value === f.password.value ? '' : t('validation.passwordMismatch')],
  ];
  let first = null;
  for (const [input, message] of checks) { setFieldError(input, message); if (message && !first) first = input; }
  if (first) { first.focus(); return; }

  const next = nextParam();
  const email = f.email.value.trim();
  const { data, error } = await requireClient().auth.signUp({
    email,
    password: f.password.value,
    options: {
      data: { full_name: name, phone },
      emailRedirectTo: `${location.origin}/account/login.html${next ? `?next=${encodeURIComponent(next)}` : ''}`,
    },
  });
  if (error) throw toAppError(error);
  // With email confirmation on, an existing address comes back as a user with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw toAppError({ code: 'user_already_exists' });
  }
  if (data.session) { location.assign(next || '/account/'); return 'keep'; }
  card.innerHTML = html`
    <div class="auth-done">
      ${raw(ICON_OK)}
      <h1>${t('auth.checkEmailTitle')}</h1>
      <p>${t('auth.checkEmailText', { email })}</p>
      <a class="btn primary" href="${withNext('/account/login.html')}">${t('auth.backToLogin')}</a>
    </div>`.toString();
  return 'keep';
});
