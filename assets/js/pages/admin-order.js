// /admin/order.html?id=<uuid> — full order for staff and owner.
// Staff: status changes (allowed transitions only), restock tick on returns, internal notes, WhatsApp, print.
// Owner additionally: CliQ receipt viewer (signed URLs), verify / reject payment, mark refunded.
// Every rule is enforced again in Postgres (update_order_status / verify_payment / mark_refunded).
import { initAdmin, formDialog, isOverdueCliq, loadStaffNames, whoName } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatDate, formatPhone, getParam, showLoading, showError, setButtonLoading,
         confirmDialog, toast, errorMessage, toAppError } from '../utils.js';
import { rpc, run } from '../supabase.js';

const ctx = await initAdmin({ page: 'orders' });
document.title = t('admin.detail.meta');
const root = document.querySelector('[data-slot="order"]');
const id = getParam('id');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NEXT = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['with_courier', 'cancelled'],
  with_courier: ['delivered', 'returned', 'cancelled'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};
const WA_ORDER = ['new', 'confirmed', 'with_courier', 'delivered', 'cancelled', 'returned'];
let order = null;
let waTemplate = null;
let names = new Map();

const collectAmount = (o) => (o.payment_status === 'paid' ? 0 : Number(o.total));
const cliqWaiting = (o) => o.payment_method === 'cliq' && ['awaiting_transfer', 'awaiting_verification'].includes(o.payment_status);

/* ---------- Loading ---------- */

async function load() {
  if (!id || !UUID.test(id)) { notFound(); return; }
  showLoading(root);
  try {
    names = await loadStaffNames();
    const row = await run(ctx.sb.from('orders')
      .select('*, order_items(*), order_status_history(*), order_notes(*)').eq('id', id).maybeSingle());
    if (!row) { notFound(); return; }
    order = row;
    document.title = `${t('admin.detail.title', { number: row.order_number })} | Shami Cosmetics`;
    render();
  } catch (err) {
    showError(root, { message: `${t('admin.detail.loadError')} ${errorMessage(err)}`, onRetry: load });
  }
}

function notFound() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`<div class="state state-empty"><p class="state-title">${t('admin.detail.notFoundTitle')}</p>
    <p class="state-text">${t('admin.detail.notFoundText')}</p><a class="btn primary" href="/admin/orders.html">${t('admin.detail.back')}</a></div>`.toString();
}

/* ---------- Render ---------- */

function whoLabel(row) {
  if (row.by_customer) return t('admin.detail.byCustomer');
  return whoName(names, row.changed_by);
}

function historyHtml(o) {
  const rows = [...o.order_status_history].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
  return html`<ol class="timeline">${rows.map((h) => {
    const lines = [];
    if (!h.from_status) lines.push(t('admin.detail.historyCreated'));
    else if (h.from_status !== h.to_status) lines.push(t('admin.detail.historyStatus', { from: t(`order.statuses.${h.from_status}`), to: t(`order.statuses.${h.to_status}`) }));
    if (h.payment_from || h.payment_to) {
      lines.push(t('admin.detail.historyPayment', { from: h.payment_from ? t(`order.payStatuses.${h.payment_from}`) : '—', to: t(`order.payStatuses.${h.payment_to}`) }));
    }
    return html`<li>${lines.map((l) => html`<div><strong>${l}</strong></div>`)}
      <div class="when">${formatDate(h.created_at)} · ${t('admin.detail.by', { who: whoLabel(h) })}</div>
      ${h.note ? html`<div class="note">${h.note}</div>` : ''}</li>`;
  })}</ol>`;
}

function itemsHtml(o) {
  return html`
    <div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table">
      <tbody>${o.order_items.slice().sort((a, b) => a.id - b.id).map((i) => html`
        <tr><td><div class="cell-main">${i.product_name_ar}</div><div class="cell-sub">${i.variant_label}${i.sku ? html` · ${ltr(i.sku)}` : ''}</div></td>
          <td class="num">${i.quantity} × ${formatPrice(i.unit_price)}</td><td class="num">${formatPrice(i.line_total)}</td></tr>`)}</tbody>
    </table></div>`;
}

function totalsHtml(o) {
  return html`
    <div class="summary" style="padding:16px 20px">
      <div class="summary-row"><span>${t('admin.detail.subtotal')}</span><span class="num">${formatPrice(o.subtotal)}</span></div>
      ${Number(o.bundle_discount) > 0 ? html`<div class="summary-row discount"><span>${t('admin.detail.bundle')}</span><span class="num">− ${formatPrice(o.bundle_discount)}</span></div>` : ''}
      ${Number(o.coupon_discount) > 0 ? html`<div class="summary-row discount"><span>${t('admin.detail.coupon', { code: o.coupon_code || '' })}</span><span class="num">− ${formatPrice(o.coupon_discount)}</span></div>` : ''}
      <div class="summary-row"><span>${t('admin.detail.delivery')}</span><span class="num">${formatPrice(o.delivery_fee)}</span></div>
      <div class="summary-row total"><span>${t('admin.detail.total')}</span><span class="num">${formatPrice(o.total)}</span></div>
    </div>`;
}

function statusPanel(o) {
  const next = NEXT[o.status] || [];
  const blocked = (s) => s === 'with_courier' && o.payment_method === 'cliq' && o.payment_status !== 'paid';
  return html`
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.statusActions')}</h2>
      <span class="badge" data-status="${o.status}">${t(`order.statuses.${o.status}`)}</span></div>
      <div class="panel-body">
        ${next.length ? html`<div class="action-row" style="display:flex;flex-wrap:wrap;gap:8px">
          ${next.map((s) => html`<button type="button" class="btn ${s === 'cancelled' ? 'danger' : 'primary'} sm" data-move="${s}" ${raw(blocked(s) ? 'disabled aria-describedby="need-pay"' : '')}>${t('admin.detail.moveTo', { status: t(`order.statuses.${s}`) })}</button>`)}
        </div>
        ${next.some(blocked) ? html`<p class="hint" id="need-pay" style="margin-top:8px">${t('admin.detail.needsPayment')}</p>` : ''}`
          : html`<p class="hint">${t('admin.detail.noTransitions')}</p>`}
      </div></section>`;
}

function paymentPanel(o) {
  const overdue = isOverdueCliq(o, ctx.cliqWindow);
  const canVerify = ctx.isOwner && o.payment_method === 'cliq' && ['awaiting_transfer', 'awaiting_verification'].includes(o.payment_status);
  const canReject = ctx.isOwner && o.payment_method === 'cliq' && ['awaiting_verification', 'paid'].includes(o.payment_status) && ['new', 'confirmed'].includes(o.status);
  return html`
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.payment')}</h2>
      <span class="badge" data-status="${o.payment_status}">${t(`order.payStatuses.${o.payment_status}`)}</span></div>
      <div class="panel-body">
        ${overdue ? html`<div class="alert warning" role="alert" style="margin-bottom:12px">${t('admin.detail.overdueNote', { hours: ctx.cliqWindow })}</div>` : ''}
        <dl class="kv">
          <dt>${t('admin.detail.method')}</dt><dd>${t(`order.methods.${o.payment_method}`)}</dd>
          ${o.payment_reference ? html`<dt>${t('admin.detail.reference')}</dt><dd>${ltr(o.payment_reference)}</dd>` : ''}
          ${o.payment_submitted_at ? html`<dt>${t('admin.detail.submittedAt')}</dt><dd>${formatDate(o.payment_submitted_at)}</dd>` : ''}
          ${o.paid_at ? html`<dt>${t('admin.detail.paidAt')}</dt><dd>${formatDate(o.paid_at)}</dd>` : ''}
        </dl>
        ${o.payment_method === 'cliq' ? (ctx.isOwner ? html`
          <h3 style="font-size:14.5px;margin:16px 0 8px">${t('admin.detail.proofTitle')}</h3>
          <div data-proofs><span class="hint">${t('common.loading')}</span></div>
          ${canVerify || canReject ? html`<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
            ${canVerify ? html`<button type="button" class="btn primary sm" data-verify>${t('admin.detail.verify')}</button>` : ''}
            ${canReject ? html`<button type="button" class="btn ghost sm" data-reject>${t('admin.detail.reject')}</button>` : ''}</div>` : ''}`
          : html`<p class="hint" style="margin-top:12px">${t('admin.detail.proofOwnerOnly')}</p>`) : ''}
      </div></section>
    ${o.payment_status === 'refund_due' ? html`
    <section class="panel" style="border-color:var(--danger)"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.refundTitle')}</h2></div>
      <div class="panel-body">
        <p>${t('admin.detail.refundText', { amount: formatPrice(o.total) })}</p>
        ${ctx.isOwner ? html`
          <div class="field"><label class="label" for="refund-note">${t('admin.detail.refundNote')}</label>
            <textarea class="textarea" id="refund-note" rows="2" maxlength="1000"></textarea></div>
          <button type="button" class="btn danger sm" data-refund style="margin-top:10px">${t('admin.detail.refundDone')}</button>`
          : html`<p class="hint">${t('admin.detail.refundOwnerOnly')}</p>`}
      </div></section>` : ''}`;
}

function notesPanel(o) {
  const notes = o.order_notes.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return html`
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.notesTitle')}</h2></div>
      <div class="panel-body">
        ${notes.length ? html`<ul style="list-style:none;margin:0 0 14px;padding:0;display:grid;gap:10px">${notes.map((n) => html`
          <li class="card soft" style="padding:12px 14px"><div style="white-space:pre-line">${n.body}</div>
            <div class="cell-sub" style="display:flex;justify-content:space-between;gap:8px;margin-top:6px">
              <span>${formatDate(n.created_at)} · ${whoName(names, n.created_by)}</span>
              ${n.created_by === ctx.userId || ctx.isOwner ? html`<button type="button" class="btn link" data-note-delete="${n.id}">${t('admin.detail.noteDelete')}</button>` : ''}</div></li>`)}</ul>`
          : html`<p class="hint">${t('admin.detail.notesEmpty')}</p>`}
        <form data-note-form novalidate class="form">
          <div class="field"><label class="label" for="note-body">${t('admin.detail.noteLabel')}</label>
            <textarea class="textarea" id="note-body" rows="2" maxlength="2000"></textarea>
            <p class="field-error" id="note-body-err" role="alert"></p></div>
          <div><button type="submit" class="btn ghost sm">${t('admin.detail.noteAdd')}</button></div>
        </form>
      </div></section>`;
}

function waVars(o) {
  return {
    name: o.customer_name, number: o.order_number, total: formatPrice(o.total), collect: formatPrice(collectAmount(o)),
    link: `${location.origin}/order.html?token=${o.public_token}`,
  };
}
function waText(o, key) { return t(`admin.wa.${key}`, waVars(o)); }

function waPanel(o) {
  const keys = [...WA_ORDER, ...(o.payment_method === 'cliq' ? ['cliq_reminder'] : [])];
  if (!waTemplate || !keys.includes(waTemplate)) waTemplate = cliqWaiting(o) && o.status === 'new' ? 'cliq_reminder' : o.status;
  return html`
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.waTitle')}</h2></div>
      <div class="panel-body form">
        <div class="field"><label class="label" for="wa-tpl">${t('admin.detail.waTemplate')}</label>
          <select class="select" id="wa-tpl">${keys.map((k) => html`<option value="${k}" ${raw(k === waTemplate ? 'selected' : '')}>${t(`admin.detail.waTpl.${k}`)}</option>`)}</select></div>
        <div class="field"><label class="label" for="wa-text">${t('admin.detail.waText')}</label>
          <textarea class="textarea" id="wa-text" rows="5">${waText(o, waTemplate)}</textarea></div>
        <a class="btn primary sm" data-wa-open target="_blank" rel="noopener" href="#">${t('admin.detail.waOpen')}</a>
      </div></section>`;
}

function render() {
  const o = order;
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="admin-page-head">
      <div>
        <a class="link-inline" href="/admin/orders.html">${t('admin.detail.back')}</a>
        <h2 style="font-size:22px;margin-top:6px">${t('admin.detail.title', { number: '' })}${ltr(o.order_number)}</h2>
        <p class="sub">${formatDate(o.created_at)}</p>
      </div>
      <div class="actions">
        <span class="badge" data-status="${o.status}">${t(`order.statuses.${o.status}`)}</span>
        <span class="badge" data-status="${o.payment_status}">${t(`order.payStatuses.${o.payment_status}`)}</span>
        <a class="btn ghost sm" href="/admin/print.html?ids=${o.id}" target="_blank" rel="noopener">${t('admin.detail.print')}</a>
      </div>
    </div>
    <div class="admin-grid split">
      <div class="admin-grid">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.customer')}</h2></div>
          <div class="panel-body"><dl class="kv">
            <dt>${t('admin.detail.name')}</dt><dd>${o.customer_name}</dd>
            <dt>${t('admin.detail.phone')}</dt><dd>${ltr(formatPhone(o.phone))}</dd>
            <dt>${t('admin.detail.address')}</dt><dd>${[o.governorate_name, o.area, o.address_details].filter(Boolean).join('، ')}</dd>
            ${o.notes ? html`<dt>${t('admin.detail.notes')}</dt><dd style="white-space:pre-line">${o.notes}</dd>` : ''}
            <dt>${t('admin.detail.account')}</dt><dd>${o.user_id ? t('common.yes') : t('common.no')}</dd>
          </dl></div></section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.items')}</h2></div>
          <div class="panel-body flush">${itemsHtml(o)}${totalsHtml(o)}</div></section>
        ${notesPanel(o)}
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.detail.historyTitle')}</h2></div>
          <div class="panel-body">${historyHtml(o)}</div></section>
      </div>
      <div class="admin-grid" style="align-content:start">
        ${statusPanel(o)}
        ${paymentPanel(o)}
        ${waPanel(o)}
      </div>
    </div>`.toString();
  bind();
  if (ctx.isOwner && o.payment_method === 'cliq') loadProofs();
  syncWa();
}

/* ---------- Proofs (owner) ---------- */

async function loadProofs() {
  const box = root.querySelector('[data-proofs]');
  if (!box) return;
  try {
    const bucket = ctx.sb.storage.from('payment-proofs');
    const { data: files, error } = await bucket.list(order.public_token, { limit: 10 });
    if (error) throw error;
    const names = (files || []).filter((f) => f.name && f.id !== null).map((f) => `${order.public_token}/${f.name}`);
    if (!names.length) { box.innerHTML = html`<span class="hint">${t('admin.detail.proofNone')}</span>`.toString(); return; }
    const { data: signed, error: e2 } = await bucket.createSignedUrls(names, 600);
    if (e2) throw e2;
    box.innerHTML = html`<div class="thumb-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">${signed.map((s) => html`
      <a class="thumb-item" style="aspect-ratio:3/4" href="${s.signedUrl}" target="_blank" rel="noopener" aria-label="${t('admin.detail.proofOpen')}">
        <img src="${s.signedUrl}" alt="${t('admin.detail.proofImage')}" loading="lazy" style="object-fit:contain;background:#fff"></a>`)}</div>`.toString();
    box.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => {
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'hint', textContent: t('admin.detail.proofOpen'), style: 'padding:10px' }));
    }));
  } catch (err) {
    box.innerHTML = html`<span class="hint" role="alert">${t('admin.detail.proofError')}</span>`.toString();
    console.warn('[admin] proofs', err);
  }
}

/* ---------- Actions ---------- */

async function reloadAfter(message) {
  toast(message, { type: 'success' });
  window.dispatchEvent(new CustomEvent('admin:orders-changed'));
  await load();
}

async function move(status) {
  const returning = status === 'returned';
  const data = await formDialog({
    title: t('admin.detail.changeTitle', { status: t(`order.statuses.${status}`) }),
    body: html`
      <div class="field"><label class="label" for="m-note">${t('admin.detail.changeNote')}</label><textarea class="textarea" id="m-note" name="note" rows="3" maxlength="1000"></textarea></div>
      ${returning ? html`<label class="check"><input type="checkbox" name="restock"> <span><strong>${t('admin.detail.restock')}</strong><br><span class="hint">${t('admin.detail.restockHint')}</span></span></label>` : ''}
      ${status === 'cancelled' ? html`<p class="hint" style="margin:0">${t('admin.detail.cancelRestockHint')}</p>` : ''}`,
    confirmLabel: t('admin.detail.confirmChange'),
    danger: status === 'cancelled',
  });
  if (!data) return;
  try {
    await rpc('update_order_status', { order_id: order.id, new_status: status, note: String(data.get('note') || '').trim() || null, restock: data.get('restock') === 'on' });
    await reloadAfter(t('admin.detail.changed'));
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
    await load();   // the order may have moved on elsewhere
  }
}

async function payment(paid, button) {
  const ok = await confirmDialog({ message: t(paid ? 'admin.detail.verifyConfirm' : 'admin.detail.rejectConfirm'),
    confirmLabel: t(paid ? 'admin.detail.verify' : 'admin.detail.reject'), danger: !paid });
  if (!ok) return;
  setButtonLoading(button, true);
  try {
    await rpc('verify_payment', { order_id: order.id, paid });
    await reloadAfter(t(paid ? 'admin.detail.verified' : 'admin.detail.rejected'));
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
    setButtonLoading(button, false);
  }
}

async function refund(button) {
  const note = root.querySelector('#refund-note').value.trim();
  setButtonLoading(button, true);
  try {
    await rpc('mark_refunded', { order_id: order.id, note: note || null });
    await reloadAfter(t('admin.detail.refundDoneToast'));
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
    setButtonLoading(button, false);
  }
}

function syncWa() {
  const text = root.querySelector('#wa-text');
  const link = root.querySelector('[data-wa-open]');
  if (text && link) link.href = `https://wa.me/${order.phone}?text=${encodeURIComponent(text.value)}`;
}

function bind() {
  root.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => move(b.dataset.move)));
  root.querySelector('[data-verify]')?.addEventListener('click', (e) => payment(true, e.currentTarget));
  root.querySelector('[data-reject]')?.addEventListener('click', (e) => payment(false, e.currentTarget));
  root.querySelector('[data-refund]')?.addEventListener('click', (e) => refund(e.currentTarget));

  root.querySelector('#wa-tpl')?.addEventListener('change', (e) => { waTemplate = e.target.value; root.querySelector('#wa-text').value = waText(order, waTemplate); syncWa(); });
  root.querySelector('#wa-text')?.addEventListener('input', syncWa);

  const nf = root.querySelector('[data-note-form]');
  nf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const area = nf.querySelector('#note-body');
    const body = area.value.trim();
    nf.querySelector('#note-body-err').textContent = body ? '' : t('admin.detail.noteEmpty');
    if (!body) { area.focus(); return; }
    const btn = nf.querySelector('button[type="submit"]');
    setButtonLoading(btn, true);
    try {
      const { error } = await ctx.sb.from('order_notes').insert({ order_id: order.id, body });
      if (error) throw toAppError(error);
      await reloadAfter(t('admin.detail.noteAdded'));
    } catch (err) {
      toast(errorMessage(err), { type: 'error' });
      setButtonLoading(btn, false);
    }
  });
  root.querySelectorAll('[data-note-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog({ message: t('admin.detail.noteConfirm'), confirmLabel: t('admin.detail.noteDelete'), danger: true }))) return;
    try {
      const { error } = await ctx.sb.from('order_notes').delete().eq('id', b.dataset.noteDelete);
      if (error) throw toAppError(error);
      await reloadAfter(t('admin.detail.noteDeleted'));
    } catch (err) {
      toast(errorMessage(err), { type: 'error' });
    }
  }));
}

load();
