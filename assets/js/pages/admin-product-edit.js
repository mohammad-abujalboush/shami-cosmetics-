// /admin/product-edit.html[?id=] (owner) — create / edit a product: details, tags, variants, images, live card preview.
// Rules (CLAUDE.md): name_ar + description_ar required, name_en optional, slug is Latin (auto from name_en or p-<id>),
// every product has at least one variant, stock is read-only here (stock page / adjust_stock keeps the log),
// compare_at_price must be greater than price. Images go to the public product-images bucket (compressed first).
import { initAdmin } from '../admin.js';
import { t, html, raw, ltr, formatPrice, showLoading, showError, toast, errorMessage, toAppError, getParam, setButtonLoading, normalizeArabic } from '../utils.js';
import { run } from '../supabase.js';
import { productCard, imageUrl, GENDERED_CATEGORIES } from '../catalog.js';
import { compressImage, randomName } from '../image-tools.js';
import { field, input, numberInput, select, textarea, switchRow, setErr, runChecks, parseNum, parseIntStrict, decimals, confirmDelete, arrow } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'products', ownerOnly: true });
const root = document.querySelector('[data-slot="product"]');
const rawId = getParam('id');
const pid = /^\d+$/.test(rawId || '') ? Number(rawId) : null;
const MAX_IMAGES = 10;
const BASE_TAGS = ['sensitive', 'oily', 'dry', 'acne', 'whitening'];

const S = { p: null, variants: [], images: [], cats: [], tags: [], tagPool: [...BASE_TAGS], seq: 0 };
const newVariant = (o = {}) => ({ key: `n${++S.seq}`, id: null, label: '', sku: '', price: '', compare: '', stock: '0', threshold: '5', active: true, ...o });

/* ---------- Load ---------- */

async function load() {
  showLoading(root);
  try {
    const [cats, prods] = await Promise.all([
      run(ctx.sb.from('categories').select('id, key, slug, name_ar').order('sort')),
      run(ctx.sb.from('products').select('tags')),
    ]);
    S.cats = cats;
    S.tagPool = [...new Set([...BASE_TAGS, ...prods.flatMap((x) => x.tags || [])])].sort();
    if (pid) {
      const p = await run(ctx.sb.from('products').select('*, product_variants(*), product_images(*)').eq('id', pid).maybeSingle());
      if (!p) { notFound(); return; }
      S.p = p;
      S.tags = p.tags || [];
      S.variants = p.product_variants.slice().sort((a, b) => a.sort - b.sort || a.id - b.id).map((v) => newVariant({
        id: v.id, label: v.label, sku: v.sku || '', price: String(Number(v.price)), compare: v.compare_at_price ? String(Number(v.compare_at_price)) : '',
        stock: String(v.stock), threshold: String(v.low_stock_threshold), active: v.active,
      }));
      S.images = p.product_images.slice().sort((a, b) => a.sort - b.sort || a.id - b.id);
      document.title = `${p.name_ar} | Shami Cosmetics`;
    } else {
      S.p = { name_ar: '', name_en: '', description_ar: '', category_id: S.cats[0]?.id, gender: null, slug: '', sort: 0, active: false, is_bestseller: false };
      S.variants = [newVariant({ label: t('admin.product.defaultVariant') })];
      document.title = t('admin.product.metaNew');
    }
    render();
    if (getParam('created')) toast(t('admin.product.created'), { type: 'success', duration: 7000 });
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

function notFound() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`<div class="state state-empty"><p class="state-title">${t('admin.product.notFound')}</p><a class="btn primary" href="/admin/products.html">${t('admin.product.back')}</a></div>`.toString();
}

/* ---------- Render ---------- */

function variantCard(v, i) {
  const k = v.key;
  const existing = v.id !== null;
  return html`
    <div class="card soft" style="padding:14px 16px" data-variant="${k}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
        <strong>${t('admin.product.variantN', { n: i + 1 })}</strong>
        <button type="button" class="btn ghost sm" data-vdelete="${k}">${t('common.delete')}</button>
      </div>
      <div class="form-grid">
        ${field(`v-label-${k}`, t('admin.product.vLabel'), input({ id: `v-label-${k}`, name: `v-label-${k}`, value: v.label, maxlength: 60, placeholder: t('admin.product.vLabelPlaceholder') }))}
        ${field(`v-sku-${k}`, t('admin.product.vSku'), input({ id: `v-sku-${k}`, name: `v-sku-${k}`, value: v.sku, dir: 'ltr', maxlength: 40 }), { optional: true })}
        ${field(`v-price-${k}`, t('admin.product.vPrice'), numberInput({ id: `v-price-${k}`, name: `v-price-${k}`, value: v.price }))}
        ${field(`v-compare-${k}`, t('admin.product.vCompare'), numberInput({ id: `v-compare-${k}`, name: `v-compare-${k}`, value: v.compare }), { optional: true, hint: t('admin.product.vCompareHint') })}
        ${existing
    ? html`<div class="field"><span class="label">${t('admin.product.vStock')}</span>
            <div><strong>${v.stock}</strong> · <a class="link-inline" href="/admin/stock.html?q=${encodeURIComponent(v.sku || S.p.name_ar)}" target="_blank" rel="noopener">${t('admin.product.vStockLink')}</a></div>
            <span class="hint">${t('admin.product.vStockHint')}</span></div>`
    : field(`v-stock-${k}`, t('admin.product.vInitialStock'), numberInput({ id: `v-stock-${k}`, name: `v-stock-${k}`, value: v.stock }))}
        ${field(`v-thr-${k}`, t('admin.product.vThreshold'), numberInput({ id: `v-thr-${k}`, name: `v-thr-${k}`, value: v.threshold }), { hint: t('admin.product.vThresholdHint') })}
      </div>
      ${switchRow({ id: `v-active-${k}`, name: `v-active-${k}`, label: t('admin.common.active'), checked: v.active })}
    </div>`;
}

function render() {
  const p = S.p;
  const edit = Boolean(pid);
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <div class="admin-page-head">
      <div><a class="link-inline" href="/admin/products.html">${t('admin.product.back')}</a>
        <h2 style="font-size:22px;margin-top:6px">${t(edit ? 'admin.product.editTitle' : 'admin.product.newTitle')}</h2>
        ${edit ? html`<p class="sub">${ltr(p.slug)}</p>` : ''}</div>
      <div class="actions">${edit ? html`<a class="btn ghost sm" href="/product.html?slug=${encodeURIComponent(p.slug)}" target="_blank" rel="noopener">${t('admin.product.viewInStore')}</a>` : ''}</div>
    </div>
    <form data-form novalidate class="admin-grid split">
      <div class="admin-grid">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.product.detailsTitle')}</h2></div>
          <div class="panel-body form">
            ${field('p-name', t('admin.product.nameAr'), input({ id: 'p-name', name: 'name_ar', value: p.name_ar, maxlength: 120 }))}
            ${field('p-name-en', t('admin.product.nameEn'), input({ id: 'p-name-en', name: 'name_en', value: p.name_en || '', dir: 'ltr', maxlength: 120 }), { optional: true })}
            <div class="form-grid">
              ${field('p-cat', t('admin.products.category'), select({ id: 'p-cat', name: 'category_id', value: p.category_id, options: S.cats.map((c) => ({ value: c.id, label: c.name_ar })) }))}
              ${field('p-gender', t('admin.product.gender'), select({ id: 'p-gender', name: 'gender', value: p.gender || '', options: [{ value: '', label: t('admin.product.genderNone') }, { value: 'men', label: t('catalog.gender.men') }, { value: 'women', label: t('catalog.gender.women') }, { value: 'unisex', label: t('catalog.gender.unisex') }] }), { hint: t('admin.product.genderHint') })}
            </div>
            ${field('p-desc', t('admin.product.description'), textarea({ id: 'p-desc', name: 'description_ar', value: p.description_ar, rows: 6, maxlength: 5000 }))}
            <div class="form-grid">
              ${field('p-slug', t('admin.product.slug'), input({ id: 'p-slug', name: 'slug', value: edit ? p.slug : '', dir: 'ltr', maxlength: 80, hint: t('admin.product.slugHint') }), { hint: t('admin.product.slugHint'), optional: true })}
              ${field('p-sort', t('admin.product.sort'), numberInput({ id: 'p-sort', name: 'sort', value: p.sort ?? 0 }), { hint: t('admin.product.sortHint') })}
            </div>
            <div class="field"><label class="label" for="p-tag-input">${t('admin.product.tags')} <span class="opt">(${t('common.optional')})</span></label>
              <div data-tags style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;border:1.5px solid var(--line);border-radius:10px;background:var(--surface)"></div>
              <span class="hint" id="p-tag-input-hint">${t('admin.product.tagsHint')}</span>
              <datalist id="tag-pool">${S.tagPool.map((x) => html`<option value="${x}"></option>`)}</datalist>
              <p class="field-error" id="p-tag-input-err" role="alert"></p></div>
          </div></section>

        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.product.variantsTitle')}</h2>
            <button type="button" class="btn ghost sm" data-vadd>${t('admin.product.addVariant')}</button></div>
          <div class="panel-body form" data-variants>${S.variants.map(variantCard)}</div></section>

        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.product.imagesTitle')}</h2></div>
          <div class="panel-body" data-images></div></section>
      </div>

      <aside class="admin-grid" style="align-content:start">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.product.previewTitle')}</h2></div>
          <div class="panel-body"><div data-preview class="preview-card" style="pointer-events:none;max-width:340px;margin-inline:auto"></div>
            <p class="hint" data-preview-note style="margin:10px 0 0"></p></div></section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.product.visibilityTitle')}</h2></div>
          <div class="panel-body">
            ${switchRow({ id: 'p-active', name: 'active', label: t('admin.common.active'), checked: p.active, hint: t('admin.product.activeHint') })}
            ${switchRow({ id: 'p-best', name: 'is_bestseller', label: t('admin.products.bestseller'), checked: p.is_bestseller })}
            <p class="field-error" id="p-active-err" role="alert"></p>
          </div></section>
      </aside>
      <div class="form-actions" style="grid-column:1 / -1">
        <a class="btn ghost" href="/admin/products.html">${t('common.cancel')}</a>
        <button type="submit" class="btn primary" data-save>${t(edit ? 'admin.product.save' : 'admin.product.create')}</button>
      </div>
    </form>`.toString();
  paintTags();
  paintImages();
  preview();
  bind();
}

/* ---------- State <-> DOM ---------- */

const form = () => root.querySelector('[data-form]');

function readVariants() {
  const f = form();
  S.variants.forEach((v) => {
    const k = v.key;
    v.label = f.elements[`v-label-${k}`].value;
    v.sku = f.elements[`v-sku-${k}`].value;
    v.price = f.elements[`v-price-${k}`].value;
    v.compare = f.elements[`v-compare-${k}`].value;
    if (v.id === null) v.stock = f.elements[`v-stock-${k}`].value;
    v.threshold = f.elements[`v-thr-${k}`].value;
    v.active = f.elements[`v-active-${k}`].checked;
  });
}

function readProduct() {
  const f = form();
  const v = (n) => f.elements[n].value;
  return {
    name_ar: v('name_ar').trim(), name_en: v('name_en').trim(), description_ar: v('description_ar').trim(),
    category_id: Number(v('category_id')), gender: v('gender') || null, slug: v('slug').trim().toLowerCase(),
    sort: parseIntStrict(v('sort')), active: f.elements.active.checked, is_bestseller: f.elements.is_bestseller.checked,
  };
}

/* ---------- Tags ---------- */

function paintTags() {
  const box = root.querySelector('[data-tags]');
  box.innerHTML = html`${S.tags.map((tag, i) => html`<span class="badge gold" dir="ltr" style="gap:6px">${tag}
      <button type="button" data-tag-remove="${i}" aria-label="${t('admin.product.removeTag', { tag })}" style="border:0;background:none;padding:0;font-weight:800;cursor:pointer">×</button></span>`)}
    <input id="p-tag-input" list="tag-pool" dir="ltr" class="input" style="border:0;box-shadow:none;min-height:30px;width:auto;flex:1;min-width:120px;padding:2px 4px" placeholder="${t('admin.product.tagPlaceholder')}" autocomplete="off" aria-describedby="p-tag-input-hint p-tag-input-err">`.toString();
}

function addTag(text) {
  const tag = String(text).trim().toLowerCase().replace(/\s+/g, '-');
  if (!tag) return true;
  if (tag.length > 30 || /[^a-z0-9_\-؀-ۿ]/.test(tag)) { setErr(root, 'p-tag-input', t('admin.quiz.tagsInvalid')); return false; }
  if (S.tags.length >= 20) { setErr(root, 'p-tag-input', t('admin.quiz.tagsMax')); return false; }
  if (!S.tags.includes(tag)) S.tags.push(tag);
  setErr(root, 'p-tag-input', '');
  return true;
}

/* ---------- Preview ---------- */

function preview() {
  const p = readProduct();
  readVariants();
  const cat = S.cats.find((c) => c.id === p.category_id);
  const active = S.variants.filter((v) => v.active && parseNum(v.price) > 0);
  const cheapest = active.slice().sort((a, b) => parseNum(a.price) - parseNum(b.price))[0];
  const first = S.images[0]?.path || null;
  const card = {
    id: pid || 0, slug: p.slug || S.p.slug || 'preview', name_ar: p.name_ar || t('admin.product.previewName'), name_en: p.name_en,
    gender: p.gender, is_bestseller: p.is_bestseller, category_key: cat?.key, category_name_ar: cat?.name_ar,
    from_price: cheapest ? parseNum(cheapest.price) : 0, from_compare_at_price: cheapest && parseNum(cheapest.compare) ? parseNum(cheapest.compare) : null,
    in_stock: active.some((v) => (v.id === null ? parseIntStrict(v.stock) > 0 : Number(v.stock) > 0)), variant_count: active.length || 1,
    default_variant_id: 0, default_variant_stock: 0, image_path: first, image_alt_ar: S.images[0]?.alt_ar || null,
  };
  root.querySelector('[data-preview]').innerHTML = productCard(card).toString();
  root.querySelector('[data-preview-note]').textContent = p.active ? t('admin.product.previewLive') : t('admin.product.previewHidden');
}

/* ---------- Images ---------- */

function paintImages() {
  const box = root.querySelector('[data-images]');
  if (!pid) { box.innerHTML = html`<p class="hint" style="margin:0">${t('admin.product.imagesAfterSave')}</p>`.toString(); return; }
  box.innerHTML = html`
    <p class="hint" style="margin:0 0 12px">${t('admin.product.imagesHint', { max: MAX_IMAGES })}</p>
    <div class="thumb-grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr))">
      ${S.images.map((img, i) => html`
        <div class="thumb-item" style="aspect-ratio:auto;display:grid;gap:6px;padding:6px" data-image="${img.id}">
          <div style="aspect-ratio:1;border-radius:8px;overflow:hidden;position:relative"><img src="${imageUrl(img.path)}" alt="${img.alt_ar || ''}" style="width:100%;height:100%;object-fit:cover">
            ${i === 0 ? html`<span class="badge dark" style="position:absolute;inset-block-start:6px;inset-inline-start:6px">${t('admin.product.mainImage')}</span>` : ''}</div>
          <label class="sr-only" for="alt-${img.id}">${t('admin.product.imageAlt')}</label>
          <input class="input" id="alt-${img.id}" data-alt="${img.id}" value="${img.alt_ar || ''}" placeholder="${t('admin.product.imageAlt')}" maxlength="120" style="min-height:34px;font-size:13px">
          <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:space-between">
            <span><button type="button" class="icon-btn" data-img-left="${i}" aria-label="${t('admin.product.imageEarlier')}" ${raw(i === 0 ? 'disabled' : '')}>${raw(arrow('up'))}</button>
              <button type="button" class="icon-btn" data-img-right="${i}" aria-label="${t('admin.product.imageLater')}" ${raw(i === S.images.length - 1 ? 'disabled' : '')}>${raw(arrow('down'))}</button></span>
            ${i === 0 ? '' : html`<button type="button" class="btn ghost sm" data-img-main="${i}">${t('admin.product.setMain')}</button>`}
            <button type="button" class="btn ghost sm" data-img-delete="${img.id}">${t('common.delete')}</button>
          </div>
        </div>`)}
      ${S.images.length < MAX_IMAGES ? html`<label class="thumb-add" style="aspect-ratio:auto;min-height:150px"><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple hidden data-upload>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span data-upload-label>${t('admin.product.addImages')}</span></label>` : ''}
    </div>`.toString();
}

async function renumberImages(list) {
  const results = await Promise.all(list.map((img, i) => (img.sort === i + 1 ? null : ctx.sb.from('product_images').update({ sort: i + 1 }).eq('id', img.id))));
  const bad = results.find((r) => r && r.error);
  if (bad) throw toAppError(bad.error);
  list.forEach((img, i) => { img.sort = i + 1; });
  S.images = list;
}

async function upload(files) {
  const label = root.querySelector('[data-upload-label]');
  const room = MAX_IMAGES - S.images.length;
  const picked = [...files].slice(0, room);
  if (files.length > room) toast(t('admin.product.imagesMax', { max: MAX_IMAGES }), { type: 'error' });
  let done = 0;
  for (const file of picked) {
    if (label) label.textContent = t('admin.product.uploading', { n: ++done, total: picked.length });
    try {
      const blob = await compressImage(file);
      const path = `${pid}/${randomName()}.jpg`;
      const { error } = await ctx.sb.storage.from('product-images').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw toAppError({ message: error.message, status: Number(error.statusCode) || undefined, code: String(error.statusCode || '') });
      const { data, error: e2 } = await ctx.sb.from('product_images').insert({ product_id: pid, path, sort: (S.images.at(-1)?.sort ?? 0) + 1 }).select('*').single();
      if (e2) { await ctx.sb.storage.from('product-images').remove([path]).catch(() => {}); throw toAppError(e2); }
      S.images.push(data);
    } catch (err) {
      toast(`${file.name}: ${errorMessage(err)}`, { type: 'error', duration: 8000 });
    }
  }
  paintImages(); preview();
}

/* ---------- Events ---------- */

function bind() {
  const f = form();
  f.addEventListener('input', preview);
  f.addEventListener('change', preview);

  // tags
  const tagBox = root.querySelector('[data-tags]');
  tagBox.addEventListener('keydown', (e) => {
    if (!e.target.matches('#p-tag-input')) return;
    if (e.key === 'Enter' || e.key === ',' || e.key === '،') { e.preventDefault(); if (addTag(e.target.value)) { paintTags(); root.querySelector('#p-tag-input').focus(); preview(); } }
    if (e.key === 'Backspace' && !e.target.value && S.tags.length) { S.tags.pop(); paintTags(); root.querySelector('#p-tag-input').focus(); }
  });
  tagBox.addEventListener('change', (e) => { if (e.target.matches('#p-tag-input') && e.target.value && addTag(e.target.value)) { paintTags(); } });
  tagBox.addEventListener('click', (e) => { const b = e.target.closest('[data-tag-remove]'); if (b) { S.tags.splice(Number(b.dataset.tagRemove), 1); paintTags(); } });

  // variants
  f.querySelector('[data-vadd]').addEventListener('click', () => {
    readVariants();
    S.variants.push(newVariant());
    f.querySelector('[data-variants]').innerHTML = html`${S.variants.map(variantCard)}`.toString();
    f.querySelector(`#v-label-${S.variants.at(-1).key}`).focus();
    preview();
  });
  f.querySelector('[data-variants]').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-vdelete]');
    if (!b) return;
    readVariants();
    const v = S.variants.find((x) => x.key === b.dataset.vdelete);
    if (S.variants.length === 1) { toast(t('admin.product.lastVariant'), { type: 'error' }); return; }
    if (v.id !== null) {
      const { count, error } = await ctx.sb.from('order_items').select('id', { count: 'exact', head: true }).eq('variant_id', v.id);
      if (error) { toast(errorMessage(toAppError(error)), { type: 'error' }); return; }
      if (count > 0) { toast(t('admin.product.variantUsed', { n: count }), { type: 'error', duration: 8000 }); return; }
      if (!(await confirmDelete(t('admin.product.deleteVariantConfirm', { label: v.label })))) return;
      const { error: de } = await ctx.sb.from('product_variants').delete().eq('id', v.id);
      if (de) { toast(errorMessage(toAppError(de)), { type: 'error' }); return; }
      toast(t('admin.common.deleted'), { type: 'success' });
    }
    S.variants = S.variants.filter((x) => x !== v);
    f.querySelector('[data-variants]').innerHTML = html`${S.variants.map(variantCard)}`.toString();
    preview();
  });

  // images
  const imgBox = root.querySelector('[data-images]');
  imgBox.addEventListener('change', async (e) => {
    if (e.target.matches('[data-upload]')) { const files = e.target.files; await upload(files); return; }
    const alt = e.target.closest('[data-alt]');
    if (alt) {
      const { error } = await ctx.sb.from('product_images').update({ alt_ar: alt.value.trim() || null }).eq('id', alt.dataset.alt);
      if (error) toast(errorMessage(toAppError(error)), { type: 'error' }); else { S.images.find((i) => String(i.id) === alt.dataset.alt).alt_ar = alt.value.trim() || null; toast(t('admin.common.saved'), { type: 'success', duration: 1800 }); }
    }
  });
  imgBox.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    try {
      const list = S.images.slice();
      if (b.dataset.imgLeft !== undefined || b.dataset.imgRight !== undefined) {
        const i = Number(b.dataset.imgLeft ?? b.dataset.imgRight); const j = b.dataset.imgLeft !== undefined ? i - 1 : i + 1;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        await renumberImages(list);
      } else if (b.dataset.imgMain !== undefined) {
        const [img] = list.splice(Number(b.dataset.imgMain), 1);
        list.unshift(img);
        await renumberImages(list);
      } else if (b.dataset.imgDelete) {
        const img = list.find((x) => String(x.id) === b.dataset.imgDelete);
        if (!(await confirmDelete(t('admin.product.deleteImageConfirm')))) return;
        const { error } = await ctx.sb.from('product_images').delete().eq('id', img.id);
        if (error) throw toAppError(error);
        await ctx.sb.storage.from('product-images').remove([img.path]).catch(() => {});
        await renumberImages(list.filter((x) => x !== img));
        toast(t('admin.common.deleted'), { type: 'success' });
      } else return;
      paintImages(); preview();
    } catch (err) {
      toast(errorMessage(err), { type: 'error' });
    }
  });

  f.addEventListener('submit', (e) => { e.preventDefault(); save(); });
}

/* ---------- Validation + save ---------- */

function validate() {
  const f = form();
  readVariants();
  const p = readProduct();
  const money = (s, optional = false) => {
    const n = parseNum(s);
    if (n === null) return optional ? '' : t('validation.required');
    return Number.isNaN(n) || n <= 0 || n > 100000 || decimals(n) > 3 ? t('admin.common.invalidAmount') : '';
  };
  const skus = S.variants.map((v) => v.sku.trim().toLowerCase()).filter(Boolean);
  const checks = [
    ['p-name', !p.name_ar ? t('validation.required') : ''],
    ['p-desc', !p.description_ar ? t('validation.required') : ''],
    ['p-cat', p.category_id ? '' : t('validation.required')],
    ['p-slug', p.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.slug) ? t('errors.INVALID_SLUG') : ''],
    ['p-sort', p.sort === null ? t('validation.required') : (Number.isNaN(p.sort) || p.sort < 0 ? t('admin.common.invalidWhole') : '')],
  ];
  S.variants.forEach((v) => {
    const k = v.key; const price = parseNum(v.price); const cmp = parseNum(v.compare);
    const stock = parseIntStrict(v.stock); const thr = parseIntStrict(v.threshold);
    checks.push(
      [`v-label-${k}`, !v.label.trim() ? t('validation.required') : ''],
      [`v-sku-${k}`, v.sku.trim().length > 40 ? t('admin.product.skuLong') : (v.sku.trim() && skus.filter((x) => x === v.sku.trim().toLowerCase()).length > 1 ? t('admin.product.skuDuplicate') : '')],
      [`v-price-${k}`, money(v.price)],
      [`v-compare-${k}`, money(v.compare, true) || (cmp && price && cmp <= price ? t('admin.product.compareLower') : '')],
      ...(v.id === null ? [[`v-stock-${k}`, stock === null ? t('validation.required') : (Number.isNaN(stock) || stock < 0 ? t('admin.common.invalidWhole') : '')]] : []),
      [`v-thr-${k}`, thr === null ? t('validation.required') : (Number.isNaN(thr) || thr < 0 ? t('admin.common.invalidWhole') : '')],
    );
  });
  const ok = runChecks(f, checks);
  const needVariant = p.active && !S.variants.some((v) => v.active);
  setErr(f, 'p-active', needVariant ? t('admin.products.needVariant') : '');
  if (needVariant && ok) f.elements.active.focus();
  return ok && !needVariant;
}

function explain(err) {
  const e = toAppError(err);
  const raw_ = String(err?.cause?.message ?? err?.message ?? '') + String(err?.cause?.details ?? '');
  if (e.code === 'DUPLICATE') {
    if (/sku/i.test(raw_)) return t('admin.product.skuTaken');
    if (/slug/i.test(raw_)) return t('admin.product.slugTaken');
  }
  return errorMessage(err);
}

async function save() {
  const f = form();
  if (!validate()) { toast(t('checkout.fixFields'), { type: 'error' }); return; }
  const p = readProduct();
  const btn = f.querySelector('[data-save]');
  const productRow = {
    category_id: p.category_id, name_ar: p.name_ar, name_en: p.name_en || null, description_ar: p.description_ar,
    gender: p.gender, tags: S.tags, slug: p.slug, is_bestseller: p.is_bestseller, sort: p.sort,
  };
  const variantRow = (v, i) => ({
    label: v.label.trim(), sku: v.sku.trim() || null, price: parseNum(v.price), compare_at_price: parseNum(v.compare) || null,
    low_stock_threshold: parseIntStrict(v.threshold), active: v.active, sort: i + 1,
  });
  setButtonLoading(btn, true);
  try {
    if (!pid) {
      // 1) product (hidden), 2) variants, 3) publish. A failure after step 1 removes the half-created product.
      const { data: created, error } = await ctx.sb.from('products').insert({ ...productRow, active: false }).select('id').single();
      if (error) throw error;
      const { error: ve } = await ctx.sb.from('product_variants').insert(S.variants.map((v, i) => ({ ...variantRow(v, i), product_id: created.id, stock: parseIntStrict(v.stock) })));
      if (ve) { await ctx.sb.from('products').delete().eq('id', created.id); throw ve; }
      if (p.active) { const { error: ae } = await ctx.sb.from('products').update({ active: true }).eq('id', created.id); if (ae) throw ae; }
      location.assign(`/admin/product-edit.html?id=${created.id}&created=1`);
      return;
    }
    const { error } = await ctx.sb.from('products').update({ ...productRow, active: p.active }).eq('id', pid);
    if (error) throw error;
    for (const [i, v] of S.variants.entries()) {
      const q = v.id === null
        ? ctx.sb.from('product_variants').insert({ ...variantRow(v, i), product_id: pid, stock: parseIntStrict(v.stock) })
        : ctx.sb.from('product_variants').update(variantRow(v, i)).eq('id', v.id);
      const { error: ve } = await q;
      if (ve) throw ve;
    }
    toast(t('admin.common.saved'), { type: 'success' });
    await load();
  } catch (err) {
    toast(explain(err), { type: 'error', duration: 8000 });
    setButtonLoading(btn, false);
  }
}

load();
