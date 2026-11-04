# Edge Function `admin-users` — deploy

Creates staff accounts, resets staff passwords and disables customer accounts. It needs the service role key, which
exists only inside Supabase (never in the frontend). The caller must be a signed-in, active owner.

## 1. SQL first
SQL Editor → paste and run `supabase/upgrade_07_staff_profiles.sql` (fresh install: run it after 01–03 and 02b; it is idempotent).

## 2. Deploy from the dashboard (no CLI)
1. Supabase Dashboard → your project → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Function name: `admin-users` (exactly).
3. Delete the sample code and paste the whole of `supabase/functions/admin-users/index.ts`.
4. Click **Deploy function**.
5. Open the function → **Details / Settings** → make sure **Verify JWT with legacy secret / Enforce JWT verification** is **ON** (default).
6. No secrets to add: `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

Re-deploy the same way after any change to the file (**Edit function** → paste → **Deploy**).

## 2b. Deploy from the CLI (Windows PowerShell), if you prefer
```powershell
cd D:\shami-cosmetics
npx supabase login
npx supabase functions deploy admin-users --project-ref dsqnjbeybzmqisojagdl
```
(Docker is not needed for `deploy` with a recent CLI. If it complains, add `--use-api`.)

## 3. Check
- Dashboard → Edge Functions → `admin-users` → **Logs** should be empty/healthy.
- In `/admin/staff.html` as owner: **إنشاء حساب موظف** → the credentials dialog appears.
- Calling the function from a browser without being an owner returns `{"ok":false,"code":"NOT_AUTHORIZED"}`.

## Auth settings that matter
- Authentication → URL Configuration: the site URL (and `https://YOUR-DOMAIN/admin/login.html` under Redirect URLs) so the e-mail change link in *ملفي* works.
- Authentication → Providers → Email: "Secure email change" ON (default) keeps the old address valid until the new one is confirmed.

## Limits worth knowing
- Disabling a customer bans the login immediately, but a session that is already open keeps working until its token expires (up to 1 hour).
- Resetting a staff password does not sign out their other open sessions; the forced password change blocks all admin access anyway (`is_staff()` / `is_owner()` are false until the password is changed).
