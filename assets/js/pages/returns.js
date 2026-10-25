// Return policy: settings.return_policy_ar (plain text; blank lines separate paragraphs).
import { getSiteData } from '../layout.js';
import { t, html, showLoading, showEmpty } from '../utils.js';

const slot = document.querySelector('[data-slot="policy"]');

async function main() {
  showLoading(slot);
  const { settings } = await getSiteData();
  slot.removeAttribute('aria-busy');
  const text = String(settings?.return_policy_ar ?? '').trim();
  const whatsapp = String(settings?.store_whatsapp ?? '').replace(/\D/g, '');
  if (!text) {
    showEmpty(slot, { title: t('returns.empty') });
    return;
  }
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  slot.innerHTML = html`
    ${paragraphs.map((p) => html`<p style="white-space:pre-line">${p}</p>`)}
    ${whatsapp ? html`<p><a class="btn ghost" href="https://wa.me/${whatsapp}" target="_blank" rel="noopener">${t('returns.contact')}</a></p>` : ''}`.toString();
}

main();
