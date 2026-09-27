// Supabase client (loaded from CDN, no build step) + thin helpers that throw AppError codes.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { AppError, toAppError } from './utils.js';

export const isConfigured = /^https:\/\/[^/]+/.test(SUPABASE_URL)
  && !SUPABASE_URL.includes('YOUR-PROJECT-REF')
  && Boolean(SUPABASE_ANON_KEY)
  && !SUPABASE_ANON_KEY.startsWith('YOUR-');

if (!isConfigured) {
  console.warn('[supabase] Fill SUPABASE_URL and SUPABASE_ANON_KEY in /assets/js/config.js');
}

export const sb = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  : null;

export function requireClient() {
  if (!sb) throw new AppError('CONFIG_MISSING');
  return sb;
}

// const data = await run(sb.from('products').select('*').eq('active', true));
export async function run(queryBuilder) {
  const { data, error } = await queryBuilder;
  if (error) throw toAppError(error);
  return data;
}

// const order = await rpc('place_order', { ... }); throws AppError('OUT_OF_STOCK') etc.
// Lookups that must persist state on failure (track_order, cancel_own_order record failed
// attempts for brute-force protection) RETURN { error: 'CODE' } instead of raising; that is
// thrown here as the same AppError, so callers handle both styles identically.
export async function rpc(fn, args = {}) {
  let data;
  try {
    data = await run(requireClient().rpc(fn, args));
  } catch (err) {
    throw toAppError(err);
  }
  if (data && typeof data === 'object' && !Array.isArray(data)
      && typeof data.error === 'string' && Object.keys(data).length === 1) {
    throw new AppError(data.error);
  }
  return data;
}

export async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session ?? null;
}

// Returns an unsubscribe function.
export function onAuthChange(callback) {
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export function publicUrl(bucket, path) {
  if (!sb || !path) return '';
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
