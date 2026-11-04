-- =====================================================================
-- Shami Cosmetics — upgrade 08: update_my_profile()
--
-- /admin/profile.html used a PostgREST upsert on profiles. An upsert runs
--   INSERT ... ON CONFLICT (id) DO UPDATE SET id = excluded.id, full_name = ..., phone = ...
-- which needs UPDATE privilege on column "id"; only (full_name, phone) are granted → 403.
-- This RPC updates exactly the caller's own full_name + phone (validation stays in the profiles trigger).
-- Idempotent.
-- =====================================================================
create or replace function update_my_profile(p_full_name text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHORIZED'; end if;
  insert into profiles (id, full_name, phone) values (auth.uid(), p_full_name, p_phone)
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone;   -- trigger validates (INVALID_NAME / INVALID_PHONE)
  return (select jsonb_build_object('full_name', p.full_name, 'phone', p.phone) from profiles p where p.id = auth.uid());
end $$;

revoke execute on function update_my_profile(text, text) from public, anon;
grant execute on function update_my_profile(text, text) to authenticated;
