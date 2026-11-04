// /admin/delivery.html (owner) — delivery fee + active flag for the 12 governorates, and the free-delivery threshold.
// The threshold applies to the subtotal AFTER discounts (calculate_cart in Postgres).
import { initAdmin } from '../admin.js';
import { t, html, raw, formatPrice, showLoading, showError, toast, errorMessage, toAppError, formatNumber } from '../utils.js';
import { run, rpc } from '../supabase.js';
import { numberInput, field, parseNum, decimals, withSave, setErr, runChecks } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'delivery', ownerOnly: true });
document.title = t('admin.delivery.meta');
const root = document.querySelector('[data-slot="delivery"]');
let govs = [];
let threshold = null;

async function load() {
  showLoading(root);
  try {
    const [g, s] = await Promise.all([
      run(ctx.sb.from('governorates').select('*').order('sort').order('id')),
      rpc('get_admin_settings'),
    ]);
    govs = g;
    threshold = s.free_delivery_threshold;
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

const feeCheck = (v, label) => {
  const n = parseNum(v);
  if (n === null) return t('validation.required');
  if (Number.isNaN(n) || n < 0 || n > 1000 || decimals(n) > 3) return t('admin.common.invalidAmount');
  return '';
};

function paint() {
  root.removeAttribute('aria-busy');
  root.innerHTML = html`
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.delivery.thresholdTitle')}</h2></div>
      <form class="panel-body form" data-threshold novalidate>
        <p class="hint" style="margin:0">${t('admin.delivery.thresholdHint')}</p>
        ${field('free-threshold', t('admin.delivery.threshold'), numberInput({ id: 'free-threshold', name: 'threshold', value: threshold ?? '', placeholder: t('admin.delivery.thresholdPlaceholder') }), { optional: true })}
        <div><button type="submit" class="btn primary sm">${t('common.save')}</button></div>
      </form></section>
    <section class="panel"><div class="panel-head"><h2 class="panel-title">${t('admin.delivery.feesTitle')}</h2></div>
      <form class="panel-body flush" data-fees novalidate>
        <div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table">
          <thead><tr><th>${t('admin.delivery.governorate')}</th><th>${t('admin.delivery.fee')}</th><th>${t('admin.common.active')}</th></tr></thead>
          <tbody>${govs.map((g) => html`
            <tr class="${g.active ? '' : 'is-muted'}"><td class="cell-main">${g.name_ar}</td>
              <td><div class="field" style="max-width:160px"><label class="sr-only" for="fee-${g.id}">${t('admin.delivery.feeFor', { name: g.name_ar })}</label>
                ${numberInput({ id: `fee-${g.id}`, name: `fee-${g.id}`, value: Number(g.delivery_fee) })}<p class="field-error" id="fee-${g.id}-err" role="alert"></p></div></td>
              <td><input type="checkbox" class="switch" role="switch" id="act-${g.id}" name="act-${g.id}" aria-label="${t('admin.common.active')}: ${g.name_ar}" ${raw(g.active ? 'checked' : '')}></td></tr>`)}</tbody>
        </table></div>
        <div class="form-actions" style="margin:16px"><button type="submit" class="btn primary">${t('admin.delivery.saveFees')}</button></div>
      </form></section>`.toString();

  const tf = root.querySelector('[data-threshold]');
  tf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw_ = tf.elements.threshold.value;
    const n = parseNum(raw_);
    const msg = n === null ? '' : (Number.isNaN(n) || n < 0 || decimals(n) > 3 ? t('admin.common.invalidAmount') : '');
    if (!runChecks(tf, [['free-threshold', msg]])) return;
    const { ok } = await withSave(tf.querySelector('button'), async () => {
      const { error } = await ctx.sb.from('settings').update({ free_delivery_threshold: n }).eq('id', true);
      if (error) throw toAppError(error);
    });
    if (ok) threshold = n;
  });

  const ff = root.querySelector('[data-fees]');
  ff.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!runChecks(ff, govs.map((g) => [`fee-${g.id}`, feeCheck(ff.elements[`fee-${g.id}`].value)]))) return;
    await withSave(ff.querySelector('button[type="submit"]'), async () => {
      const results = await Promise.all(govs.map((g) => ctx.sb.from('governorates').update({
        delivery_fee: parseNum(ff.elements[`fee-${g.id}`].value), active: ff.elements[`act-${g.id}`].checked,
      }).eq('id', g.id)));
      const bad = results.find((r) => r.error);
      if (bad) throw toAppError(bad.error);
    });
    load();
  });
}

load();
