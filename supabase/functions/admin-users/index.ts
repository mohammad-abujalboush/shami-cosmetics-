// Edge Function: admin-users
// Owner-only account actions that need the Auth admin API (service role key stays server-side).
//
//   action: "create_staff"           { full_name, phone, email, role, job_title?, notes?, password }
//   action: "reset_password"         { user_id, password }
//   action: "set_customer_disabled"  { user_id, disabled }
//
// Every call verifies the caller's JWT and that they are an ACTIVE OWNER (no pending password change).
// Replies are always HTTP 200 JSON: { ok: true, ... } or { ok: false, code: "<ERROR_CODE>" } (codes are mapped
// to Arabic in the frontend). Non-owner / missing-JWT callers get { ok: false, code: "NOT_AUTHORIZED" }.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*", // auth is the JWT, not the origin; tighten to your domain if you like
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (code: string) => reply({ ok: false, code });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fail("NOT_FOUND");

  // 1. Who is calling? (JWT validated by Supabase Auth, not just decoded)
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return fail("NOT_AUTHORIZED");
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: who, error: whoErr } = await userClient.auth.getUser(jwt);
  if (whoErr || !who?.user) return fail("SESSION_EXPIRED");
  const caller = who.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: isOwner, error: ownerErr } = await admin.rpc("_is_active_owner", { p_uid: caller });
  if (ownerErr) return fail("UNKNOWN");
  if (isOwner !== true) return fail("NOT_AUTHORIZED");

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail("VALIDATION_FAILED"); }
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  try {
    switch (body.action) {
      case "create_staff": {
        const email = str(body.email).toLowerCase();
        const role = str(body.role);
        const password = typeof body.password === "string" ? body.password : "";
        const fullName = str(body.full_name);
        if (!EMAIL_RE.test(email)) return fail("EMAIL_INVALID");
        if (role !== "owner" && role !== "staff") return fail("INVALID_ROLE");
        if (password.length < 10) return fail("WEAK_PASSWORD");
        if (!fullName) return fail("INVALID_NAME");

        const { data: created, error: cErr } = await admin.auth.admin.createUser({
          email, password, email_confirm: true,
          user_metadata: { full_name: fullName },
        });
        if (cErr || !created?.user) {
          const msg = String(cErr?.message ?? "").toLowerCase();
          if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) return fail("EMAIL_EXISTS");
          if (msg.includes("password")) return fail("WEAK_PASSWORD");
          console.error("createUser", cErr);
          return fail("UNKNOWN");
        }
        const uid = created.user.id;
        const { error: fErr } = await admin.rpc("_finish_staff_create", {
          p_uid: uid, p_actor: caller, p_role: role, p_full_name: fullName,
          p_phone: str(body.phone), p_job_title: str(body.job_title), p_notes: str(body.notes),
        });
        if (fErr) {
          await admin.auth.admin.deleteUser(uid);          // roll back: no half-created account
          const m = String(fErr.message ?? "");
          return fail(/^[A-Z][A-Z0-9_]{2,}$/.test(m) ? m : "UNKNOWN");
        }
        return reply({ ok: true, user_id: uid });
      }

      case "reset_password": {
        const uid = str(body.user_id);
        const password = typeof body.password === "string" ? body.password : "";
        if (!UUID_RE.test(uid)) return fail("USER_NOT_FOUND");
        if (uid === caller) return fail("CANNOT_REMOVE_SELF");      // owners change their own password in "ملفي"
        if (password.length < 10) return fail("WEAK_PASSWORD");
        const { error: uErr } = await admin.auth.admin.updateUserById(uid, { password });
        if (uErr) { console.error("updateUser", uErr); return fail("UNKNOWN"); }
        const { error: lErr } = await admin.rpc("_log_reset_password", { p_uid: uid, p_actor: caller });
        if (lErr) {
          const m = String(lErr.message ?? "");
          return fail(/^[A-Z][A-Z0-9_]{2,}$/.test(m) ? m : "UNKNOWN");
        }
        return reply({ ok: true });
      }

      case "set_customer_disabled": {
        const uid = str(body.user_id);
        const disabled = body.disabled === true;
        if (!UUID_RE.test(uid)) return fail("USER_NOT_FOUND");
        if (uid === caller) return fail("CANNOT_REMOVE_SELF");
        // DB first: it refuses staff accounts and unknown users before we touch Auth.
        const { error: dErr } = await admin.rpc("_set_customer_disabled", { p_uid: uid, p_actor: caller, p_disabled: disabled });
        if (dErr) {
          const m = String(dErr.message ?? "");
          return fail(/^[A-Z][A-Z0-9_]{2,}$/.test(m) ? m : "UNKNOWN");
        }
        const { error: bErr } = await admin.auth.admin.updateUserById(uid, { ban_duration: disabled ? "876000h" : "none" });
        if (bErr) {
          await admin.rpc("_set_customer_disabled", { p_uid: uid, p_actor: caller, p_disabled: !disabled }); // undo
          console.error("ban", bErr);
          return fail("UNKNOWN");
        }
        return reply({ ok: true });
      }

      default:
        return fail("NOT_FOUND");
    }
  } catch (e) {
    console.error(e);
    return fail("UNKNOWN");
  }
});
