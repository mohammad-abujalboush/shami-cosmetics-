// Shared helpers for the customer account pages: safe "next" redirects, session guards, logout,
// and small form utilities. Auth is Supabase email + password; every error is mapped to Arabic.
import { t, html, raw, setButtonLoading, errorMessage, toast } from './utils.js';
import { sb, requireClient, getSession } from './supabase.js';

// Only same-site absolute paths ("/checkout.html?x=1"); anything else (other origins, "//evil", "javascript:") is dropped.
export function safeNext(value) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 300 || !/^\/(?![/\\])/.test(v) || /[\u0000-\u001f]/.test(v)) return null;
  return v;
}

export const nextParam = () => safeNext(new URLSearchParams(location.search).get('next'));

// Query string that carries the redirect target to the next auth page.
export const withNext = (href) => {
  const next = nextParam();
  return next ? `${href}?next=${encodeURIComponent(next)}` : href;
};

// Pages that need a customer: no session → login, and come back here afterwards.
export async function requireSession() {
  const session = await getSession();
  if (session) return session;
  location.replace(`/account/login.html?next=${encodeURIComponent(location.pathname + location.search)}`);
  return new Promise(() => {});  // never resolves: the page is navigating away
}

// Login / register / forgot: signed-in customers go straight to where they were headed.
export async function redirectIfSignedIn() {
  const session = await getSession();
  if (session) {
    location.replace(nextParam() || '/account/');
    return new Promise(() => {});
  }
  return null;
}

export async function logout() {
  try { await requireClient().auth.signOut(); } catch (err) { console.warn('[account] signOut', err); }
  location.assign('/');
}

export function setFieldError(input, message) {
  const err = document.getElementById(`${input.id}-err`);
  if (err) err.textContent = message || '';
  if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

// Wraps an async form handler: blocks double submission, shows the Arabic error in [data-form-error].
export function guardedSubmit(form, handler) {
  const submit = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const box = form.querySelector('[data-form-error]');
    if (box) box.textContent = '';
    setButtonLoading(submit, true);
    let keepLoading = false;
    try {
      keepLoading = (await handler()) === 'keep';   // handlers that navigate away return 'keep'
    } catch (err) {
      const msg = errorMessage(err);
      if (box) { box.textContent = msg; } else { toast(msg, { type: 'error' }); }
    } finally {
      if (!keepLoading) setButtonLoading(submit, false);
    }
  });
}

export { sb };

/* ---------- Form markup ---------- */

// <div class="field"> with label, input, optional hint and an error slot (#<id>-err).
export function fieldHtml({ id, label, type = 'text', name = id, dir = '', autocomplete = 'off', hint = '', maxlength = '',
  placeholder = '', value = '', inputmode = '', optional = false, password = false }) {
  const attrs = `id="${id}" name="${name}" type="${password ? 'password' : type}" autocomplete="${autocomplete}"`
    + `${dir ? ` dir="${dir}"` : ''}${maxlength ? ` maxlength="${maxlength}"` : ''}${inputmode ? ` inputmode="${inputmode}"` : ''}`
    + ` aria-describedby="${hint ? `${id}-hint ` : ''}${id}-err"`;
  const control = password
    ? html`<div class="pw-wrap"><input class="input" ${raw(attrs)} dir="ltr">
        <button type="button" class="pw-toggle" data-pw-toggle="${id}" aria-controls="${id}" aria-pressed="false">${t('auth.show')}</button></div>`
    : html`<input class="input" ${raw(attrs)} placeholder="${placeholder}" value="${value}">`;
  return html`
    <div class="field">
      <label class="label" for="${id}">${label}${optional ? html` <span class="opt">(${t('common.optional')})</span>` : ''}</label>
      ${control}
      ${hint ? html`<span class="hint" id="${id}-hint">${hint}</span>` : ''}
      <p class="field-error" id="${id}-err" role="alert"></p>
    </div>`;
}

// Show / hide password buttons inside `root`.
export function bindPasswordToggles(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pw-toggle]');
    if (!btn) return;
    const input = root.querySelector(`#${btn.dataset.pwToggle}`);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = t(show ? 'auth.hide' : 'auth.show');
    btn.setAttribute('aria-pressed', String(show));
  });
}

export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());
