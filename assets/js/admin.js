// Admin shell shared by every /admin page: auth + role guard, sidebar / top bar, new-order
// notifications (Supabase Realtime + sound), small helpers.
// Real protection is RLS / RPC checks in Postgres; this only decides what the UI shows and redirects.
import { t, html, raw, toast, errorMessage, toAppError, applyStrings, showLoading, showError, formatDate } from './utils.js';
import { requireClient, getSession, run } from './supabase.js';
import { safeNext } from './account.js';

const SOUND_KEY = 'shami_admin_sound';

const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${d}</svg>`;
const ICONS = {
  dashboard: I('<path d="M4 13h7V4H4v9Zm9 7h7V11h-7v9ZM4 20h7v-5H4v5Zm9-11h7V4h-7v5Z"/>'),
  orders: I('<path d="M6 3h9l4 4v14H6V3Z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>'),
  menu: I('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  bell: I('<path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  store: I('<path d="M4 9l1-5h14l1 5M4 9v11h16V9M4 9a3 3 0 0 0 5.3 1.9A3 3 0 0 0 12 12a3 3 0 0 0 2.7-1.1A3 3 0 0 0 20 9"/>'),
};

// Pages appear in the sidebar when built (ready) — later admin pages are added here with their key
// in strings.admin.nav. `owner: true` hides the entry from staff.
export const NAV = [
  { key: 'dashboard', href: '/admin/', icon: 'dashboard', ready: true },
  { key: 'orders', href: '/admin/orders.html', icon: 'orders', ready: true, badge: true },
];

/* ---------- Shared helpers ---------- */

// "2026-10-26" for today in Asia/Amman (en-CA formats as YYYY-MM-DD)
export function ammanDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Start of an Amman calendar day as an ISO instant (no hard-coded UTC offset).
export function ammanDayStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Amman', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return new Date(guess - (asUtc - guess)).toISOString();
}

export const isOverdueCliq = (o, windowHours) =>
  o.payment_method === 'cliq' && ['awaiting_transfer', 'awaiting_verification'].includes(o.payment_status)
  && !['cancelled', 'returned'].includes(o.status)
  && Date.now() - new Date(o.created_at).getTime() > Number(windowHours || 24) * 3600000;

/* ---------- Guard + shell ---------- */

let ctx = null;
export const getCtx = () => ctx;

function redirectToLogin() {
  const here = location.pathname + location.search;
  location.replace(`/admin/login.html?next=${encodeURIComponent(here)}`);
  return new Promise(() => {});
}

export async function initAdmin({ page, ownerOnly = false, shell = true } = {}) {
  document.body.classList.add('admin', 'admin-pending');
  const sb = requireClient();
  const session = await getSession();
  if (!session) return redirectToLogin();

  let staff;
  try {
    staff = await run(sb.from('staff').select('role, active').eq('user_id', session.user.id).maybeSingle());
  } catch (err) {
    document.body.classList.remove('admin-pending');
    document.body.innerHTML = html`<main class="admin-content"><div class="state state-error" role="alert"><p class="state-title">${t('states.errorTitle')}</p>
      <p class="state-text">${t('admin.guardError')} ${errorMessage(err)}</p><button class="btn ghost" onclick="location.reload()">${t('common.retry')}</button></div></main>`.toString();
    return new Promise(() => {});
  }
  if (!staff || !staff.active) {
    await sb.auth.signOut().catch(() => {});
    location.replace('/admin/login.html?denied=1');
    return new Promise(() => {});
  }
  if (ownerOnly && staff.role !== 'owner') {
    location.replace('/admin/');
    return new Promise(() => {});
  }

  let cliqWindow = 24;
  try {
    const s = await run(sb.from('settings').select('cliq_window_hours').limit(1).maybeSingle());
    if (s?.cliq_window_hours) cliqWindow = s.cliq_window_hours;
  } catch { /* default 24 */ }

  ctx = { sb, session, role: staff.role, isOwner: staff.role === 'owner', userId: session.user.id, email: session.user.email, cliqWindow, page };
  applyStrings(document.getElementById('main'));
  if (shell) buildShell(ctx);
  document.body.classList.remove('admin-pending');
  if (shell) {
    startRealtime(ctx);
    refreshBadge();
    window.addEventListener('admin:orders-changed', refreshBadge);
  }
  return ctx;
}

function buildShell(c) {
  const main = document.getElementById('main');
  const links = NAV.filter((n) => n.ready && (!n.owner || c.isOwner));
  const shell = document.createElement('div');
  shell.className = 'admin-shell';
  shell.innerHTML = html`
    <aside class="admin-sidebar" id="admin-sidebar" aria-label="${t('admin.menu')}">
      <div class="admin-brand"><span class="en">${t('meta.brand')}</span><span class="ar">${t('admin.brandSub')}</span></div>
      <div class="admin-nav-group">${t('admin.navMain')}</div>
      <nav class="admin-nav">
        ${links.map((n) => html`<a href="${n.href}" ${raw(n.key === c.page ? 'aria-current="page"' : '')}>${raw(ICONS[n.icon] || '')}<span>${t(`admin.nav.${n.key}`)}</span>${n.badge ? html`<span class="count" data-nav-badge hidden>0</span>` : ''}</a>`)}
      </nav>
      <div class="admin-nav-group">${t('admin.navShop')}</div>
      <nav class="admin-nav"><a href="/" target="_blank" rel="noopener">${raw(ICONS.store)}<span>${t('meta.brand')}</span></a></nav>
      <div class="admin-sidebar-foot">
        <div class="who" dir="ltr">${c.email}</div>
        <div class="role">${t(c.isOwner ? 'admin.roleOwner' : 'admin.roleStaff')}</div>
        <button type="button" data-admin-logout>${t('admin.logout')}</button>
      </div>
    </aside>
    <div class="admin-backdrop" data-admin-backdrop></div>
    <div class="admin-main">
      <header class="admin-topbar">
        <button type="button" class="icon-btn sidebar-toggle" data-admin-toggle aria-expanded="false" aria-controls="admin-sidebar" aria-label="${t('admin.menu')}">${raw(ICONS.menu)}</button>
        <span class="title" data-admin-title></span>
        <span class="spacer"></span>
        <span class="live-dot" data-live-dot title="${t('admin.live.offline')}" role="status" aria-label="${t('admin.live.offline')}"></span>
        <button type="button" class="btn ghost sm" data-sound-toggle aria-pressed="true">${raw(ICONS.bell)}<span data-sound-label></span></button>
      </header>
    </div>`.toString();
  document.body.prepend(shell);
  shell.querySelector('.admin-main').append(main);
  main.classList.add('admin-content');
  const titleKey = `admin.nav.${c.page}`;
  const heading = main.querySelector('h1');
  shell.querySelector('[data-admin-title]').textContent = heading ? heading.textContent : (t(titleKey) !== titleKey ? t(titleKey) : '');

  const setOpen = (open) => {
    shell.classList.toggle('nav-open', open);
    shell.querySelector('[data-admin-toggle]').setAttribute('aria-expanded', String(open));
  };
  shell.querySelector('[data-admin-toggle]').addEventListener('click', () => setOpen(!shell.classList.contains('nav-open')));
  shell.querySelector('[data-admin-backdrop]').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  shell.querySelector('[data-admin-logout]').addEventListener('click', async () => {
    await c.sb.auth.signOut().catch(() => {});
    location.assign('/admin/login.html');
  });
  setupSoundToggle(shell);
}

/* ---------- Sidebar badge ---------- */

export async function refreshBadge() {
  const badge = document.querySelector('[data-nav-badge]');
  if (!badge || !ctx) return;
  try {
    const { count, error } = await ctx.sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'new');
    if (error) throw error;
    badge.textContent = String(count ?? 0);
    badge.hidden = !count;
  } catch { /* the badge is a convenience */ }
}

/* ---------- Sound + Realtime ---------- */

let audio = null;
const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };

function ensureAudio() {
  if (!audio) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audio = new Ctor();
  }
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}

// Browsers only allow audio after a user gesture: the first click anywhere unlocks it.
document.addEventListener('click', () => ensureAudio(), { once: true });

export function playBeep() {
  const a = ensureAudio();
  if (!a || a.state !== 'running') return false;
  [880, 1175].forEach((freq, i) => {
    const osc = a.createOscillator();
    const gain = a.createGain();
    const start = a.currentTime + i * 0.18;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
    osc.connect(gain).connect(a.destination);
    osc.start(start);
    osc.stop(start + 0.3);
  });
  return true;
}

function setupSoundToggle(shell) {
  const btn = shell.querySelector('[data-sound-toggle]');
  const paint = () => {
    const on = soundOn();
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('[data-sound-label]').textContent = t(on ? 'admin.live.soundOn' : 'admin.live.soundOff');
  };
  btn.addEventListener('click', () => {
    try { localStorage.setItem(SOUND_KEY, soundOn() ? 'off' : 'on'); } catch { /* not persisted */ }
    paint();
    if (soundOn()) playBeep();
  });
  paint();
}

function setLive(connected) {
  const dot = document.querySelector('[data-live-dot]');
  if (!dot) return;
  dot.classList.toggle('is-on', connected);
  const label = t(connected ? 'admin.live.online' : 'admin.live.offline');
  dot.title = label;
  dot.setAttribute('aria-label', label);
}

function notifyNewOrder(order) {
  if (soundOn()) playBeep();
  let stack = document.querySelector('.toast-stack');
  if (!stack) { stack = document.createElement('div'); stack.className = 'toast-stack'; document.body.append(stack); }
  const el = document.createElement('div');
  el.className = 'toast success';
  el.setAttribute('role', 'status');
  el.innerHTML = html`<span class="toast-msg">${t('admin.live.newOrder', { number: order.order_number, name: order.customer_name })}
    <a class="link-inline" href="/admin/order.html?id=${encodeURIComponent(order.id)}">${t('admin.live.open')}</a></span>
    <button type="button" class="toast-close" aria-label="${t('common.close')}">×</button>`.toString();
  el.querySelector('.toast-close').addEventListener('click', () => el.remove());
  stack.append(el);
  setTimeout(() => el.remove(), 15000);
}

// postgres_changes is filtered by the orders RLS policy for THIS user's JWT: only staff (and an order's
// own customer) are ever sent a row. The payload is used for display only; pages re-read from the API.
function startRealtime(c) {
  c.sb.channel('admin-orders')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (payload) => {
      const order = payload.new;
      if (!order?.id) return;
      notifyNewOrder(order);
      refreshBadge();
      window.dispatchEvent(new CustomEvent('admin:new-order', { detail: order }));
    })
    .subscribe((status) => setLive(status === 'SUBSCRIBED'));
}

// Modal with a form body. Resolves with the FormData when confirmed, or null when dismissed.
export function formDialog({ title, body, confirmLabel = t('common.confirm'), danger = false }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.setAttribute('aria-labelledby', 'fd-title');
    dialog.innerHTML = html`
      <form method="dialog">
        <div class="modal-head"><h2 class="modal-title" id="fd-title">${title}</h2></div>
        <div class="modal-body form">${body}</div>
        <div class="modal-foot">
          <button type="submit" value="cancel" class="btn ghost sm">${t('common.cancel')}</button>
          <button type="submit" value="ok" class="btn ${danger ? 'danger' : 'primary'} sm">${confirmLabel}</button>
        </div>
      </form>`.toString();
    const form = dialog.querySelector('form');
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'ok' ? new FormData(form) : null); dialog.remove(); });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close('cancel'); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export { t, html, raw, toast, errorMessage, toAppError, applyStrings, showLoading, showError, formatDate, safeNext };
