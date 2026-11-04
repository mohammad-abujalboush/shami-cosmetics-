// /admin/customers.html — owner + staff (read-only for staff). Two lists:
//   registered accounts (orders count, total spent, last order) and guest orders grouped by phone.
// Detail view: orders + addresses. Owner can disable / enable a customer account (Edge Function admin-users).
import { initAdmin } from '../admin.js';
import { t, html, raw, ltr, formatPrice, formatDate, formatPhone, showLoading, showEmpty, showError, toast, errorMessage,
         confirmDialog, debounce } from '../utils.js';
import { rpc } from '../supabase.js';
import { callAdminUsers } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'customers' });
document.title = t('admin.customers.meta');
const root = document.querySelector('[data-slot="customers"]');
const PAGE = 25;
const f = { kind: 'registered', q: '', page: 1 };
let seq = 0;

/* ---------- List ---------- */

function shell() {
  root.innerHTML = html`
    <div class="tabs" role="tablist">
      ${['registered', 'guests'].map((k) => html`<button type="button" class="tab" role="tab" data-kind="${k}" aria-selected="${k === f.kind}">${t(`admin.customers.tab${k === 'registered' ? 'Registered' : 'Guests'}`)}</button>`)}
    </div>
    <form class="toolbar" role="search" data-search>
      <div class="grow"><label class="sr-only" for="c-q">${t('admin.customers.search')}</label>
        <input class="input" id="c-q" type="search" value="${f.q}" autocomplete="off" placeholder="${t(f.kind === 'guests' ? 'admin.customers.searchPlaceholderGuests' : 'admin.customers.searchPlaceholder')}"></div>
    </form>
    <p class="hint" data-count aria-live="polite"></p>
    <div data-list aria-live="polite"></div>`.toString();
  const form = root.querySelector('[data-search]');
  form.addEventListener('submit', (e) => e.preventDefault());
  root.querySelector('#c-q').addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); f.page = 1; loadList(); }, 350));
  root.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (b && b.dataset.kind !== f.kind) { f.kind = b.dataset.kind; f.q = ''; f.page = 1; shell(); loadList(); }
  });
  root.querySelector('[data-list]').addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go && !go.disabled) { f.page = Number(go.dataset.goto); loadList(); return; }
    const row = e.target.closest('[data-open]');
    if (row) openDetail(row.dataset.open);
  });
}

async function loadList() {
  const mine = ++seq;
  const list = root.querySelector('[data-list]');
  showLoading(list);
  try {
    const res = await rpc('list_customers', { p_kind: f.kind, p_search: f.q, p_limit: PAGE, p_offset: (f.page - 1) * PAGE });
    if (mine !== seq) return;
    root.querySelector('[data-count]').textContent = t('admin.customers.count', { n: res.total });
    if (!res.rows.length) { showEmpty(list, { title: t('admin.customers.emptyTitle') }); return; }
    list.removeAttribute('aria-busy');
    const guests = f.kind === 'guests';
    const pages = Math.max(1, Math.ceil(res.total / PAGE));
    list.innerHTML = html`
      <div class="data-table-wrap"><table class="data-table">
        <thead><tr><th>${t('admin.customers.name')}</th><th>${t('admin.customers.phone')}</th>${guests ? '' : html`<th>${t('admin.customers.email')}</th>`}
          <th>${t('admin.customers.orders')}</th><th>${t('admin.customers.spent')}</th><th>${t('admin.customers.lastOrder')}</th><th class="actions"></th></tr></thead>
        <tbody>${res.rows.map((r) => html`
          <tr class="${r.disabled ? 'is-muted' : ''}">
            <td class="cell-main">${r.name || t('admin.customers.noName')}
              ${r.disabled ? html` <span class="badge danger">${t('admin.customers.disabled')}</span>` : ''}
              ${guests && r.orders_count > 1 ? html` <span class="badge gold">${t('admin.customers.repeat')}</span>` : ''}</td>
            <td>${r.phone ? ltr(formatPhone(r.phone)) : '—'}</td>
            ${guests ? '' : html`<td>${ltr(r.email)}</td>`}
            <td>${r.orders_count}</td>
            <td>${formatPrice(r.total_spent)}</td>
            <td class="cell-sub">${r.last_order_at ? formatDate(r.last_order_at, { time: false }) : '—'}</td>
            <td class="actions"><button type="button" class="btn ghost sm" data-open="${guests ? r.phone : r.user_id}">${t('admin.customers.details')}</button></td>
          </tr>`)}</tbody>
      </table></div>
      <p class="hint">${t('admin.customers.totalNote')}</p>
      ${pages > 1 ? html`<div class="pager" style="display:flex;gap:8px;justify-content:center;margin-top:12px">
        <button type="button" class="btn ghost sm" data-goto="${f.page - 1}" ${raw(f.page <= 1 ? 'disabled' : '')}>${t('common.prev')}</button>
        <span class="cell-sub" style="align-self:center">${f.page} / ${pages}</span>
        <button type="button" class="btn ghost sm" data-goto="${f.page + 1}" ${raw(f.page >= pages ? 'disabled' : '')}>${t('common.next')}</button></div>` : ''}`.toString();
  } catch (err) {
    if (mine === seq) showError(list, { error: err, onRetry: loadList });
  }
}

/* ---------- Detail ---------- */

async function openDetail(key) {
  const guest = f.kind === 'guests';
  showLoading(root);
  try {
    const d = await rpc('customer_detail', guest ? { p_user_id: null, p_phone: key } : { p_user_id: key, p_phone: null });
    paintDetail(d, guest);
  } catch (err) {
    showError(root, { error: err, onRetry: () => openDetail(key) });
  }
}

function paintDetail(d, guest) {
  const p = d.profile;
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <p><button type="button" class="btn ghost sm" data-back>${t('admin.customers.back')}</button></p>
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${p.name || t('admin.customers.noName')}
        ${p.disabled ? html` <span class="badge danger">${t('admin.customers.disabled')}</span>` : ''}</h2>
      ${!guest && ctx.isOwner ? html`<button type="button" class="btn ${p.disabled ? 'primary' : 'danger'} sm" data-toggle>${t(p.disabled ? 'admin.customers.enable' : 'admin.customers.disable')}</button>` : ''}</div>
      <div class="panel-body">
        <p style="margin:0">${p.phone ? ltr(formatPhone(p.phone)) : '—'}${p.email ? html` · ${ltr(p.email)}` : ''}</p>
        ${p.created_at ? html`<p class="hint">${t('admin.customers.since')}: ${formatDate(p.created_at, { time: false })}</p>` : ''}
      </div></section>
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.customers.ordersTitle')} (${d.orders.length})</h2></div>
      <div class="panel-body flush">${d.orders.length ? html`<div class="data-table-wrap"><table class="data-table"><tbody>
        ${d.orders.map((o) => html`<tr>
          <td><a class="cell-main link-inline" href="/admin/order.html?id=${o.id}">${ltr(o.order_number)}</a></td>
          <td><span class="badge info">${t(`order.statuses.${o.status}`)}</span></td>
          <td>${t(`order.payStatuses.${o.payment_status}`)}</td>
          <td>${formatPrice(o.total)}</td>
          <td class="cell-sub">${formatDate(o.created_at)}</td></tr>`)}
      </tbody></table></div>` : html`<p class="panel-body hint">${t('admin.customers.noOrders')}</p>`}</div></section>
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.customers.addressesTitle')}</h2></div>
      <div class="panel-body">
        ${guest && d.addresses.length ? html`<p class="hint">${t('admin.customers.guestAddressesNote')}</p>` : ''}
        ${d.addresses.length ? html`<ul style="margin:0;padding-inline-start:18px">${d.addresses.map((a) => html`
          <li>${[a.governorate_name, a.area, a.address_details].filter(Boolean).join('، ')}
            ${a.is_default ? html` <span class="badge gold">${t('admin.customers.defaultAddress')}</span>` : ''}
            ${a.phone ? html` <span class="cell-sub">${ltr(formatPhone(a.phone))}</span>` : ''}</li>`)}</ul>`
          : html`<p class="hint" style="margin:0">${t('admin.customers.noAddresses')}</p>`}
      </div></section>`.toString();
  root.querySelector('[data-back]').addEventListener('click', () => { shell(); loadList(); });
  root.querySelector('[data-toggle]')?.addEventListener('click', () => toggleDisabled(p));
}

async function toggleDisabled(p) {
  const disable = !p.disabled;
  if (disable && !(await confirmDialog({ message: t('admin.customers.disableConfirm', { name: p.name || p.email }), confirmLabel: t('admin.customers.disable'), danger: true }))) return;
  try {
    await callAdminUsers('set_customer_disabled', { user_id: p.user_id, disabled: disable });
    toast(t(disable ? 'admin.customers.disabledDone' : 'admin.customers.enabledDone'), { type: 'success' });
    openDetail(p.user_id);
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
}

shell();
loadList();
