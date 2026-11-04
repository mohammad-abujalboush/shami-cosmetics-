// /admin/quiz.html (owner) — skin quiz: questions, options, and the product tags each option maps to.
// The quiz ranks active soap products by how many of the chosen tags they carry (top 3, quiz_recommend).
import { initAdmin, formDialog } from '../admin.js';
import { t, html, raw, showLoading, showError, showEmpty, toast, errorMessage, toAppError } from '../utils.js';
import { run } from '../supabase.js';
import { field, input, switchRow, runChecks, required, confirmDelete, swap, arrow } from '../admin-ui.js';

const ctx = await initAdmin({ page: 'quiz', ownerOnly: true });
document.title = t('admin.quiz.meta');
const root = document.querySelector('[data-slot="quiz"]');
const BASE_TAGS = ['sensitive', 'oily', 'dry', 'acne', 'whitening'];
let questions = [];
let tagPool = [...BASE_TAGS];

async function load() {
  showLoading(root);
  try {
    const [qs, opts, prods] = await Promise.all([
      run(ctx.sb.from('quiz_questions').select('*').order('sort').order('id')),
      run(ctx.sb.from('quiz_options').select('*').order('sort').order('id')),
      run(ctx.sb.from('products').select('tags')),
    ]);
    questions = qs.map((q) => ({ ...q, options: opts.filter((o) => o.question_id === q.id) }));
    tagPool = [...new Set([...BASE_TAGS, ...prods.flatMap((p) => p.tags || [])])].sort();
    paint();
  } catch (err) {
    showError(root, { error: err, onRetry: load });
  }
}

function paint() {
  root.removeAttribute('aria-busy');
  const active = questions.filter((q) => q.active).length;
  root.innerHTML = html`
    <p class="hint" style="margin:0 0 14px">${t('admin.quiz.hint', { n: active })}</p>
    ${questions.length ? html`<div style="display:grid;gap:16px">${questions.map((q, i) => html`
      <section class="panel ${q.active ? '' : 'is-muted'}">
        <div class="panel-head">
          <h2 class="panel-title">${i + 1}. ${q.question_ar}${q.active ? '' : html` <span class="badge danger">${t('admin.common.inactive')}</span>`}</h2>
          <span style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" class="icon-btn" data-qup="${i}" aria-label="${t('admin.common.moveUp')}" ${raw(i === 0 ? 'disabled' : '')}>${raw(arrow('up'))}</button>
            <button type="button" class="icon-btn" data-qdown="${i}" aria-label="${t('admin.common.moveDown')}" ${raw(i === questions.length - 1 ? 'disabled' : '')}>${raw(arrow('down'))}</button>
            <button type="button" class="btn ghost sm" data-qedit="${q.id}">${t('common.edit')}</button>
            <button type="button" class="btn ghost sm" data-qdelete="${q.id}">${t('common.delete')}</button>
          </span>
        </div>
        <div class="panel-body flush">${q.options.length ? html`<div class="data-table-wrap" style="border:0;border-radius:0"><table class="data-table"><tbody>
          ${q.options.map((o, j) => html`<tr>
            <td style="white-space:nowrap;width:1%">
              <button type="button" class="icon-btn" data-oup="${q.id}:${j}" aria-label="${t('admin.common.moveUp')}" ${raw(j === 0 ? 'disabled' : '')}>${raw(arrow('up'))}</button>
              <button type="button" class="icon-btn" data-odown="${q.id}:${j}" aria-label="${t('admin.common.moveDown')}" ${raw(j === q.options.length - 1 ? 'disabled' : '')}>${raw(arrow('down'))}</button></td>
            <td class="cell-main">${o.label_ar}</td>
            <td>${(o.tags || []).length ? o.tags.map((tag) => html`<span class="badge gold" dir="ltr" style="margin-inline-end:4px">${tag}</span>`) : html`<span class="hint">${t('admin.quiz.noTags')}</span>`}</td>
            <td class="actions"><button type="button" class="btn ghost sm" data-oedit="${o.id}">${t('common.edit')}</button>
              <button type="button" class="btn ghost sm" data-odelete="${o.id}">${t('common.delete')}</button></td></tr>`)}
        </tbody></table></div>` : html`<p class="panel-body hint">${t('admin.quiz.noOptions')}</p>`}
          <div class="panel-body"><button type="button" class="btn ghost sm" data-oadd="${q.id}">${t('admin.quiz.addOption')}</button></div>
        </div>
      </section>`)}</div>` : html`<div class="state state-empty"><p class="state-title">${t('admin.quiz.emptyTitle')}</p><p class="state-text">${t('admin.quiz.emptyText')}</p></div>`}`.toString();
}

/* ---------- Questions ---------- */

async function editQuestion(q) {
  const data = await formDialog({
    title: t(q ? 'admin.quiz.editQuestion' : 'admin.quiz.addQuestion'), confirmLabel: t('common.save'),
    body: html`${field('q-text', t('admin.quiz.question'), input({ id: 'q-text', name: 'question_ar', value: q?.question_ar || '', maxlength: 200 }))}
      ${switchRow({ id: 'q-active', name: 'active', label: t('admin.common.active'), checked: q ? q.active : true })}`,
    validate: (form) => runChecks(form, [['q-text', required(form.elements.question_ar.value)]]),
  });
  if (!data) return;
  const row = { question_ar: String(data.get('question_ar')).trim(), active: data.get('active') === 'on' };
  await save(q ? ctx.sb.from('quiz_questions').update(row).eq('id', q.id) : ctx.sb.from('quiz_questions').insert({ ...row, sort: (questions.at(-1)?.sort ?? 0) + 1 }));
}

/* ---------- Options ---------- */

const parseTags = (text) => [...new Set(String(text).split(/[,،\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

async function editOption(qid, o) {
  const data = await formDialog({
    title: t(o ? 'admin.quiz.editOption' : 'admin.quiz.addOption'), confirmLabel: t('common.save'),
    body: html`${field('o-label', t('admin.quiz.optionLabel'), input({ id: 'o-label', name: 'label_ar', value: o?.label_ar || '', maxlength: 100 }))}
      ${field('o-tags', t('admin.quiz.tags'), input({ id: 'o-tags', name: 'tags', value: (o?.tags || []).join(', '), dir: 'ltr', placeholder: 'dry, sensitive', hint: t('admin.quiz.tagsHint') }), { hint: t('admin.quiz.tagsHint'), optional: true })}
      <div data-tag-pool style="display:flex;flex-wrap:wrap;gap:6px" aria-label="${t('admin.quiz.suggested')}">
        ${tagPool.map((tag) => html`<button type="button" class="chip" style="padding:4px 12px" data-tag="${tag}" dir="ltr">${tag}</button>`)}</div>`,
    validate: (form) => {
      const tags = parseTags(form.elements.tags.value);
      return runChecks(form, [
        ['o-label', required(form.elements.label_ar.value)],
        ['o-tags', tags.length > 12 ? t('admin.quiz.tagsMax') : (tags.some((x) => x.length > 30 || /[^a-z0-9_\-؀-ۿ]/.test(x)) ? t('admin.quiz.tagsInvalid') : '')],
      ]);
    },
    onOpen: (form) => {
      const input_ = form.elements.tags;
      const paint_ = () => form.querySelectorAll('[data-tag]').forEach((b) => b.setAttribute('aria-pressed', String(parseTags(input_.value).includes(b.dataset.tag))));
      form.querySelector('[data-tag-pool]').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tag]');
        if (!b) return;
        const list = parseTags(input_.value);
        const i = list.indexOf(b.dataset.tag);
        if (i >= 0) list.splice(i, 1); else list.push(b.dataset.tag);
        input_.value = list.join(', ');
        paint_();
      });
      input_.addEventListener('input', paint_);
      paint_();
    },
  });
  if (!data) return;
  const row = { label_ar: String(data.get('label_ar')).trim(), tags: parseTags(data.get('tags')) };
  const q = questions.find((x) => x.id === qid);
  await save(o ? ctx.sb.from('quiz_options').update(row).eq('id', o.id) : ctx.sb.from('quiz_options').insert({ ...row, question_id: qid, sort: (q.options.at(-1)?.sort ?? 0) + 1 }));
}

async function save(query) {
  try {
    const { error } = await query;
    if (error) throw toAppError(error);
    toast(t('admin.common.saved'), { type: 'success' });
  } catch (err) {
    toast(errorMessage(err), { type: 'error', duration: 7000 });
  }
  await load();
}

async function renumber(table, list) {
  const results = await Promise.all(list.map((x, i) => (x.sort === i + 1 ? null : ctx.sb.from(table).update({ sort: i + 1 }).eq('id', x.id))));
  const bad = results.find((r) => r && r.error);
  if (bad) toast(errorMessage(toAppError(bad.error)), { type: 'error' });
  await load();
}

root.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  const q = (id) => questions.find((x) => String(x.id) === String(id));
  if (d.qup !== undefined || d.qdown !== undefined) {
    const i = Number(d.qup ?? d.qdown); const list = questions.slice();
    if (swap(list, i, d.qup !== undefined ? i - 1 : i + 1)) renumber('quiz_questions', list);
  } else if (d.oup !== undefined || d.odown !== undefined) {
    const [qid, jx] = (d.oup ?? d.odown).split(':'); const j = Number(jx); const list = q(qid).options.slice();
    if (swap(list, j, d.oup !== undefined ? j - 1 : j + 1)) renumber('quiz_options', list);
  } else if (d.qedit) editQuestion(q(d.qedit));
  else if (d.oadd) editOption(Number(d.oadd), null);
  else if (d.oedit) { const opt = questions.flatMap((x) => x.options).find((o) => String(o.id) === d.oedit); editOption(opt.question_id, opt); }
  else if (d.qdelete) {
    const qq = q(d.qdelete);
    if (await confirmDelete(t('admin.quiz.deleteQuestionConfirm', { name: qq.question_ar }))) save(ctx.sb.from('quiz_questions').delete().eq('id', qq.id));
  } else if (d.odelete) {
    const opt = questions.flatMap((x) => x.options).find((o) => String(o.id) === d.odelete);
    if (await confirmDelete(t('admin.quiz.deleteOptionConfirm', { name: opt.label_ar }))) save(ctx.sb.from('quiz_options').delete().eq('id', opt.id));
  }
});
document.querySelector('[data-add]').addEventListener('click', () => editQuestion(null));
load();
