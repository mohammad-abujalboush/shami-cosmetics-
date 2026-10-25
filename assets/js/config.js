// Public runtime configuration. Everything in this file ships to the browser.
// Use ONLY the anon / publishable key here — never the service_role / secret key.

export const SUPABASE_URL = 'https://dsqnjbeybzmqisojagdl.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzcW5qYmV5YnptcWlzb2phZ2RsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MjgxODIsImV4cCI6MjEwNjAwNDE4Mn0.5MRQ3w43DazQFW1vn66ZMRzIYGw7fZj9FbVM2v7BfV4';

export const STORE_TIMEZONE = 'Asia/Amman';

export const STORAGE_KEYS = {
  // Cart lives in localStorage as [{ variant_id, qty }] — IDs and quantities only, never prices.
  cart: 'shami_cart_v1',
  // sessionStorage cache for header/footer data (public settings + categories).
  siteData: 'shami_site_data_v2',
};

export const SITE_DATA_TTL_MS = 5 * 60 * 1000;

export const PRODUCT_IMAGES_BUCKET = 'product-images';
export const SHOP_PAGE_SIZE = 12;
