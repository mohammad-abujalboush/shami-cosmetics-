// /admin/reviews.html (staff + owner) — moderate customer reviews: approve, hide (reject), feature on the homepage.
// Only approved reviews are public (RLS); a hidden review is never shown and can be approved again later.
import { initAdmin } from '../admin.js';
import { t, html, raw, ltr, formatDate, showLoading, showError, showEmpty, toast, errorMessage, toAppError } from '../utils.js';
import { starsHtml } from '../catalog.js';

const ctx = await initAdmin({ page: 'reviews' });
document.title = t('admin.reviews.meta');
const root = document.querySelector('[data-slot="reviews"]');
const TABS = ['pending', 'approved', 'rejected'];
let tab = TABS.includes(new URLSearchParams(location.search).get('s')) ? new URLSearchParams(location.search).get('s') : 'pending';
let rows = [];
let counts = {};

async function load() {
  showLoading(root);
  try {
    const { data, error } = await ctx.sb.from('reviews')
      .select('id, rating, body, display_name, governorate_name, status, featured, created_at, moderated_at, orders(order_number)')
      .order('created_at', { ascending: false }).limit(300);
    if (error) throw toAppError(error);
    rows = data;
    counts = Object.fromEntries(TABS.map((s) => [s, rows.filter((r) => r.status === s).length]));
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

function card(r) {
  return html`
    <article class="co-card" style="padding:18px 20px" data-id="${r.id}">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;align-items:center">
        <div><span class="stars" aria-label="${t('home.starsAria', { n: r.rating })}">${raw(starsHtml(r.rating))}</span>
          <strong style="margin-inline-start:8px">${r.display_name}</strong>
          ${r.governorate_name ? html`<span class="cell-sub"> — ${r.governorate_name}</span>` : ''}</div>
        <div class="cell-sub">${formatDate(r.created_at)}${r.orders?.order_number ? html` · ${ltr(r.orders.order_number)}` : ''}</div>
      </div>
      ${r.body ? html`<blockquote style="margin:10px 0;font-weight:600;white-space:pre-line">${r.body}</blockquote>` : html`<p class="hint" style="margin:10px 0">${t('admin.reviews.noText')}</p>`}
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
        ${r.status !== 'approved' ? html`<button type="button" class="btn primary sm" data-act="approve" data-id="${r.id}">${t('admin.reviews.approve')}</button>` : ''}
        ${r.status !== 'rejected' ? html`<button type="button" class="btn ghost sm" data-act="reject" data-id="${r.id}">${t('admin.reviews.hide')}</button>` : ''}
        ${r.status === 'approved' ? html`<label class="check" style="margin-inline-start:auto"><input type="checkbox" class="switch" role="switch" data-feature="${r.id}" ${raw(r.featured ? 'checked' : '')}> <span>${t('admin.reviews.feature')}</span></label>` : ''}
      </div>
    </article>`;
}

function paint() {
  root.removeAttribute('aria-busy');
  const list = rows.filter((r) => r.status === tab);
  root.innerHTML = html`
    <div class="tabs" role="tablist" aria-label="${t('admin.reviews.title')}">
      ${TABS.map((s) => html`<button type="button" class="tab" role="tab" data-tab="${s}" aria-selected="${String(s === tab)}">${t(`admin.reviews.tab.${s}`)}<span class="count">${counts[s]}</span></button>`)}
    </div>
    ${list.length ? html`<div style="display:grid;gap:14px">${list.map(card)}</div>`
      : html`<div class="state state-empty"><p class="state-title">${t(`admin.reviews.empty.${tab}`)}</p></div>`}`.toString();
}

async function update(id, patch) {
  const { error } = await ctx.sb.from('reviews').update(patch).eq('id', id);
  if (error) throw toAppError(error);
}

root.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { tab = tabBtn.dataset.tab; history.replaceState(null, '', `?s=${tab}`); paint(); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  b.disabled = true;
  try {
    await update(b.dataset.id, { status: b.dataset.act === 'approve' ? 'approved' : 'rejected' });
    toast(t(b.dataset.act === 'approve' ? 'admin.reviews.approved' : 'admin.reviews.hidden'), { type: 'success' });
    await load();
  } catch (err) {
    toast(errorMessage(err), { type: 'error' });
    b.disabled = false;
  }
});
root.addEventListener('change', async (e) => {
  const f = e.target.closest('[data-feature]');
  if (!f) return;
  try {
    await update(f.dataset.feature, { featured: f.checked });
    toast(t(f.checked ? 'admin.reviews.featured' : 'admin.reviews.unfeatured'), { type: 'success' });
    const r = rows.find((x) => String(x.id) === f.dataset.feature);
    if (r) r.featured = f.checked;
  } catch (err) {
    f.checked = !f.checked;
    toast(errorMessage(err), { type: 'error' });
  }
});

load();
