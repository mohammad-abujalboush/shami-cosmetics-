// Skin quiz: questions + options (tags) from the database, one question at a time,
// results from quiz_recommend (top 3 soaps), shown as normal product cards with add to cart.
import { getSiteData } from '../layout.js';
import { t, html, showLoading, showError, showEmpty } from '../utils.js';
import { queryCatalog, productCards } from '../catalog.js';

const root = document.querySelector('[data-slot="quiz"]');
let questions = [];
let answers = [];   // selected option id per question index
let step = 0;

async function loadQuestions() {
  const { requireClient } = await import('../supabase.js');
  const { data, error } = await requireClient().from('quiz_questions')
    .select('id, question_ar, sort, quiz_options ( id, label_ar, tags, sort )')
    .eq('active', true)
    .order('sort');
  if (error) throw error;
  return (data || [])
    .map((q) => ({ ...q, quiz_options: (q.quiz_options || []).sort((a, b) => a.sort - b.sort || a.id - b.id) }))
    .filter((q) => q.quiz_options.length);
}

function renderStep({ focus = true } = {}) {
  const q = questions[step];
  const last = step === questions.length - 1;
  root.innerHTML = html`
    <form class="quiz-card" novalidate>
      <div class="quiz-progress" aria-hidden="true"><span style="width:${Math.round(((step + 1) / questions.length) * 100)}%"></span></div>
      <p class="quiz-step">${t('quiz.progress', { n: step + 1, total: questions.length })}</p>
      <fieldset>
        <legend>${q.question_ar}</legend>
        <div class="choices">
          ${q.quiz_options.map((o) => html`
            <label class="choice">
              <input type="radio" name="answer" value="${o.id}" ${answers[step] === o.id ? html`checked` : ''}>
              <span class="choice-title">${o.label_ar}</span>
            </label>`)}
        </div>
      </fieldset>
      <p class="field-error" data-error aria-live="assertive"></p>
      <div class="quiz-nav">
        ${step > 0 ? html`<button type="button" class="btn ghost" data-back>${t('quiz.back')}</button>` : ''}
        <button type="submit" class="btn primary">${last ? t('quiz.seeResults') : t('quiz.next')}</button>
      </div>
    </form>`.toString();

  const form = root.querySelector('form');
  form.querySelector('legend').setAttribute('tabindex', '-1');
  if (focus) form.querySelector('legend').focus({ preventScroll: true });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const picked = form.querySelector('input[name="answer"]:checked');
    if (!picked) { form.querySelector('[data-error]').textContent = t('quiz.chooseOption'); return; }
    answers[step] = Number(picked.value);
    if (last) showResults();
    else { step += 1; renderStep(); }
  });
  form.querySelector('[data-back]')?.addEventListener('click', () => { step -= 1; renderStep(); });
}

async function showResults() {
  showLoading(root);
  try {
    const tags = questions.flatMap((q, i) => q.quiz_options.find((o) => o.id === answers[i])?.tags || []);
    const { rpc } = await import('../supabase.js');
    const picks = await rpc('quiz_recommend', { tags });
    const soapSlug = (await getSiteData()).categories.find((c) => c.key === 'soap')?.slug;

    if (!picks?.length) {
      showEmpty(root, { title: t('quiz.noResults'), actionLabel: t('quiz.browseSoaps'), actionHref: soapSlug ? `/shop.html?c=${soapSlug}` : '/shop.html' });
      return;
    }
    // Same cards as the shop (price, stock, variants) in the quiz's ranking order
    const { rows } = await queryCatalog({ ids: picks.map((p) => p.id), limit: picks.length });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = picks.map((p) => byId.get(p.id)).filter(Boolean);

    root.removeAttribute('aria-busy');
    root.innerHTML = html`
      <div class="section-head">
        <h2 tabindex="-1" data-results-title>${t('quiz.resultsTitle')}</h2>
        <p>${t('quiz.resultsText')}</p>
      </div>
      <div class="prod-grid">${productCards(ordered)}</div>
      <div class="section-foot" style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:32px">
        <button type="button" class="btn ghost" data-retake>${t('quiz.retake')}</button>
        <a class="btn outline" href="${soapSlug ? `/shop.html?c=${soapSlug}` : '/shop.html'}">${t('quiz.browseSoaps')}</a>
      </div>`.toString();
    root.querySelector('[data-results-title]').focus();
    root.querySelector('[data-retake]').addEventListener('click', () => { answers = []; step = 0; renderStep(); });
  } catch (err) {
    showError(root, { error: err, onRetry: showResults });
  }
}

async function main() {
  showLoading(root);
  try {
    questions = await loadQuestions();
  } catch (err) {
    showError(root, { error: err, onRetry: main });
    return;
  }
  root.removeAttribute('aria-busy');
  if (!questions.length) { showEmpty(root, { title: t('quiz.unavailable'), actionLabel: t('notFound.shop'), actionHref: '/shop.html' }); return; }
  renderStep({ focus: false });
}

main();
