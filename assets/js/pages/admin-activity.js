// /admin/activity.html (owner) — who changed what: order status, payments, stock, prices, settings,
// staff, catalog, offers, coupons, delivery, customer accounts. Data: activity_feed() RPC (owner-only).
import { initAdmin, ammanDayStart } from '../admin.js';
import { t, strings, html, raw, ltr, formatDate, showLoading, showError, showEmpty, debounce } from '../utils.js';
import { rpc } from '../supabase.js';

const ctx = await initAdmin({ page: 'activity', ownerOnly: true });
document.title = t('admin.activity.meta');
const root = document.querySelector('[data-slot="activity"]');
const PAGE = 50;
const CATS = ['order', 'payment', 'stock', 'price', 'settings', 'staff', 'catalog', 'offer', 'coupon', 'delivery', 'customer'];
const f = { category: '', actor: '', from: '', to: '', q: '' };
let rows = [];
let more = false;
let seq = 0;

const nextDay = (d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const opt = (v, label, cur) => html`<option value="${v}" ${raw(String(cur) === String(v) ? 'selected' : '')}>${label}</option>`;

async function shell() {
  let staff = [];
  try { staff = await rpc('staff_names'); } catch { /* actor filter stays empty */ }
  root.innerHTML = html`
    <form class="toolbar" data-filters role="search">
      <label class="sr-only" for="a-cat">${t('admin.activity.category')}</label>
      <select class="select" id="a-cat" name="category"><option value="">${t('admin.activity.category')}: ${t('admin.activity.allCategories')}</option>${CATS.map((c) => opt(c, t(`admin.activity.cat.${c}`), f.category))}</select>
      <label class="sr-only" for="a-actor">${t('admin.activity.actor')}</label>
      <select class="select" id="a-actor" name="actor"><option value="">${t('admin.activity.actor')}: ${t('admin.activity.allActors')}</option>${staff.map((s) => opt(s.user_id, s.display_name, f.actor))}</select>
      <label class="label" for="a-from">${t('admin.activity.from')}</label><input class="input" id="a-from" type="date" name="from" value="${f.from}">
      <label class="label" for="a-to">${t('admin.activity.to')}</label><input class="input" id="a-to" type="date" name="to" value="${f.to}">
      <div class="grow"><label class="sr-only" for="a-q">${t('admin.activity.search')}</label>
        <input class="input" id="a-q" type="search" name="q" value="${f.q}" placeholder="${t('admin.activity.searchPlaceholder')}" autocomplete="off"></div>
      <button type="button" class="btn ghost sm" data-clear>${t('admin.activity.clear')}</button>
    </form>
    <div data-list aria-live="polite"></div>`.toString();
  const form = root.querySelector('[data-filters]');
  const read = () => {
    const d = new FormData(form);
    Object.assign(f, { category: d.get('category') || '', actor: d.get('actor') || '', from: d.get('from') || '', to: d.get('to') || '', q: String(d.get('q') || '').trim() });
    load(true);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); read(); });
  form.addEventListener('change', read);
  form.elements.q.addEventListener('input', debounce(read, 400));
  form.querySelector('[data-clear]').addEventListener('click', () => { form.reset(); form.querySelectorAll('select, input').forEach((el) => { el.value = ''; }); read(); });
  root.querySelector('[data-list]').addEventListener('click', (e) => { if (e.target.closest('[data-more]')) load(false); });
}

async function load(reset) {
  const mine = ++seq;
  const list = root.querySelector('[data-list]');
  if (reset) { rows = []; showLoading(list); }
  try {
    const batch = await rpc('activity_feed', {
      p_category: f.category,
      p_actor: f.actor || null,
      p_from: DATE_RE.test(f.from) ? ammanDayStart(f.from) : null,
      p_to: DATE_RE.test(f.to) ? ammanDayStart(nextDay(f.to)) : null,
      p_search: f.q,
      p_limit: PAGE,
      p_offset: rows.length,
    });
    if (mine !== seq) return;
    rows = rows.concat(batch);
    more = batch.length === PAGE;
    paint(list);
  } catch (err) {
    if (mine === seq) showError(list, { error: err, onRetry: () => load(reset) });
  }
}

/* ---------- Describing an event in Arabic ---------- */

const fieldName = (k) => strings.admin.activity.fields[k] ?? k;
const statusName = (s) => (s ? t(`order.statuses.${s}`) : '—');
const payName = (s) => (s ? t(`order.payStatuses.${s}`) : '—');

function valueText(v) {
  if (v === null || v === undefined || v === '') return t('admin.activity.empty');
  if (typeof v === 'boolean') return t(v ? 'admin.activity.yes' : 'admin.activity.no');
  if (Array.isArray(v)) return v.join('، ') || t('admin.activity.empty');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDate(v);
  return String(v);
}

function changesHtml(changes) {
  return html`<ul class="act-changes" style="margin:4px 0 0;padding-inline-start:18px">${Object.entries(changes).map(([k, c]) =>
    html`<li><strong>${fieldName(k)}:</strong> ${ltr(valueText(c.from))} ← ${ltr(valueText(c.to))}</li>`)}</ul>`;
}

function describe(e) {
  const d = e.details || {};
  switch (e.category) {
    case 'order': return html`${d.from ? t('admin.activity.statusChange', { from: statusName(d.from), to: statusName(d.to) }) : t('admin.activity.statusCreated', { to: statusName(d.to) })}${d.note ? html`<div class="cell-sub">${d.note}</div>` : ''}`;
    case 'payment': return html`${t('admin.activity.paymentChange', { from: payName(d.from), to: payName(d.to) })}${d.note ? html`<div class="cell-sub">${d.note}</div>` : ''}`;
    case 'stock': return html`${t('admin.activity.stockChange', { reason: t(`admin.activity.stockReason.${e.action}`), change: d.change > 0 ? `+${d.change}` : String(d.change), balance: d.balance_after })}${d.note ? html`<div class="cell-sub">${d.note}</div>` : ''}`;
    default: {
      const named = { create_staff: 'createStaff', reset_password: 'resetPassword', edit_staff: 'editStaff', disable_customer: 'disableCustomer', enable_customer: 'enableCustomer', promote: 'promote', insert: 'created', update: 'updated', delete: 'deleted' }[e.action];
      return html`${t(`admin.activity.${named}`)}${d.changes ? changesHtml(d.changes) : ''}${d.price !== undefined && e.action === 'insert' ? html`<div class="cell-sub">${t('admin.activity.fields.price')}: ${ltr(valueText(d.price))}</div>` : ''}`;
    }
  }
}

function actorName(e) {
  if (e.by_customer) return t('admin.activity.customer');
  return e.actor_name || t('admin.activity.system');
}

function targetText(e) {
  const kind = e.category === 'order' || e.category === 'payment' ? '' : (t(`admin.activity.entity.${e.entity_type}`) || '');
  return html`${kind ? html`<span class="cell-sub">${kind}</span><br>` : ''}${e.label ? (e.category === 'order' || e.category === 'payment' ? ltr(e.label) : e.label) : ''}`;
}

function paint(list) {
  if (!rows.length) { showEmpty(list, { title: t('admin.activity.emptyTitle') }); return; }
  list.removeAttribute('aria-busy');
  list.innerHTML = html`
    <div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>${t('admin.activity.when')}</th><th>${t('admin.activity.who')}</th><th>${t('admin.activity.category')}</th><th>${t('admin.activity.what')}</th><th>${t('admin.activity.target')}</th></tr></thead>
      <tbody>${rows.map((e) => html`<tr>
        <td class="cell-sub">${formatDate(e.created_at)}</td>
        <td>${actorName(e)}</td>
        <td><span class="badge info">${t(`admin.activity.cat.${e.category}`)}</span></td>
        <td>${describe(e)}</td>
        <td>${targetText(e)}</td></tr>`)}</tbody>
    </table></div>
    ${more ? html`<p style="text-align:center;margin-top:12px"><button type="button" class="btn ghost" data-more>${t('admin.activity.loadMore')}</button></p>` : ''}`.toString();
}

await shell();
load(true);
