// Track an order: order number + phone → track_order. Status timeline, items, totals; cancel while
// status = new; CliQ receipt upload while awaiting; review form after delivery.
import '../layout.js';
import { t, html, toWesternDigits, normalizePhone, showLoading, setButtonLoading,
         confirmDialog, toast, errorMessage, toAppError, applyStrings } from '../utils.js';
import { rpc } from '../supabase.js';
import { metaHtml, itemsHtml, totalsHtml, addressHtml, timelineHtml, cliqHtml, bindProofForm, bindCopy,
         storeWhatsapp, waLink } from '../order-view.js';

const form = document.querySelector('[data-form="track"]');
const result = document.querySelector('[data-slot="result"]');
let creds = null;   // { number, phone } of the order on screen; needed for cancel_own_order
let wa = null;
let lookupSeq = 0;

form.innerHTML = html`
  <div class="field">
    <label class="label" for="t-number">${t('track.orderNumber')}</label>
    <input class="input" id="t-number" name="number" type="text" dir="ltr" data-digits autocomplete="off" maxlength="20"
      placeholder="${t('track.orderNumberPlaceholder')}" aria-describedby="t-number-err">
    <p class="field-error" id="t-number-err" role="alert"></p>
  </div>
  <div class="field">
    <label class="label" for="t-phone">${t('track.phone')}</label>
    <input class="input" id="t-phone" name="phone" type="tel" dir="ltr" inputmode="tel" autocomplete="tel" maxlength="20"
      placeholder="07XXXXXXXX" aria-describedby="t-phone-err">
    <p class="field-error" id="t-phone-err" role="alert"></p>
  </div>
  <p class="field-error" id="t-form-err" role="alert"></p>
  <button type="submit" class="btn primary block">${t('track.submit')}</button>`.toString();
applyStrings(form);

const els = {
  number: form.elements.number, phone: form.elements.phone,
  numberErr: form.querySelector('#t-number-err'), phoneErr: form.querySelector('#t-phone-err'),
  formErr: form.querySelector('#t-form-err'), submit: form.querySelector('button[type="submit"]'),
};

function setFieldError(input, errEl, message) {
  errEl.textContent = message || '';
  if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}

// "10001", "sh-10001", Arabic digits → "SH-10001"
function normalizeOrderNumber(value) {
  const v = toWesternDigits(value).replace(/\s+/g, '').toUpperCase();
  if (/^\d{3,12}$/.test(v)) return `SH-${v}`;
  return /^SH-\d{3,12}$/.test(v) ? v : null;
}

async function lookup(number, phone) {
  const seq = ++lookupSeq;
  showLoading(result);
  try {
    const order = await rpc('track_order', { order_number: number, phone });
    if (seq !== lookupSeq) return;
    creds = { number: order.order_number, phone };
    render(order);
  } catch (err) {
    if (seq !== lookupSeq) return;
    creds = null;
    result.removeAttribute('aria-busy');
    result.innerHTML = '';
    const code = toAppError(err).code;
    els.formErr.innerHTML = html`${errorMessage(err)}${code === 'RATE_LIMITED' && wa
      ? html` <a href="${waLink(wa, t('track.contactMessage'))}" target="_blank" rel="noopener">${t('track.contactWhatsapp')}</a>` : ''}`.toString();
    els.formErr.focus?.();
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (els.submit.disabled) return;
  els.formErr.textContent = '';
  const number = normalizeOrderNumber(els.number.value);
  const phone = normalizePhone(els.phone.value);
  setFieldError(els.number, els.numberErr, number ? '' : (els.number.value.trim() ? t('track.orderNumberInvalid') : t('track.orderNumberRequired')));
  setFieldError(els.phone, els.phoneErr, phone ? '' : (els.phone.value.trim() ? t('validation.phoneInvalid') : t('validation.required')));
  if (!number) { els.number.focus(); return; }
  if (!phone) { els.phone.focus(); return; }
  setButtonLoading(els.submit, true);
  await lookup(number, phone);
  setButtonLoading(els.submit, false);
});

/* ---------- Result ---------- */

function reviewHtml(order) {
  if (order.can_review) {
    return html`
      <section class="co-card" aria-labelledby="rv-title">
        <h2 id="rv-title">${t('track.reviewTitle')}</h2>
        <p class="hint">${t('track.reviewIntro')}</p>
        <form class="form" data-review-form novalidate>
          <fieldset class="star-pick">
            <legend>${t('track.reviewRating')}</legend>
            ${[1, 2, 3, 4, 5].map((n) => html`
              <label title="${t('track.reviewStar', { n })}"><input type="radio" name="rating" value="${n}" aria-label="${t('track.reviewStar', { n })}">★</label>`)}
          </fieldset>
          <p class="field-error" data-err="rating" role="alert"></p>
          <div class="field">
            <label class="label" for="rv-body">${t('track.reviewBody')} <span class="opt">(${t('common.optional')})</span></label>
            <textarea class="textarea" id="rv-body" name="body" maxlength="1000" placeholder="${t('track.reviewBodyPlaceholder')}"></textarea>
            <p class="field-error" data-err="body" role="alert"></p>
          </div>
          <p class="field-error" data-err="form" role="alert"></p>
          <button type="submit" class="btn primary">${t('track.reviewSubmit')}</button>
        </form>
      </section>`;
  }
  if (order.review_submitted) {
    return html`<section class="co-card"><div class="alert success" role="status">${t('track.reviewExists')}</div></section>`;
  }
  return '';
}

function render(order) {
  result.removeAttribute('aria-busy');
  result.innerHTML = html`
    <section class="co-card">${metaHtml(order)}</section>
    <div class="co-grid">
      <div class="co-main">
        ${cliqHtml(order, { whatsapp: wa })}
        <section class="co-card"><h2>${t('order.itemsTitle')}</h2>${itemsHtml(order)}</section>
        <section class="co-card"><h2>${t('order.deliveryTitle')}</h2>${addressHtml(order)}</section>
        ${reviewHtml(order)}
      </div>
      <aside class="co-aside">
        <section class="co-card"><h2>${t('order.timelineTitle')}</h2>${timelineHtml(order)}</section>
        <section class="co-card"><h2>${t('order.totalsTitle')}</h2>${totalsHtml(order)}</section>
        ${order.can_cancel ? html`<div class="action-row"><button type="button" class="btn danger" data-cancel>${t('track.cancelButton')}</button></div>
          <p class="hint">${t('track.cancelNote')}</p>` : ''}
      </aside>
    </div>`.toString();

  bindProofForm(result, order, { onDone: (updated) => render(updated) });
  result.querySelector('[data-cancel]')?.addEventListener('click', () => cancel(order));
  bindReview(order);
}

async function cancel(order) {
  const ok = await confirmDialog({
    title: t('track.cancelButton'),
    message: t('track.cancelConfirm', { number: order.order_number }),
    confirmLabel: t('track.cancelConfirmYes'),
    cancelLabel: t('track.cancelKeep'),
    danger: true,
  });
  if (!ok || !creds) return;
  const btn = result.querySelector('[data-cancel]');
  setButtonLoading(btn, true);
  try {
    const updated = await rpc('cancel_own_order', { order_number: creds.number, phone: creds.phone });
    toast(t('track.cancelled'), { type: 'success' });
    render(updated);
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
    if (toAppError(err).code === 'CANNOT_CANCEL') await lookup(creds.number, creds.phone);  // status moved on: refresh
    else setButtonLoading(btn, false);
  }
}

function bindReview(order) {
  const rf = result.querySelector('[data-review-form]');
  if (!rf) return;
  const err = (k) => rf.querySelector(`[data-err="${k}"]`);
  const stars = [...rf.querySelectorAll('.star-pick label')];
  const paint = (upTo) => stars.forEach((l, i) => l.classList.toggle('on', i < upTo));
  rf.addEventListener('change', (e) => {
    if (e.target.name === 'rating') { paint(Number(e.target.value)); err('rating').textContent = ''; }
  });
  rf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = rf.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    err('form').textContent = '';
    const rating = Number(rf.elements.rating.value);
    const body = rf.elements.body.value.trim();
    err('rating').textContent = rating >= 1 && rating <= 5 ? '' : t('track.ratingRequired');
    err('body').textContent = body.length <= 1000 ? '' : t('track.reviewTooLong');
    if (!rating || body.length > 1000) return;
    setButtonLoading(submit, true);
    try {
      await rpc('submit_review', { order_token: order.public_token, rating, body: body || null });
      rf.closest('section').innerHTML = html`<div class="alert success" role="status"><div><strong>${t('track.reviewThanks')}</strong><br>${t('track.reviewThanksText')}</div></div>`.toString();
    } catch (error) {
      err('form').textContent = errorMessage(error);
      if (toAppError(error).code === 'REVIEW_EXISTS') await lookup(creds.number, creds.phone);
      else setButtonLoading(submit, false);
    }
  });
}

bindCopy(result);
storeWhatsapp().then((n) => { wa = n; });
