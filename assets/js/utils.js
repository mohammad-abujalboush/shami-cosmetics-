// Shared helpers: strings, digits, formatting, phone, HTML escaping, errors, toasts, UI states.
import strings from './strings.ar.js';
import { STORE_TIMEZONE } from './config.js';

export { strings };

/* ---------- Strings ---------- */

// t('errors.OUT_OF_STOCK'), t('validation.minLength', { min: 8 })
export function t(path, vars) {
  const value = path.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), strings);
  if (typeof value !== 'string') {
    console.warn('[strings] missing key:', path);
    return path;
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

/* ---------- Digits ---------- */

// Arabic-Indic (٠-٩, U+0660–0669) and Persian (۰-۹, U+06F0–06F9) → 0-9.
// Arabic decimal separator (٫) → '.', Arabic thousands separator (٬) removed.
export function toWesternDigits(value) {
  if (value == null) return '';
  return String(value)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');
}

// Numeric-ish inputs get converted as the customer types. Never use type="number" for these —
// browsers drop Arabic digits from number inputs entirely. Use type="tel" or inputmode="numeric",
// or add data-digits to any text input (coupon codes, CliQ references).
const DIGIT_INPUTS = 'input[type="tel"], input[inputmode="numeric"], input[inputmode="decimal"], input[data-digits]';
const EASTERN_DIGITS = /[٠-٩۰-۹٫٬]/;
let digitNormalizerInstalled = false;

export function installDigitNormalizer() {
  if (digitNormalizerInstalled) return;
  digitNormalizerInstalled = true;
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.matches(DIGIT_INPUTS)) return;
    if (!EASTERN_DIGITS.test(el.value)) return;
    const caret = el.selectionStart;
    const converted = toWesternDigits(el.value);
    const newCaret = caret == null ? null : toWesternDigits(el.value.slice(0, caret)).length;
    el.value = converted;
    if (newCaret != null) {
      try { el.setSelectionRange(newCaret, newCaret); } catch { /* input type without selection API */ }
    }
  });
}

/* ---------- Numbers, prices, dates ---------- */

const numberFormatter = new Intl.NumberFormat('ar-JO', { numberingSystem: 'latn', maximumFractionDigits: 3 });

export function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? numberFormatter.format(n) : '';
}

// 18 → "18 د.أ", 2.5 → "2.5 د.أ", 2.125 → "2.125 د.أ" (numeric(10,3), trailing zeros trimmed)
export function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${numberFormatter.format(n)} ${strings.common.currency}`;
}

// Parts are read in Asia/Amman with an 'en-US' formatter so the output is identical in every
// browser; month names come from strings (Levantine names).
const ammanParts = new Intl.DateTimeFormat('en-US', {
  timeZone: STORE_TIMEZONE,
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
});

// "26 أيلول 2026، 3:40 م"   |   { time: false } → "26 أيلول 2026"
export function formatDate(value, { time = true } = {}) {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const p = Object.fromEntries(ammanParts.formatToParts(date).map(({ type, value: v }) => [type, v]));
  const datePart = `${Number(p.day)} ${strings.common.months[Number(p.month) - 1]} ${p.year}`;
  if (!time) return datePart;
  const hour24 = Number(p.hour) % 24;
  const hour12 = hour24 % 12 || 12;
  const period = hour24 < 12 ? strings.common.am : strings.common.pm;
  return `${datePart}، ${hour12}:${p.minute} ${period}`;
}

/* ---------- Phone (Jordan mobile) ---------- */

// Accepts 07XXXXXXXX, 7XXXXXXXX, 9627XXXXXXXX, +9627…, 009627…, with spaces/dashes and
// Arabic/Persian digits. Returns the stored form "9627XXXXXXXX", or null if invalid.
export function normalizePhone(input) {
  let d = toWesternDigits(input).replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('962')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^7[789]\d{7}$/.test(d) ? `962${d}` : null;
}

export function isValidPhone(input) {
  return normalizePhone(input) !== null;
}

// "962791234567" → "079 123 4567". Render inside ltr() so it doesn't scramble in RTL.
export function formatPhone(stored) {
  const normalized = normalizePhone(stored);
  if (!normalized) return String(stored ?? '');
  const local = `0${normalized.slice(3)}`;
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}

/* ---------- Arabic search normalization ---------- */

// Must stay identical to the Postgres normalize_ar(text) function.
export function normalizeArabic(text) {
  return toWesternDigits(text)
    .toLowerCase()
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, '') // tashkeel & Quranic marks
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compareArabic(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'ar');
}

/* ---------- HTML ---------- */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

// Marks a string as already-safe HTML for the html`` tag.
export function raw(value) {
  return new SafeHtml(String(value ?? ''));
}

// Tagged template that escapes every interpolation unless it is raw()/html`` output.
// Arrays are joined, so html`<ul>${items.map((i) => html`<li>${i.name}</li>`)}</ul>` works.
export function html(parts, ...values) {
  const render = (v) => {
    if (v instanceof SafeHtml) return v.value;
    if (Array.isArray(v)) return v.map(render).join('');
    if (v == null || v === false) return '';
    return escapeHtml(v);
  };
  return new SafeHtml(parts.reduce((out, part, i) => out + part + (i < values.length ? render(values[i]) : ''), ''));
}

// Phone numbers, emails, order numbers, coupon codes, SKUs, CliQ aliases.
export function ltr(value, className = 'ltr') {
  return raw(`<span dir="ltr" class="${escapeHtml(className)}">${escapeHtml(value)}</span>`);
}

/* ---------- Errors ---------- */

export class AppError extends Error {
  constructor(code, cause) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.cause = cause;
  }
}

const POSTGREST_CODES = {
  PGRST301: 'SESSION_EXPIRED',
  PGRST303: 'SESSION_EXPIRED',
  PGRST116: 'NOT_FOUND',
  42501: 'NOT_AUTHORIZED',
  23505: 'DUPLICATE',
  '23P01': 'OFFER_OVERLAP', // exclusion constraint (one active offer per category)
  23503: 'IN_USE',          // foreign key (e.g. deleting a category that has products)
  23514: 'INVALID_INPUT',   // check constraint
  23502: 'INVALID_INPUT',   // not null
  '22P02': 'INVALID_INPUT', // invalid text representation
};

// Turns any Supabase / network / thrown error into an AppError with a code from strings.errors.
export function toAppError(err) {
  if (err instanceof AppError) return err;
  const message = String(err?.message ?? '').trim();
  const code = String(err?.code ?? '');

  let appCode = 'UNKNOWN';
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(message) && strings.errors[message]) {
    appCode = message; // RPC raised a known code
  } else if (code && strings.errors[`AUTH_${code.toUpperCase()}`]) {
    appCode = `AUTH_${code.toUpperCase()}`;
  } else if (POSTGREST_CODES[code]) {
    appCode = POSTGREST_CODES[code];
  } else if (err?.status === 429) {
    appCode = 'RATE_LIMITED';
  } else if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)
    || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    appCode = 'NETWORK';
  }
  if (appCode === 'UNKNOWN') console.error('[error]', err);
  return new AppError(appCode, err);
}

export function errorMessage(err) {
  return strings.errors[toAppError(err).code] || strings.errors.UNKNOWN;
}

/* ---------- Toasts ---------- */

let toastStack = null;

// type: 'info' | 'success' | 'error'
export function toast(message, { type = 'info', duration = 4500 } = {}) {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    document.body.append(toastStack);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = html`
    <span class="toast-msg">${message}</span>
    <button type="button" class="toast-close" aria-label="${t('common.close')}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>`.toString();

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    const remove = () => el.remove();
    el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 400); // fallback when animations are disabled
  };
  el.querySelector('.toast-close').addEventListener('click', dismiss);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  toastStack.append(el);
  return dismiss;
}

/* ---------- Loading / empty / error states ---------- */

const STATE_ICONS = {
  empty: '<svg class="state-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="18" width="32" height="22" rx="3"/><path d="M8 26h32M18 18c0-4 2-7 6-7s6 3 6 7"/></svg>',
  error: '<svg class="state-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="24" cy="24" r="17"/><path d="M24 15v11M24 32v.5"/></svg>',
};

export function showLoading(container, text = t('states.loading')) {
  container.setAttribute('aria-busy', 'true');
  container.innerHTML = html`
    <div class="state state-loading" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p class="state-text">${text}</p>
    </div>`.toString();
}

// showEmpty(el, { title, text, actionLabel, actionHref })
export function showEmpty(container, { title = t('states.emptyTitle'), text = '', actionLabel = '', actionHref = '' } = {}) {
  container.removeAttribute('aria-busy');
  container.innerHTML = html`
    <div class="state state-empty">
      ${raw(STATE_ICONS.empty)}
      <p class="state-title">${title}</p>
      ${text ? html`<p class="state-text">${text}</p>` : ''}
      ${actionLabel && actionHref ? html`<a class="btn primary" href="${actionHref}">${actionLabel}</a>` : ''}
    </div>`.toString();
}

// showError(el, { error, message, onRetry }) — message defaults to the Arabic text for error's code.
export function showError(container, { error = null, message = '', onRetry = null } = {}) {
  container.removeAttribute('aria-busy');
  container.innerHTML = html`
    <div class="state state-error" role="alert">
      ${raw(STATE_ICONS.error)}
      <p class="state-title">${t('states.errorTitle')}</p>
      <p class="state-text">${message || errorMessage(error)}</p>
      ${onRetry ? html`<button type="button" class="btn ghost" data-retry>${t('common.retry')}</button>` : ''}
    </div>`.toString();
  if (onRetry) container.querySelector('[data-retry]').addEventListener('click', onRetry, { once: true });
}

export function clearState(container) {
  container.removeAttribute('aria-busy');
  container.innerHTML = '';
}

// Disables a submit button and shows a spinner while an async action runs.
export function setButtonLoading(button, loading) {
  if (!button) return;
  button.disabled = loading;
  button.classList.toggle('is-loading', loading);
  button.setAttribute('aria-busy', String(loading));
  const existing = button.querySelector(':scope > .spinner');
  if (loading && !existing) button.insertAdjacentHTML('afterbegin', '<span class="spinner sm" aria-hidden="true"></span>');
  if (!loading && existing) existing.remove();
}

/* ---------- Confirm dialog ---------- */

// const ok = await confirmDialog({ message, confirmLabel, danger: true })
export function confirmDialog({ title = t('confirm.title'), message = '', confirmLabel = t('common.confirm'), cancelLabel = t('common.cancel'), danger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    dialog.innerHTML = html`
      <form method="dialog">
        <div class="modal-head"><h2 class="modal-title" id="confirm-title">${title}</h2></div>
        ${message ? html`<div class="modal-body"><p>${message}</p></div>` : ''}
        <div class="modal-foot">
          <button type="submit" value="cancel" class="btn ghost sm">${cancelLabel}</button>
          <button type="submit" value="ok" class="btn ${danger ? 'danger' : 'primary'} sm">${confirmLabel}</button>
        </div>
      </form>`.toString();
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok');
      dialog.remove();
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/* ---------- Misc ---------- */

export function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
