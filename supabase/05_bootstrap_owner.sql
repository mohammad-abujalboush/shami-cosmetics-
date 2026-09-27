-- =====================================================================
-- Shami Cosmetics — 05 bootstrap the first owner (run once, by hand)
--
-- 1. Create your account first: sign up on the site (/account/register.html) or
--    Supabase Dashboard → Authentication → Users → "Add user" (tick "Auto Confirm User").
-- 2. Replace the email below, uncomment, and run.
-- 3. From then on, add more staff/owners from the admin panel (add_staff RPC).
-- =====================================================================

insert into public.staff (user_id, role, active)
select u.id, 'owner', true
from auth.users u
 where lower(u.email) = lower('moe.abujalboush@gmail.com');
 on conflict (user_id) do update set role = 'owner', active = true;

-- Check (must return exactly one row with role = owner):
 select s.user_id, u.email, s.role, s.active
 from public.staff s join auth.users u on u.id = s.user_id;
