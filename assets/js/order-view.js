// Shared order rendering for order.html and track.html: summary, status timeline, CliQ details,
// receipt upload (client-side compression), copy buttons and the WhatsApp order message.
// Everything shown comes from the get_order_by_token / track_order RPCs (never computed here).
import { t, html, raw, ltr, formatPrice, formatDate, formatPhone, toast, errorMessage, toAppError, AppError,
         setButtonLoading, toWesternDigits } from './utils.js';
import { rpc } from './supabase.js';

const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const MAX_PROOF_SIDE = 1600;
const STEPS = ['new', 'confirmed', 'with_courier', 'delivered'];

const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
export const ICON_OK = '<svg class="ok-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="24" cy="24" r="20"/><path d="m14 25 7 7 13-15"/></svg>';

export const statusLabel = (s) => t(`order.statuses.${s}`);
export const payLabel = (order) => t(`order.payStatuses.${order.payment_status}`);

/* ---------- Summary ---------- */

export function metaHtml(order) {
  return html`
    <dl class="order-meta">
      <div><dt>${t('order.orderNumber')}</dt><dd class="order-number">${ltr(order.order_number)}</dd></div>
      <div><dt>${t('order.status')}</dt><dd><span class="badge" data-status="${order.status}">${statusLabel(order.status)}</span></dd></div>
      <div><dt>${t('order.payment')}</dt><dd><span class="badge" data-status="${order.payment_status}">${payLabel(order)}</span></dd></div>
      <div><dt>${t('order.paymentMethod')}</dt><dd>${t(`order.methods.${order.payment_method}`)}</dd></div>
      <div><dt>${t('order.date')}</dt><dd>${formatDate(order.created_at)}</dd></div>
    </dl>`;
}

export function itemsHtml(order) {
  return html`
    <ul class="order-items">
      ${order.items.map((i) => html`
        <li>
          <div>
            <div class="name">${i.product_name_ar}</div>
            <div class="meta">${i.variant_label ? `${i.variant_label} · ` : ''}${t('order.quantity', { qty: i.quantity })} · ${formatPrice(i.unit_price)}</div>
          </div>
          <span class="price">${formatPrice(i.line_total)}</span>
        </li>`)}
    </ul>`;
}

export function totalsHtml(order) {
  const bundle = Number(order.bundle_discount) || 0;
  const coupon = Number(order.coupon_discount) || 0;
  const fee = Number(order.delivery_fee) || 0;
  return html`
    <div class="summary">
      <div class="summary-row"><span>${t('order.subtotal')}</span><span class="num">${formatPrice(order.subtotal)}</span></div>
      ${bundle > 0 ? html`<div class="summary-row discount"><span>${t('order.bundle')}</span><span class="num">− ${formatPrice(bundle)}</span></div>` : ''}
      ${coupon > 0 ? html`<div class="summary-row discount"><span>${t('order.coupon', { code: order.coupon_code || '' })}</span><span class="num">− ${formatPrice(coupon)}</span></div>` : ''}
      <div class="summary-row"><span>${t('order.delivery')}</span><span class="num">${fee > 0 ? formatPrice(fee) : t('order.deliveryFree')}</span></div>
      <div class="summary-row total"><span>${t('order.total')}</span><span class="num">${formatPrice(order.total)}</span></div>
    </div>`;
}

export function addressHtml(order) {
  return html`
    <dl class="addr-list">
      <div><dt>${t('order.customer')}</dt><dd>${order.customer_name}</dd></div>
      <div><dt>${t('order.phone')}</dt><dd>${ltr(formatPhone(order.phone))}</dd></div>
      <div><dt>${t('order.address')}</dt><dd>${[order.governorate_name, order.area, order.address_details].filter(Boolean).join('، ')}</dd></div>
      ${order.notes ? html`<div><dt>${t('order.notes')}</dt><dd>${order.notes}</dd></div>` : ''}
    </dl>`;
}

// Real history from the database; remaining normal steps shown greyed while the order is still moving.
export function timelineHtml(order) {
  const at = new Map();
  for (const h of order.history || []) if (!at.has(h.status)) at.set(h.status, h.at);
  const terminal = order.status === 'cancelled' || order.status === 'returned';
  let rows;
  if (terminal) {
    rows = (order.history || []).map((h) => ({ status: h.status, at: h.at, bad: h.status === 'cancelled' || h.status === 'returned' }));
  } else {
    const idx = STEPS.indexOf(order.status);
    rows = STEPS.map((s, i) => ({ status: s, at: at.get(s), done: i <= idx, current: i === idx }));
  }
  return html`
    <ol class="steps">
      ${rows.map((r) => html`
        <li class="${r.bad ? 'is-bad' : ''} ${r.done || (terminal && !r.bad) ? 'is-done' : ''} ${r.current ? 'is-current' : ''}"${raw(r.current ? ' aria-current="step"' : '')}>
          <span class="dot">${raw(r.bad ? ICON_X : (r.done || terminal) ? ICON_CHECK : '')}</span>
          <div class="label">${statusLabel(r.status)}</div>
          ${r.at ? html`<div class="when">${formatDate(r.at)}</div>` : ''}
        </li>`)}
    </ol>`;
}

/* ---------- CliQ ---------- */

function copyRow(label, value, { dir = false } = {}) {
  const shown = dir ? ltr(value) : value;
  return html`
    <div class="copy-row">
      <div><small>${label}</small><strong>${shown}</strong></div>
      <button type="button" class="btn ghost sm" data-copy="${value}" aria-label="${t('order.copyAria', { what: label })}">${t('order.copy')}</button>
    </div>`;
}

// Transfer details + receipt form (or the "received" state). `store` = { whatsapp } for the fallback link.
export function cliqHtml(order, store = {}) {
  if (!order.cliq) return '';
  const c = order.cliq;
  const waiting = order.payment_status === 'awaiting_verification';
  const amount = formatPrice(c.amount);
  return html`
    <section class="co-card cliq-card" aria-labelledby="cliq-title">
      <h2 id="cliq-title">${t('order.cliqTitle')}</h2>
      <p>${t('order.cliqIntro')}</p>
      ${copyRow(t('order.cliqAlias'), c.alias, { dir: true })}
      ${copyRow(t('order.cliqAccount'), c.account_name)}
      <div class="copy-row">
        <div><small>${t('order.cliqAmount')}</small><strong>${amount}</strong></div>
        <button type="button" class="btn ghost sm" data-copy="${String(Number(c.amount))}" aria-label="${t('order.copyAria', { what: t('order.cliqAmount') })}">${t('order.copy')}</button>
      </div>
      ${copyRow(t('order.cliqNote'), order.order_number, { dir: true })}
      ${!waiting ? html`<div class="alert info">${t('order.cliqWindow', { hours: c.window_hours })}</div>` : ''}
      ${waiting ? html`<div class="alert success" role="status"><div><strong>${t('order.proofDone')}</strong><br>${t('order.proofDoneText')}</div></div>` : ''}
      ${!waiting && order.can_upload_proof ? proofFormHtml() : ''}
      ${!waiting && !order.can_upload_proof ? html`
        <div class="alert warning" role="alert"><div>${t('errors.PROOF_LIMIT_REACHED')}
          ${store.whatsapp ? html`<br><a href="${waLink(store.whatsapp, t('track.contactMessage'))}" target="_blank" rel="noopener">${t('track.contactWhatsapp')}</a>` : ''}</div></div>` : ''}
    </section>`;
}

function proofFormHtml() {
  return html`
    <form class="form" data-proof-form novalidate style="margin-top:18px">
      <h3 style="font-size:16px">${t('order.proofTitle')}</h3>
      <p class="hint" style="margin:0">${t('order.proofIntro')}</p>
      <div class="field">
        <label class="proof-drop" for="proof-file">
          <span class="strong">${t('order.proofFile')}</span>
          <span class="hint">${t('order.proofHint')}</span>
          <input id="proof-file" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" data-proof-file>
        </label>
        <div class="proof-preview" data-proof-preview hidden>
          <img alt="${t('order.proofPreview')}" width="84" height="84">
          <button type="button" class="btn ghost sm" data-proof-clear>${t('order.proofRemove')}</button>
        </div>
        <p class="field-error" data-err="file" role="alert"></p>
      </div>
      <div class="field">
        <label class="label" for="proof-ref">${t('order.proofReference')} <span class="opt">(${t('common.optional')})</span></label>
        <input class="input" id="proof-ref" type="text" dir="ltr" data-digits autocomplete="off" maxlength="64" placeholder="${t('order.proofReferencePlaceholder')}">
        <p class="field-error" data-err="ref" role="alert"></p>
      </div>
      <p class="field-error" data-err="form" role="alert"></p>
      <button type="submit" class="btn primary block">${t('order.proofSubmit')}</button>
    </form>`;
}

/* ---------- Receipt upload ---------- */

function randomName() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// → { blob, ext, type }. Re-encodes to JPEG (max 1600px) so phone photos fit comfortably under 5 MB.
// HEIC/HEIF that the browser can't decode is sent as-is when it already fits.
export async function prepareProofImage(file) {
  const name = String(file.name || '').toLowerCase();
  const looksImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/.test(name);
  if (!looksImage) throw new AppError('FILE_TYPE_INVALID');
  try {
    const bmp = await createImageBitmap(file);
    let scale = Math.min(1, MAX_PROOF_SIDE / Math.max(bmp.width, bmp.height));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82 - attempt * 0.1));
      if (blob && blob.size <= MAX_PROOF_BYTES) { bmp.close?.(); return { blob, ext: 'jpg', type: 'image/jpeg' }; }
      scale *= 0.7;
    }
    bmp.close?.();
    throw new AppError('FILE_TOO_LARGE');
  } catch (err) {
    if (err instanceof AppError) throw err;
    const heic = /heic|heif/.test(file.type) || /\.(heic|heif)$/.test(name);
    if (heic && file.size <= MAX_PROOF_BYTES) {
      return { blob: file, ext: /heif$/.test(name) ? 'heif' : 'heic', type: file.type || 'image/heic' };
    }
    throw new AppError('IMAGE_READ_FAILED');
  }
}

async function uploadProof(token, prepared) {
  const { sb } = await import('./supabase.js');
  const path = `${token}/${randomName()}.${prepared.ext}`;
  const { error } = await sb.storage.from('payment-proofs').upload(path, prepared.blob, {
    contentType: prepared.type, upsert: false,
  });
  if (!error) return path;
  const status = Number(error.statusCode ?? error.status);
  const msg = String(error.message || '');
  if (status === 413 || /maximum allowed size|too large/i.test(msg)) throw new AppError('FILE_TOO_LARGE');
  if (/mime type|not supported|not allowed/i.test(msg) && !/policy/i.test(msg)) throw new AppError('FILE_TYPE_INVALID');
  if (status === 401 || status === 403 || /row-level security|policy|unauthorized/i.test(msg)) {
    // The storage policy refuses the 4th file, a cancelled order, or an order already paid/submitted.
    const fresh = await rpc('get_order_by_token', { token }).catch(() => null);
    if (fresh?.payment_status === 'awaiting_verification') throw new AppError('RECEIPT_ALREADY_UPLOADED');
    if (fresh && ['cancelled', 'returned'].includes(fresh.status)) throw new AppError('ORDER_CANCELLED');
    throw new AppError('PROOF_LIMIT_REACHED');
  }
  throw new AppError(/fetch|network/i.test(msg) ? 'NETWORK' : 'UPLOAD_FAILED');
}

// Wires the form from proofFormHtml(). onDone(updatedOrder) after attach_payment_proof succeeds;
// onLimit() when the file limit / state changed (caller re-renders from the server).
export function bindProofForm(root, order, { onDone }) {
  const form = root.querySelector('[data-proof-form]');
  if (!form) return;
  const fileInput = form.querySelector('[data-proof-file]');
  const refInput = form.querySelector('#proof-ref');
  const preview = form.querySelector('[data-proof-preview]');
  const submit = form.querySelector('button[type="submit"]');
  const err = (k) => form.querySelector(`[data-err="${k}"]`);
  let prepared = null;
  let previewUrl = null;
  let preparing = Promise.resolve();

  const clearFile = () => {
    prepared = null;
    fileInput.value = '';
    preview.hidden = true;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  };
  form.querySelector('[data-proof-clear]').addEventListener('click', () => { clearFile(); err('file').textContent = ''; });

  fileInput.addEventListener('change', () => {
    err('file').textContent = '';
    err('form').textContent = '';
    const file = fileInput.files?.[0];
    if (!file) { clearFile(); return; }
    preparing = (async () => {
      try {
        prepared = await prepareProofImage(file);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(prepared.blob);
        const img = preview.querySelector('img');
        img.src = previewUrl;
        img.onerror = () => { preview.hidden = true; };  // e.g. HEIC the browser can't draw: still uploads
        preview.hidden = false;
      } catch (e) {
        clearFile();
        err('file').textContent = errorMessage(e);
      }
    })();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    err('form').textContent = '';
    err('ref').textContent = '';
    await preparing;
    const reference = toWesternDigits(refInput.value).trim();
    if (reference.length > 64) { err('ref').textContent = t('order.proofReferenceTooLong'); refInput.focus(); return; }
    if (!prepared && !reference) { err('file').textContent = t('order.proofNeedsFile'); return; }

    setButtonLoading(submit, true);
    try {
      let path = null;
      if (prepared) path = await uploadProof(order.public_token, prepared);
      const updated = await rpc('attach_payment_proof', { token: order.public_token, file_path: path, reference: reference || null });
      toast(t('order.proofDone'), { type: 'success' });
      onDone(updated);
    } catch (error) {
      const code = toAppError(error).code;
      if (['RECEIPT_ALREADY_UPLOADED', 'ORDER_CANCELLED', 'ALREADY_PAID', 'PROOF_LIMIT_REACHED'].includes(code)) {
        // State changed (or file limit reached): show the message, then re-read the order from the server.
        toast(errorMessage(error), { type: 'error', duration: 7000 });
        const fresh = await rpc('get_order_by_token', { token: order.public_token }).catch(() => null);
        if (fresh) { onDone(fresh); return; }
      }
      err('form').textContent = errorMessage(error);
    } finally {
      setButtonLoading(submit, false);
    }
  });
}

/* ---------- Copy buttons ---------- */

export function bindCopy(root) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      ta.remove();
    }
    toast(t('order.copied'), { type: 'success', duration: 1800 });
  });
}

/* ---------- WhatsApp ---------- */

export function waLink(number, text) {
  return `https://wa.me/${String(number).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

export function orderWhatsappText(order) {
  const lines = [
    t('order.waMessage'),
    t('order.waOrder', { number: order.order_number }),
    t('order.waName', { name: order.customer_name }),
    t('order.waPhone', { phone: formatPhone(order.phone) }),
    t('order.waAddress', { address: [order.governorate_name, order.area, order.address_details].filter(Boolean).join('، ') }),
    t('order.waItems'),
    ...order.items.map((i) => t('order.waItem', { name: i.product_name_ar, variant: i.variant_label || '', qty: i.quantity }).replace(' ()', '')),
    t('order.waTotal', { total: formatPrice(order.total) }),
    t('order.waPayment', { method: t(`order.methods.${order.payment_method}`) }),
  ];
  return lines.join('\n');
}

export async function storeWhatsapp() {
  try {
    const { getSiteData } = await import('./layout.js');
    const { settings } = await getSiteData();
    return String(settings?.store_whatsapp ?? '').replace(/\D/g, '') || null;
  } catch {
    return null;
  }
}
