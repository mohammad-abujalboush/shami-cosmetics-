// /admin/settings.html (owner) — the single settings row: store open/closed, WhatsApp, CliQ, top bar,
// homepage stats (each with a show flag, no invented numbers), return policy, social links.
// The free-delivery threshold lives on the delivery page.
import { initAdmin } from '../admin.js';
import { t, html, raw, formatPhone, normalizePhone, toWesternDigits, showLoading, showError, toast, errorMessage, toAppError } from '../utils.js';
import { rpc } from '../supabase.js';
import { field, input, numberInput, textarea, switchRow, runChecks, withSave, parseIntStrict, swap, arrow } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'settings', ownerOnly: true });
document.title = t('admin.settings.meta');
const root = document.querySelector('[data-slot="settings"]');
const SOCIAL = ['instagram', 'facebook', 'tiktok', 'snapchat'];
const MAX_STATS = 6;
const MAX_BAR = 10;
let stats = [];

async function load() {
  showLoading(root);
  try {
    const s = await rpc('get_admin_settings');
    stats = Array.isArray(s.homepage_stats) ? s.homepage_stats.map((x) => ({ label_ar: x.label_ar || '', value: x.value ?? '', show: x.show !== false })) : [];
    paint(s);
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

function statRow(s, i) {
  return html`
    <div class="card soft" style="padding:12px 14px;display:grid;gap:10px" data-stat="${i}">
      <div class="form-grid">
        ${field(`st-label-${i}`, t('admin.settings.statLabel'), input({ id: `st-label-${i}`, name: `st-label-${i}`, value: s.label_ar, maxlength: 60, placeholder: t('admin.settings.statLabelPlaceholder') }))}
        ${field(`st-value-${i}`, t('admin.settings.statValue'), input({ id: `st-value-${i}`, name: `st-value-${i}`, value: s.value, maxlength: 20, placeholder: t('admin.settings.statValuePlaceholder') }))}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between">
        <label class="check"><input type="checkbox" class="switch" role="switch" name="st-show-${i}" ${raw(s.show ? 'checked' : '')}> <span>${t('admin.settings.statShow')}</span></label>
        <span>
          <button type="button" class="icon-btn" data-stat-up="${i}" aria-label="${t('admin.common.moveUp')}" ${raw(i === 0 ? 'disabled' : '')}>${raw(arrow('up'))}</button>
          <button type="button" class="icon-btn" data-stat-down="${i}" aria-label="${t('admin.common.moveDown')}" ${raw(i === stats.length - 1 ? 'disabled' : '')}>${raw(arrow('down'))}</button>
          <button type="button" class="btn ghost sm" data-stat-remove="${i}">${t('common.delete')}</button>
        </span>
      </div>
    </div>`;
}

function paint(s) {
  root.removeAttribute('aria-busy');
  const social = s.social_links && typeof s.social_links === 'object' ? s.social_links : {};
  root.innerHTML = html`
    <form data-form novalidate class="admin-grid" style="max-width:820px">
      <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.settings.storeTitle')}</h2></div>
        <div class="panel-body form">
          ${switchRow({ id: 's-open', name: 'store_open', label: t('admin.settings.storeOpen'), checked: s.store_open, hint: t('admin.settings.storeOpenHint') })}
          ${field('s-wa', t('admin.settings.whatsapp'), input({ id: 's-wa', name: 'store_whatsapp', value: s.store_whatsapp ? (normalizePhone(s.store_whatsapp) ? formatPhone(s.store_whatsapp) : s.store_whatsapp) : '', dir: 'ltr', inputmode: 'tel', maxlength: 20, hint: t('admin.settings.whatsappHint') }), { hint: t('admin.settings.whatsappHint'), optional: true })}
        </div></section>

      <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.settings.cliqTitle')}</h2></div>
        <div class="panel-body form">
          <p class="hint" style="margin:0">${t('admin.settings.cliqHint')}</p>
          <div class="form-grid">
            ${field('s-alias', t('admin.settings.cliqAlias'), input({ id: 's-alias', name: 'cliq_alias', value: s.cliq_alias || '', dir: 'ltr', maxlength: 60 }), { optional: true })}
            ${field('s-account', t('admin.settings.cliqAccount'), input({ id: 's-account', name: 'cliq_account_name', value: s.cliq_account_name || '', maxlength: 80 }), { optional: true })}
            ${field('s-window', t('admin.settings.cliqWindow'), numberInput({ id: 's-window', name: 'cliq_window_hours', value: s.cliq_window_hours }), { hint: t('admin.settings.cliqWindowHint') })}
          </div>
        </div></section>

      <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.settings.topBarTitle')}</h2></div>
        <div class="panel-body form">
          ${field('s-bar', t('admin.settings.topBar'), textarea({ id: 's-bar', name: 'top_bar_messages', rows: 4, value: (s.top_bar_messages || []).join('\n'), hint: t('admin.settings.topBarHint') }), { hint: t('admin.settings.topBarHint'), optional: true })}
        </div></section>

      <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.settings.statsTitle')}</h2>
          <button type="button" class="btn ghost sm" data-stat-add>${t('admin.settings.statAdd')}</button></div>
        <div class="panel-body form">
          <p class="hint" style="margin:0">${t('admin.settings.statsHint')}</p>
          <div data-stats style="display:grid;gap:12px">${stats.length ? stats.map(statRow) : html`<p class="hint" data-stats-empty>${t('admin.settings.statsEmpty')}</p>`}</div>
        </div></section>

      <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.settings.policyTitle')}</h2></div>
        <div class="panel-body form">
          ${field('s-policy', t('admin.settings.policy'), textarea({ id: 's-policy', name: 'return_policy_ar', rows: 8, value: s.return_policy_ar || '', maxlength: 8000 }), { optional: true })}
        </div></section>

      <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.settings.socialTitle')}</h2></div>
        <div class="panel-body form"><div class="form-grid">
          ${SOCIAL.map((k) => field(`s-${k}`, t(`footer.social.${k}`), input({ id: `s-${k}`, name: k, value: social[k] || '', dir: 'ltr', maxlength: 200, placeholder: 'https://' }), { optional: true }))}
        </div></div></section>

      <div class="form-actions"><button type="submit" class="btn primary">${t('admin.settings.save')}</button></div>
    </form>`.toString();
  bind();
}

function collectStats(form) {
  return stats.map((_, i) => ({
    label_ar: form.elements[`st-label-${i}`].value.trim(), value: form.elements[`st-value-${i}`].value.trim(), show: form.elements[`st-show-${i}`].checked,
  }));
}

function bind() {
  const form = root.querySelector('[data-form]');
  const rerender = () => { const box = form.querySelector('[data-stats]'); box.innerHTML = (stats.length ? stats.map(statRow) : html`<p class="hint">${t('admin.settings.statsEmpty')}</p>`).toString(); };
  form.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.matches('[data-stat-add]')) { if (stats.length >= MAX_STATS) { toast(t('admin.settings.statsMax', { n: MAX_STATS }), { type: 'error' }); return; } stats = collectStats(form); stats.push({ label_ar: '', value: '', show: true }); rerender(); }
    if (b.dataset.statRemove !== undefined) { stats = collectStats(form); stats.splice(Number(b.dataset.statRemove), 1); rerender(); }
    if (b.dataset.statUp !== undefined) { stats = collectStats(form); swap(stats, Number(b.dataset.statUp), Number(b.dataset.statUp) - 1); rerender(); }
    if (b.dataset.statDown !== undefined) { stats = collectStats(form); swap(stats, Number(b.dataset.statDown), Number(b.dataset.statDown) + 1); rerender(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (n) => form.elements[n].value.trim();
    const wa = v('store_whatsapp');
    const waNorm = wa ? (normalizePhone(wa) || (/^\d{8,15}$/.test(toWesternDigits(wa).replace(/[\s+\-()]/g, '')) ? toWesternDigits(wa).replace(/[\s+\-()]/g, '') : null)) : null;
    const alias = v('cliq_alias'); const account = v('cliq_account_name');
    const window_ = parseIntStrict(form.elements.cliq_window_hours.value);
    const bar = form.elements.top_bar_messages.value.split('\n').map((x) => x.trim()).filter(Boolean);
    const st = collectStats(form);
    const checks = [
      ['s-wa', wa && !waNorm ? t('admin.settings.whatsappInvalid') : ''],
      ['s-alias', account && !alias ? t('admin.settings.cliqBoth') : ''],
      ['s-account', alias && !account ? t('admin.settings.cliqBoth') : ''],
      ['s-window', window_ === null ? t('validation.required') : (Number.isNaN(window_) || window_ < 1 || window_ > 720 ? t('admin.settings.cliqWindowInvalid') : '')],
      ['s-bar', bar.length > MAX_BAR ? t('admin.settings.topBarMax', { n: MAX_BAR }) : (bar.some((x) => x.length > 120) ? t('admin.settings.topBarLong') : '')],
      ...st.flatMap((s, i) => [
        [`st-label-${i}`, !s.label_ar ? t('validation.required') : ''],
        [`st-value-${i}`, !s.value ? t('validation.required') : ''],
      ]),
      ...SOCIAL.map((k) => [`s-${k}`, v(k) && !/^https:\/\/[^\s]+$/.test(v(k)) ? t('admin.settings.urlInvalid') : '']),
    ];
    if (!runChecks(form, checks)) { toast(t('checkout.fixFields'), { type: 'error' }); return; }
    const row = {
      store_open: form.elements.store_open.checked, store_whatsapp: waNorm, cliq_alias: alias || null, cliq_account_name: account || null,
      cliq_window_hours: window_, top_bar_messages: bar, return_policy_ar: v('return_policy_ar') || null,
      homepage_stats: st.map((s) => ({ label_ar: s.label_ar, value: toWesternDigits(s.value), show: s.show })),
      social_links: Object.fromEntries(SOCIAL.filter((k) => v(k)).map((k) => [k, v(k)])),
    };
    const { ok } = await withSave(form.querySelector('button[type="submit"]'), async () => {
      const { error } = await ctx.sb.from('settings').update(row).eq('id', true);
      if (error) throw toAppError(error);
    });
    if (ok) { try { sessionStorage.removeItem('shami_site_data_v2'); } catch { /* cache only */ } load(); }
  });
}

load();
