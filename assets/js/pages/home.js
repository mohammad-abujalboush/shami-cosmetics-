// Home: categories, running bundle offers (real countdown), bestsellers, perfumes with gender
// filter, homepage stats from settings, featured approved reviews. Every data section has
// loading / empty / error handling; sections with no data stay hidden (no placeholder data).
import { getSiteData, observeReveal } from '../layout.js';
import { t, html, raw, formatPrice, formatNumber, showError, errorMessage } from '../utils.js';
import { queryCatalog, productCards, skeletonCards, starsHtml } from '../catalog.js';

const $ = (sel) => document.querySelector(sel);
const section = (name) => $(`[data-section="${name}"]`);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const db = async () => (await import('../supabase.js')).requireClient();

const CATEGORY_ICONS = {
  soap: '<rect x="10" y="16" width="28" height="22" rx="6"/><path d="M16 16c0-6 4-9 8-9s8 3 8 9"/>',
  twins_unity: '<rect x="16" y="14" width="16" height="26" rx="4"/><rect x="20" y="8" width="8" height="7" rx="2"/>',
  twins_perfumes: '<path d="M24 6c4 6 10 11 10 19a10 10 0 0 1-20 0c0-8 6-13 10-19Z"/>',
  gift_boxes: '<rect x="8" y="18" width="32" height="22" rx="3"/><path d="M8 26h32"/><path d="M24 18v22"/><path d="M18 18c0-4 2-7 6-7s6 3 6 7"/>',
};

/* ---------- Categories ---------- */
function renderCategories(categories) {
  if (!categories.length) return;
  $('[data-slot="categories"]').innerHTML = html`${categories.map((c, i) => html`
    <a class="cat-card reveal ${i % 4 ? `d${i % 4}` : ''}" href="/shop.html?c=${encodeURIComponent(c.slug)}">
      <svg class="ic" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${raw(CATEGORY_ICONS[c.key] || CATEGORY_ICONS.gift_boxes)}</svg>
      <h3>${c.name_ar}</h3>
      ${c.description_ar ? html`<span>${c.description_ar}</span>` : ''}
    </a>`)}`.toString();
  section('categories').hidden = false;
}

/* ---------- Offers + countdown ---------- */
const pad = (n) => String(n).padStart(2, '0');

function startCountdown(root, endsAt) {
  const end = new Date(endsAt).getTime();
  const units = {
    d: root.querySelector('[data-cd="d"]'), h: root.querySelector('[data-cd="h"]'),
    m: root.querySelector('[data-cd="m"]'), s: root.querySelector('[data-cd="s"]'),
  };
  const tick = () => {
    const diff = end - Date.now();
    if (diff <= 0) {
      // The offer really ended: remove it (and the section if it was the last one)
      root.closest('.offer').remove();
      if (!document.querySelector('[data-slot="offers"] .offer')) section('offer').hidden = true;
      clearInterval(timer);
      return;
    }
    units.d.textContent = pad(Math.floor(diff / 86400000));
    units.h.textContent = pad(Math.floor((diff % 86400000) / 3600000));
    units.m.textContent = pad(Math.floor((diff % 3600000) / 60000));
    units.s.textContent = pad(Math.floor((diff % 60000) / 1000));
  };
  const timer = setInterval(tick, 1000);
  tick();
}

async function loadOffers() {
  const sb = await db();
  const { data, error } = await sb.from('offers')
    .select('id, name_ar, description_ar, quantity, bundle_price, ends_at, show_countdown, categories ( slug, name_ar )')
    .order('ends_at');
  if (error) throw error;
  const offers = (data || []).filter((o) => new Date(o.ends_at).getTime() > Date.now());
  if (!offers.length) return;

  $('[data-slot="offers"]').innerHTML = html`${offers.map((o) => html`
    <div class="offer reveal">
      <div class="offer-text">
        <p class="kicker">${t('home.offerKicker')}</p>
        <h3>${o.name_ar}</h3>
        <p class="offer-details">${t('home.offerDetails', { n: formatNumber(o.quantity), category: o.categories?.name_ar || '', price: formatPrice(o.bundle_price) })}</p>
        ${o.description_ar ? html`<p>${o.description_ar}</p>` : ''}
        ${o.show_countdown ? html`
          <div class="countdown" role="timer" aria-label="${t('home.offerTimerLabel')}" data-ends="${o.ends_at}">
            <div class="cd-unit"><div class="n" data-cd="d">00</div><div class="l">${t('home.cdDays')}</div></div>
            <div class="cd-unit"><div class="n" data-cd="h">00</div><div class="l">${t('home.cdHours')}</div></div>
            <div class="cd-unit"><div class="n" data-cd="m">00</div><div class="l">${t('home.cdMinutes')}</div></div>
            <div class="cd-unit"><div class="n" data-cd="s">00</div><div class="l">${t('home.cdSeconds')}</div></div>
          </div>` : ''}
        ${o.categories?.slug ? html`<a class="btn light" href="/shop.html?c=${encodeURIComponent(o.categories.slug)}">${t('home.offerCta')}</a>` : ''}
      </div>
      <div class="offer-visual" aria-hidden="true">
        <div class="ring r1"></div><div class="ring r2"></div>
        <svg viewBox="0 0 120 120" fill="none" focusable="false">
          <rect x="30" y="40" width="60" height="60" rx="14" fill="#D9B96C" opacity="0.9"/>
          <path d="M42 40c0-14 8-22 18-22s18 8 18 22" stroke="#FBF8F2" stroke-width="3" fill="none"/>
        </svg>
      </div>
    </div>`)}`.toString();
  section('offer').hidden = false;
  document.querySelectorAll('[data-slot="offers"] .countdown').forEach((el) => startCountdown(el, el.dataset.ends));
}

/* ---------- Product grids ---------- */
async function loadGrid(slot, opts, { hideSectionIfEmpty = null, emptyText = '' } = {}) {
  const el = $(`[data-slot="${slot}"]`);
  el.setAttribute('aria-busy', 'true');
  el.innerHTML = skeletonCards(3).toString();
  try {
    const { rows } = await queryCatalog(opts);
    el.removeAttribute('aria-busy');
    if (!rows.length) {
      if (hideSectionIfEmpty) { section(hideSectionIfEmpty).hidden = true; return; }
      el.innerHTML = html`<p class="state-text muted text-center" style="grid-column:1/-1">${emptyText}</p>`.toString();
      return;
    }
    el.innerHTML = productCards(rows, (p, i) => ({ reveal: `reveal ${i % 3 ? `d${i % 3}` : ''}` })).toString();
    observeReveal(el);
  } catch (err) {
    el.removeAttribute('aria-busy');
    el.innerHTML = '';
    const box = document.createElement('div');
    box.style.gridColumn = '1 / -1';
    el.append(box);
    showError(box, { message: `${t('catalog.sectionError')} ${errorMessage(err)}`, onRetry: () => loadGrid(slot, opts, { hideSectionIfEmpty, emptyText }) });
  }
}

function setupPerfumes(categories) {
  const perfumes = categories.find((c) => c.key === 'twins_perfumes');
  if (!perfumes) { section('perfumes').hidden = true; return; }
  $('[data-slot="perfumes-link"]').href = `/shop.html?c=${encodeURIComponent(perfumes.slug)}`;
  const chips = [...document.querySelectorAll('[data-section="perfumes"] [data-gender]')];
  const load = (gender) => loadGrid('perfumes', { categoryKey: 'twins_perfumes', gender, sort: 'best', limit: 6 },
    { hideSectionIfEmpty: gender ? null : 'perfumes', emptyText: t('home.perfumesEmpty') });
  chips.forEach((chip) => chip.addEventListener('click', () => {
    chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    load(chip.dataset.gender || null);
  }));
  load(null);
}

/* ---------- Stats (settings.homepage_stats, show flags respected) ---------- */
function renderStats(stats) {
  const items = (Array.isArray(stats) ? stats : [])
    .filter((s) => s && s.show !== false && String(s.label_ar ?? '').trim() && String(s.value ?? '').trim() !== '');
  if (!items.length) return;
  const grid = $('[data-slot="stats"]');
  grid.style.setProperty('--cols', Math.min(items.length, 4));
  grid.innerHTML = html`${items.map((s, i) => html`
    <div class="trust-cell reveal ${i % 4 ? `d${i % 4}` : ''}">
      <div class="num-big" data-value="${s.value}">${s.value}</div>
      <div class="lbl">${s.label_ar}</div>
    </div>`)}`.toString();
  section('stats').hidden = false;
  if (!reducedMotion) countUp(grid);
}

// Animate purely numeric values ("4.9", "70") when they scroll into view; text values stay as they are.
function countUp(grid) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      const raw_ = String(e.target.dataset.value).trim();
      if (!/^\d+(\.\d+)?$/.test(raw_)) return;
      const target = Number(raw_);
      const decimals = (raw_.split('.')[1] || '').length;
      const start = performance.now();
      const step = (now) => {
        const p = Math.min((now - start) / 1300, 1);
        e.target.textContent = (target * (1 - (1 - p) ** 3)).toFixed(decimals);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, { threshold: 0.4 });
  grid.querySelectorAll('[data-value]').forEach((el) => io.observe(el));
}

/* ---------- Featured reviews carousel ---------- */
async function loadReviews() {
  const sb = await db();
  const { data, error } = await sb.from('reviews')
    .select('id, rating, body, display_name, governorate_name')
    .eq('status', 'approved').eq('featured', true)
    .order('created_at', { ascending: false })
    .limit(6);
  if (error) throw error;
  const reviews = (data || []).filter((r) => String(r.body ?? '').trim());
  if (!reviews.length) return;

  const slot = $('[data-slot="reviews"]');
  slot.innerHTML = html`
    <div class="testi-wrap">
      ${reviews.map((r, i) => html`
        <figure class="testi ${i === 0 ? 'active' : ''}" data-i="${i}" ${raw(i === 0 ? '' : 'aria-hidden="true"')}>
          ${starsHtml(r.rating)}
          <blockquote>«${r.body}»</blockquote>
          <figcaption class="who">— ${[r.display_name, r.governorate_name].filter(Boolean).join('، ')}</figcaption>
        </figure>`)}
    </div>
    ${reviews.length > 1 ? html`
      <div class="dots" role="group" aria-label="${t('home.reviewsNav')}">
        ${reviews.map((_, i) => html`<button type="button" class="dot-btn" data-i="${i}" aria-label="${t('home.reviewDot', { n: i + 1 })}" aria-current="${String(i === 0)}"></button>`)}
      </div>` : ''}`.toString();
  section('reviews').hidden = false;
  if (reviews.length < 2) return;

  const slides = [...slot.querySelectorAll('.testi')];
  const dots = [...slot.querySelectorAll('.dot-btn')];
  let current = 0;
  const show = (i) => {
    slides.forEach((s, j) => { s.classList.toggle('active', j === i); s.toggleAttribute('aria-hidden', j !== i); });
    dots.forEach((d, j) => d.setAttribute('aria-current', String(j === i)));
    current = i;
  };
  dots.forEach((d) => d.addEventListener('click', () => show(Number(d.dataset.i))));
  if (reducedMotion) return;
  // Auto-advance, paused while hovered or focused
  let paused = false;
  slot.addEventListener('mouseenter', () => { paused = true; });
  slot.addEventListener('mouseleave', () => { paused = false; });
  slot.addEventListener('focusin', () => { paused = true; });
  slot.addEventListener('focusout', () => { paused = false; });
  setInterval(() => { if (!paused && !document.hidden) show((current + 1) % slides.length); }, 6000);
}

/* ---------- Boot ---------- */
async function main() {
  const { settings, categories } = await getSiteData();
  renderCategories(categories);
  renderStats(settings?.homepage_stats);
  setupPerfumes(categories);
  loadGrid('bestsellers', { bestseller: true, sort: 'best', limit: 6 }, { hideSectionIfEmpty: 'bestsellers' });
  // Optional sections: on error they stay hidden rather than break the page
  loadOffers().catch((err) => console.error('[home] offers', err));
  loadReviews().catch((err) => console.error('[home] reviews', err));
  observeReveal();
}

main();
