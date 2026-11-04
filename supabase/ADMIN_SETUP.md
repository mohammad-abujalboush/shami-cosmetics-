# Admin core — setup

## SQL to run (existing project)

1. `upgrade_05_admin_core.sql` (adds `staff_overview()` and publishes `orders` to Realtime). Fresh installs get it from `03_functions.sql` + `02b_grants.sql`.
2. `upgrade_06_admin_pages.sql` (staff names, staff activation, coupon stats, sales report).
3. `upgrade_07_staff_profiles.sql` (profiles, forced password change, customers, activity log) + deploy the Edge Function: see `ADMIN_USERS_DEPLOY.md`.
3. The tests listed in `supabase/TESTS_TODO.md`.

## Realtime (new-order notification + sound)

The SQL above already does the one thing needed. In the dashboard you only verify it:

1. **Database → Publications → `supabase_realtime`**: the table **`orders`** must be switched on (and nothing else private: not `staff`, `coupons`, `settings`, `order_notes`, `profiles`, `addresses`). If it is off, switch it on there instead of running the SQL.
2. **Project Settings → API → Realtime** (or **Realtime → Settings**): Realtime must be enabled (default on). Leave "Allow public access" alone: it only concerns Broadcast/Presence channels; the admin panel uses *Postgres Changes*.
3. Nothing else: no extra RLS policy is needed. Postgres Changes evaluates the table's `SELECT` policy (`orders: read own or staff`) for each subscriber's JWT, so staff receive every new order, a customer receives only their own, guests receive nothing.

Security check: the only data that reaches the browser is the `orders` row, and only to users the SELECT policy allows. The admin page uses the event for the toast and counter only; the list is re-read through the normal API.

Notes: browsers only allow sound after a click on the page, so the first click anywhere unlocks it; the top-bar button turns the sound on/off (remembered per browser). The green dot in the top bar means the Realtime channel is connected.

## Click-through checklist

Moved to `TESTING_CHECKLIST.md` at the project root (section 3 covers the admin core).
