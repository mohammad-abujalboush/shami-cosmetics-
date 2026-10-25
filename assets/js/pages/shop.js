// Shop: /shop.html?c=<category slug>&q=<search>&g=men|women&stock=1&sort=best|new|price_asc|price_desc
// Filtering, sorting, Arabic-normalized search and paging all run in the database (catalog_products).
import { getSiteData } from '../layout.js';
import { t, html, showError, showEmpty, setButtonLoading, debounce, getParam, formatNumber, toast, errorMessage } from '../utils.js';
import { queryCatalog, productCards, skeletonCards, SORT_KEYS, GENDERED_CATEGORIES } from '../catalog.js';
import { SHOP_PAGE_SIZE } from '../config.js';

const $ = (sel) => document.querySelector(`[data-slot="${sel}"]`);
const grid = $('grid');
const moreBtn = $('more');

const state = {
  c: getParam('c') || '',
  q: getParam('q') || '',
  g: ['men', 'women'].includes(getParam('g')) ? getParam('g') : '',
  stock: getParam('stock') === '1',
  sort: SORT_KEYS.includes(getParam('sort')) ? getParam('sort') : 'best',
};
let category = null;      // { key, slug, name_ar } of ?c=
let loaded = 0;
let total = null;
let reqId = 0;

function syncUrl() {
  const p = new URLSearchParams();
  if (state.c) p.set('c', state.c);
  if (state.q) p.set('q', state.q);
  if (state.g && GENDERED_CATEGORIES.includes(category?.key)) p.set('g', state.g);
  if (state.stock) p.set('stock', '1');
  if (state.sort !== 'best') p.set('sort', state.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function renderHeading() {
  const title = state.q ? t('shop.titleSearch', { q: state.q }) : (category?.name_ar || t('shop.titleAll'));
  $('title').textContent = title;
  document.title = `${category?.name_ar || t('shop.titleAll')} | Shami Cosmetics`;
}

function renderCategories(categories) {
  const chips = [{ slug: '', name_ar: t('shop.allCategories') }, ...categories];
  $('cats').innerHTML = html`${chips.map((c) => html`
    <a class="chip" href="/shop.html${c.slug ? `?c=${encodeURIComponent(c.slug)}` : ''}"
       ${c.slug === state.c ? html`aria-current="page"` : ''}>${c.name_ar}</a>`)}`.toString();
  $('cats').querySelectorAll('[aria-current="page"]').forEach((el) => el.classList.add('active'));
}

async function load({ append = false } = {}) {
  const token = ++reqId;
  if (!append) {
    loaded = 0;
    total = null;
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = skeletonCards(6).toString();
    moreBtn.hidden = true;
    $('count').textContent = '';
  } else {
    setButtonLoading(moreBtn, true);
  }

  try {
    const { rows, count } = await queryCatalog({
      categorySlug: state.c || null,
      gender: GENDERED_CATEGORIES.includes(category?.key) ? state.g : null,
      inStock: state.stock,
      search: state.q,
      sort: state.sort,
      offset: loaded,
      limit: SHOP_PAGE_SIZE,
      count: true,
    });
    if (token !== reqId) return;
    total = count ?? rows.length;
    grid.removeAttribute('aria-busy');

    if (!append && !rows.length) {
      showEmpty(grid, {
        title: t('shop.emptyTitle'),
        text: t('shop.emptyText'),
        actionLabel: t('shop.clearFilters'),
        actionHref: `/shop.html${state.c ? `?c=${encodeURIComponent(state.c)}` : ''}`,
      });
    } else {
      grid.insertAdjacentHTML(append ? 'beforeend' : 'afterbegin', productCards(rows).toString());
      if (!append) grid.querySelectorAll('.skeleton-card').forEach((el) => el.remove());
      // Move focus to the first new card for keyboard users after "load more"
      if (append && rows.length) grid.querySelectorAll('.prod-card')[loaded]?.querySelector('a')?.focus();
    }
    loaded += rows.length;
    $('count').textContent = t('shop.resultsCount', { count: formatNumber(total) });
    moreBtn.hidden = loaded >= total;
  } catch (err) {
    if (token !== reqId) return;
    grid.removeAttribute('aria-busy');
    if (append) {
      toast(errorMessage(err), { type: 'error' });  // keep what is already shown; the button stays for retry
      moreBtn.hidden = false;
    } else {
      showError(grid, { error: err, onRetry: () => load() });
    }
  } finally {
    if (append) setButtonLoading(moreBtn, false);
  }
}

function reload() {
  syncUrl();
  renderHeading();
  load();
}

function setupControls() {
  // Search (debounced while typing, immediate on submit)
  const form = $('search-form');
  const input = form.querySelector('input');
  const clear = $('search-clear');
  input.value = state.q;
  clear.hidden = !state.q;
  const apply = () => {
    const q = input.value.trim().slice(0, 80);
    clear.hidden = !input.value;
    if (q === state.q) return;
    state.q = q;
    reload();
  };
  const applySoon = debounce(apply, 350);
  input.addEventListener('input', () => { clear.hidden = !input.value; applySoon(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); input.blur(); });
  clear.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });

  // Gender (perfume lines only)
  const seg = $('gender');
  if (GENDERED_CATEGORIES.includes(category?.key)) {
    seg.hidden = false;
    const buttons = [...seg.querySelectorAll('button')];
    const mark = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.gender || '') === state.g)));
    mark();
    buttons.forEach((b) => b.addEventListener('click', () => { state.g = b.dataset.gender || ''; mark(); reload(); }));
  }

  const stock = $('instock');
  stock.checked = state.stock;
  stock.addEventListener('change', () => { state.stock = stock.checked; reload(); });

  const sort = $('sort');
  sort.value = state.sort;
  sort.addEventListener('change', () => { state.sort = sort.value; reload(); });

  moreBtn.addEventListener('click', () => load({ append: true }));
}

async function main() {
  const { categories } = await getSiteData();
  renderCategories(categories);
  if (state.c) {
    category = categories.find((c) => c.slug === state.c) || null;
    if (!category) {
      renderHeading();
      $('title').textContent = t('shop.unknownCategoryTitle');
      showEmpty(grid, { title: t('shop.unknownCategoryTitle'), text: t('shop.unknownCategoryText'),
                        actionLabel: t('shop.titleAll'), actionHref: '/shop.html' });
      document.querySelector('.shop-toolbar').hidden = true;
      $('search-form').hidden = true;
      return;
    }
  }
  setupControls();
  renderHeading();
  load();
}

main();
