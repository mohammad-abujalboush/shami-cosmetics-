// Small form / validation helpers shared by the admin pages. Everything validates in Arabic
// (forms use novalidate); numbers accept Arabic-Indic digits.
import { t, html, raw, toWesternDigits, toast, errorMessage, setButtonLoading, confirmDialog } from './utils.js';

// → null (blank), NaN (not a number), or the Number. Accepts "٣٫٥", "3,5", "3.5".
export function parseNum(value) {
  const s = toWesternDigits(value).replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}
export function parseIntStrict(value) {
  const n = parseNum(value);
  return n === null ? null : (Number.isInteger(n) ? n : NaN);
}
export const decimals = (n) => (String(n).split('.')[1] || '').length;

/* ---------- Markup ---------- */

export function field(id, label, control, { hint = '', optional = false, cls = '' } = {}) {
  return html`
    <div class="field ${cls}">
      <label class="label" for="${id}">${label}${optional ? html` <span class="opt">(${t('common.optional')})</span>` : ''}</label>
      ${control}
      ${hint ? html`<span class="hint" id="${id}-hint">${hint}</span>` : ''}
      <p class="field-error" id="${id}-err" role="alert"></p>
    </div>`;
}

const describe = (id, hint) => `aria-describedby="${hint ? `${id}-hint ` : ''}${id}-err"`;

export function input({ id, name = id, type = 'text', value = '', dir = '', placeholder = '', maxlength = '', inputmode = '', hint = '', extra = '' }) {
  return html`<input class="input" id="${id}" name="${name}" type="${type}" value="${value ?? ''}"${raw(dir ? ` dir="${dir}"` : '')}${raw(maxlength ? ` maxlength="${maxlength}"` : '')}${raw(inputmode ? ` inputmode="${inputmode}"` : '')} placeholder="${placeholder}" autocomplete="off" ${raw(describe(id, hint))} ${raw(extra)}>`;
}
export function numberInput(opts) { return input({ type: 'text', inputmode: 'decimal', dir: 'ltr', ...opts }); }

export function select({ id, name = id, options, value = '', hint = '', extra = '' }) {
  return html`<select class="select" id="${id}" name="${name}" ${raw(describe(id, hint))} ${raw(extra)}>${options.map((o) => html`<option value="${o.value}" ${raw(String(o.value) === String(value) ? 'selected' : '')}>${o.label}</option>`)}</select>`;
}

export function textarea({ id, name = id, value = '', rows = 3, maxlength = '', placeholder = '', hint = '' }) {
  return html`<textarea class="textarea" id="${id}" name="${name}" rows="${rows}"${raw(maxlength ? ` maxlength="${maxlength}"` : '')} placeholder="${placeholder}" ${raw(describe(id, hint))}>${value ?? ''}</textarea>`;
}

export function switchRow({ id, name = id, label, checked = false, hint = '' }) {
  return html`
    <div class="switch-row">
      <label for="${id}"><strong>${label}</strong>${hint ? html`<br><span class="hint">${hint}</span>` : ''}</label>
      <input type="checkbox" class="switch" role="switch" id="${id}" name="${name}" ${raw(checked ? 'checked' : '')}>
    </div>`;
}

/* ---------- Validation ---------- */

export function setErr(root, id, message) {
  const el = root.querySelector(`#${CSS.escape(id)}`);
  const err = root.querySelector(`#${CSS.escape(id)}-err`);
  if (err) err.textContent = message || '';
  if (el) { if (message) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
  return !message;
}

// checks: [[id, message-or-''], …] → true when all pass; focuses the first failing field.
export function runChecks(root, checks) {
  let first = null;
  for (const [id, message] of checks) {
    setErr(root, id, message);
    if (message && !first) first = id;
  }
  if (first) root.querySelector(`#${CSS.escape(first)}`)?.focus();
  return !first;
}

export const required = (v) => (String(v ?? '').trim() ? '' : t('validation.required'));

/* ---------- Actions ---------- */

// Runs an async save with the button in a loading state; toasts the Arabic error on failure.
export async function withSave(button, fn, successMessage = t('admin.common.saved')) {
  setButtonLoading(button, true);
  try {
    const out = await fn();
    if (successMessage) toast(successMessage, { type: 'success' });
    return { ok: true, value: out };
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
    return { ok: false, error: err };
  } finally {
    setButtonLoading(button, false);
  }
}

export const confirmDelete = (message, label = t('common.delete')) => confirmDialog({ message, confirmLabel: label, danger: true });

export function swap(list, i, j) {
  if (j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  return true;
}

export const arrow = (dir) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="${dir === 'up' ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'}"/></svg>`;

// "+5", "-3", "−3" (typographic minus) and Arabic digits → integer; null (blank) / NaN (invalid).
export function parseSignedInt(value) {
  const s = toWesternDigits(value).trim().replace(/^[−–]/, '-');
  const neg = s.startsWith('-');
  const n = parseIntStrict(s.replace(/^[-+]/, ''));
  return n === null || Number.isNaN(n) ? n : (neg ? -n : n);
}
