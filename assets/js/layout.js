// Injects the storefront chrome (announcement bar, header, footer, WhatsApp button) on store and
// account pages. Pages provide <main id="main"> and may set <body data-page="home|shop|quiz|track|account|…">.
// Admin pages use their own sidebar layout and do not load this file.
import { STORAGE_KEYS, SITE_DATA_TTL_MS } from './config.js';
import { t, html, raw, formatPhone, ltr, getParam, installDigitNormalizer } from './utils.js';

// Loaded lazily so the header/footer still render if the Supabase CDN is unreachable.
const supabaseModule = import('./supabase.js').catch((err) => {
  console.error('[layout] Supabase client failed to load', err);
  return null;
});

const ICONS = {
  menu: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  user: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>',
  bag: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  whatsapp: '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.36 5.07L2 22l5.06-1.33A9.94 9.94 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2Zm0 18.2c-1.62 0-3.14-.44-4.45-1.2l-.32-.19-3.3.87.88-3.22-.21-.33A8.18 8.18 0 0 1 3.8 12c0-4.53 3.68-8.2 8.2-8.2s8.2 3.67 8.2 8.2-3.67 8.2-8.2 8.2Zm4.5-6.13c-.24-.12-1.44-.71-1.66-.79-.22-.08-.39-.12-.55.12-.16.24-.63.79-.78.95-.14.16-.28.18-.53.06-.24-.12-1.02-.38-1.95-1.21-.72-.64-1.2-1.44-1.35-1.68-.14-.24-.02-.37.11-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.42-.55-.42h-.47c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.7 2.6 4.13 3.64.58.25 1.03.4 1.38.51.58.18 1.11.16 1.53.1.47-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28Z"/></svg>',
};

const SOCIAL_KEYS = ['instagram', 'facebook', 'tiktok', 'snapchat'];

/* ---------- Site data (public settings + categories), cached per session ---------- */

function readSiteCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(STORAGE_KEYS.siteData) || 'null');
    return cached && Date.now() - cached.at < SITE_DATA_TTL_MS ? cached.data : null;
  } catch {
    return null;
  }
}

function writeSiteCache(data) {
  try {
    sessionStorage.setItem(STORAGE_KEYS.siteData, JSON.stringify({ at: Date.now(), data }));
  } catch { /* storage unavailable */ }
}

let siteDataPromise = null;

// { settings: { store_whatsapp, top_bar_messages, social_links } | null, categories: [{ slug, name_ar }] }
export function getSiteData() {
  if (!siteDataPromise) siteDataPromise = loadSiteData();
  return siteDataPromise;
}

async function loadSiteData() {
  const cached = readSiteCache();
  if (cached) return cached;
  const supa = await supabaseModule;
  if (!supa?.sb) return { settings: null, categories: [] };

  const [settings, categories] = await Promise.allSettled([
    supa.run(supa.sb.from('settings').select('store_whatsapp, top_bar_messages, social_links').limit(1).maybeSingle()),
    supa.run(supa.sb.from('categories').select('slug, name_ar').eq('active', true).order('sort')),
  ]);
  const data = {
    settings: settings.status === 'fulfilled' ? settings.value : null,
    categories: categories.status === 'fulfilled' ? categories.value ?? [] : [],
  };
  if (settings.status === 'fulfilled' && categories.status === 'fulfilled') writeSiteCache(data);
  return data;
}

/* ---------- Markup ---------- */

function headerMarkup() {
  return html`
    <a class="skip-link" href="#main">${t('header.skipToContent')}</a>
    <div class="marquee-bar" data-top-bar hidden aria-label="${t('header.announcements')}" role="region">
      <div class="marquee-track"></div>
    </div>
    <header class="site-header">
      <div class="nav-inner">
        <button type="button" class="icon-btn nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="${t('header.openMenu')}">${raw(ICONS.menu)}</button>
        <a class="brand" href="/">
          <span class="en">${t('meta.brand')}</span>
          <span class="ar">${t('meta.tagline')}</span>
        </a>
        <nav class="links" id="site-nav" aria-label="${t('header.mainNav')}">
          <a href="/" data-nav="home">${t('header.home')}</a>
          <span class="slot" data-slot="nav-categories"></span>
          <a href="/quiz.html" data-nav="quiz">${t('header.quiz')}</a>
          <a href="/track.html" data-nav="track">${t('header.track')}</a>
        </nav>
        <div class="nav-actions">
          <a class="nav-account" href="/account/login.html" data-account-link>
            ${raw(ICONS.user)}<span class="nav-account-label">${t('header.login')}</span>
          </a>
          <button type="button" class="icon-btn cart-btn" data-cart-open aria-label="${t('header.cart')}">
            ${raw(ICONS.bag)}<span class="cart-count" data-cart-count hidden>0</span>
          </button>
        </div>
      </div>
    </header>`;
}

function footerMarkup() {
  return html`
    <footer class="site-footer">
      <div class="wrap">
        <div class="foot-grid">
          <div class="foot-brand">
            <div class="en">${t('meta.brand')}</div>
            <p>${t('footer.about')}</p>
          </div>
          <div>
            <h2 class="foot-title">${t('footer.shopTitle')}</h2>
            <a href="/shop.html">${t('footer.allProducts')}</a>
            <span class="slot" data-slot="foot-categories"></span>
          </div>
          <div>
            <h2 class="foot-title">${t('footer.helpTitle')}</h2>
            <a href="/track.html">${t('footer.trackOrder')}</a>
            <a href="/returns.html">${t('footer.returns')}</a>
            <a href="/account/">${t('footer.myAccount')}</a>
          </div>
          <div data-slot="foot-contact" hidden>
            <h2 class="foot-title">${t('footer.contactTitle')}</h2>
          </div>
        </div>
        <div class="foot-bottom">${t('footer.rights', { year: new Date().getFullYear() })}</div>
      </div>
    </footer>
    <a class="wa-float" data-wa-float href="#" target="_blank" rel="noopener" aria-label="${t('whatsapp.floatLabel')}" hidden>${raw(ICONS.whatsapp)}</a>`;
}

/* ---------- Behaviour ---------- */

function currentNavKey() {
  const page = document.body.dataset.page || '';
  if (page === 'shop' && getParam('c')) return `cat:${getParam('c')}`;
  return page;
}

function markActiveNav() {
  const key = currentNavKey();
  document.querySelectorAll('.site-header [data-nav]').forEach((a) => {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function setupMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', t(open ? 'header.closeMenu' : 'header.openMenu'));
    toggle.innerHTML = open ? ICONS.close : ICONS.menu;
  };
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
}

export function readCartCount() {
  try {
    const items = JSON.parse(localStorage.getItem(STORAGE_KEYS.cart) || '[]');
    if (!Array.isArray(items)) return 0;
    return items.reduce((sum, item) => sum + (Number(item?.qty) > 0 ? Math.floor(Number(item.qty)) : 0), 0);
  } catch {
    return 0;
  }
}

export function refreshCartCount() {
  const count = readCartCount();
  const badge = document.querySelector('[data-cart-count]');
  const button = document.querySelector('[data-cart-open]');
  if (!badge || !button) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
  button.setAttribute('aria-label', count ? t('header.cartWithCount', { count }) : t('header.cart'));
}

function setupCart() {
  refreshCartCount();
  // The cart module dispatches 'cart:change' after every write; 'storage' covers other tabs.
  window.addEventListener('cart:change', refreshCartCount);
  window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEYS.cart) refreshCartCount(); });
  // A cart drawer (when present) listens for 'cart:open' and calls preventDefault(); otherwise go to checkout.
  document.querySelector('[data-cart-open]').addEventListener('click', () => {
    const opened = !window.dispatchEvent(new CustomEvent('cart:open', { cancelable: true }));
    if (!opened) location.href = '/checkout.html';
  });
}

function renderAccountLink(session) {
  const link = document.querySelector('[data-account-link]');
  if (!link) return;
  link.href = session ? '/account/' : '/account/login.html';
  link.querySelector('.nav-account-label').textContent = t(session ? 'header.account' : 'header.login');
  if (session && document.body.dataset.page === 'account') link.setAttribute('aria-current', 'page');
}

async function setupAccountLink() {
  const supa = await supabaseModule;
  if (!supa?.sb) return;
  renderAccountLink(await supa.getSession());
  supa.onAuthChange(renderAccountLink);
}

function renderCategories(categories) {
  const navLinks = categories.map((c) => html`<a href="/shop.html?c=${encodeURIComponent(c.slug)}" data-nav="cat:${c.slug}">${c.name_ar}</a>`);
  const footLinks = categories.map((c) => html`<a href="/shop.html?c=${encodeURIComponent(c.slug)}">${c.name_ar}</a>`);
  document.querySelector('[data-slot="nav-categories"]').innerHTML = html`${navLinks}`.toString();
  document.querySelector('[data-slot="foot-categories"]').innerHTML = html`${footLinks}`.toString();
  markActiveNav();
}

function renderTopBar(messages) {
  const items = (Array.isArray(messages) ? messages : []).map((m) => String(m ?? '').trim()).filter(Boolean);
  const bar = document.querySelector('[data-top-bar]');
  if (!items.length) return;
  const set = (hidden) => items.map((m) => html`<span ${raw(hidden ? 'aria-hidden="true"' : '')}>✦ ${m}</span>`);
  // Duplicated once so the marquee loops seamlessly; the copy is hidden from screen readers.
  bar.querySelector('.marquee-track').innerHTML = html`${set(false)}${set(true)}`.toString();
  bar.hidden = false;
}

function renderContact(settings) {
  const slot = document.querySelector('[data-slot="foot-contact"]');
  const whatsapp = String(settings?.store_whatsapp ?? '').replace(/\D/g, '');
  const social = settings?.social_links && typeof settings.social_links === 'object' ? settings.social_links : {};
  const socialLinks = SOCIAL_KEYS
    .filter((key) => /^https:\/\//.test(String(social[key] ?? '')))
    .map((key) => html`<a href="${social[key]}" target="_blank" rel="noopener">${t(`footer.social.${key}`)}</a>`);

  if (whatsapp) {
    const waFloat = document.querySelector('[data-wa-float]');
    waFloat.href = `https://wa.me/${whatsapp}?text=${encodeURIComponent(t('whatsapp.greeting'))}`;
    waFloat.hidden = false;
  }
  if (!whatsapp && !socialLinks.length) return;
  slot.insertAdjacentHTML('beforeend', html`
    ${whatsapp ? html`<a href="https://wa.me/${whatsapp}" target="_blank" rel="noopener">${t('footer.whatsapp')}: ${ltr(formatPhone(whatsapp))}</a>` : ''}
    ${socialLinks}`.toString());
  slot.hidden = false;
}

async function hydrateFromSiteData() {
  const { settings, categories } = await getSiteData();
  renderCategories(categories);
  renderTopBar(settings?.top_bar_messages);
  renderContact(settings);
}

/* ---------- Scroll reveal ---------- */

const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        revealObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.15 })
  : null;

// Call after rendering dynamic content that uses .reveal.
export function observeReveal(root = document) {
  root.querySelectorAll('.reveal:not(.in)').forEach((el) => {
    if (revealObserver) revealObserver.observe(el);
    else el.classList.add('in');
  });
}

/* ---------- Mount ---------- */

function mount() {
  const main = document.getElementById('main');
  if (main && !main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  document.body.insertAdjacentHTML('afterbegin', headerMarkup().toString());
  document.body.insertAdjacentHTML('beforeend', footerMarkup().toString());

  installDigitNormalizer();
  markActiveNav();
  setupMobileNav();
  setupCart();
  setupAccountLink();
  hydrateFromSiteData().catch((err) => console.error('[layout] site data', err));
  observeReveal();
}

mount();

