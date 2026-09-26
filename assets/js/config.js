// Public runtime configuration. Everything in this file ships to the browser.
// Use ONLY the anon / publishable key here — never the service_role / secret key.

export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';

export const STORE_TIMEZONE = 'Asia/Amman';

export const STORAGE_KEYS = {
  // Cart lives in localStorage as [{ variant_id, qty }] — IDs and quantities only, never prices.
  cart: 'shami_cart_v1',
  // sessionStorage cache for header/footer data (public settings + categories).
  siteData: 'shami_site_data_v1',
};

export const SITE_DATA_TTL_MS = 5 * 60 * 1000;
