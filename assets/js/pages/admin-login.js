// /admin/login.html — Supabase email + password. Only active staff rows get in; everyone else is signed out
// again with "غير مصرح". (Real protection is RLS; this only keeps customers out of the admin UI.)
import { t, html, applyStrings, toAppError, getParam } from '../utils.js';
import { requireClient, getSession, run } from '../supabase.js';
import { guardedSubmit, setFieldError, fieldHtml, bindPasswordToggles, isEmail, safeNext } from '../account.js';

const card = document.querySelector('[data-slot="auth"]');
document.title = t('admin.login.meta');
const sb = requireClient();

// Only back into the admin area
const nextRaw = safeNext(getParam('next'));
const next = nextRaw && nextRaw.startsWith('/admin/') ? nextRaw : '/admin/';

async function isStaff() {
  const session = await getSession();
  if (!session) return false;
  const row = await run(sb.from('staff').select('active').eq('user_id', session.user.id).maybeSingle());
  return Boolean(row?.active);
}

card.innerHTML = html`
  <h1>${t('admin.login.title')}</h1>
  <p class="sub">${t('admin.login.sub')}</p>
  <div class="alert danger" data-denied role="alert" ${getParam('denied') ? '' : 'hidden'} style="margin-bottom:16px">${t('admin.login.denied')}</div>
  <form class="form" novalidate>
    ${fieldHtml({ id: 'email', label: t('auth.emailLabel'), type: 'email', dir: 'ltr', autocomplete: 'email', inputmode: 'email' })}
    ${fieldHtml({ id: 'password', label: t('auth.passwordLabel'), autocomplete: 'current-password', password: true })}
    <p class="form-error" data-form-error role="alert"></p>
    <button type="submit" class="btn primary block">${t('admin.login.submit')}</button>
  </form>
  <p class="alt"><a href="/">${t('admin.login.back')}</a></p>`.toString();
applyStrings(card);
bindPasswordToggles(card);

// Already signed in as staff → straight in
try { if (!getParam('denied') && await isStaff()) { location.replace(next); await new Promise(() => {}); } } catch { /* show the form */ }

const form = card.querySelector('form');
const email = form.elements.email;
const password = form.elements.password;
const denied = card.querySelector('[data-denied]');

guardedSubmit(form, async () => {
  denied.hidden = true;
  const emailOk = isEmail(email.value);
  setFieldError(email, emailOk ? '' : (email.value.trim() ? t('validation.emailInvalid') : t('auth.emailRequired')));
  setFieldError(password, password.value ? '' : t('auth.passwordRequired'));
  if (!emailOk) { email.focus(); return; }
  if (!password.value) { password.focus(); return; }

  const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
  if (error) throw toAppError(error);
  let staff = false;
  try { staff = await isStaff(); } catch (err) { await sb.auth.signOut().catch(() => {}); throw err; }
  if (!staff) {
    await sb.auth.signOut().catch(() => {});
    denied.hidden = false;
    password.value = '';
    return;
  }
  location.assign(next);
  return 'keep';
});
