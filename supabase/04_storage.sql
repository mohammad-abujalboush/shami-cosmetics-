-- =====================================================================
-- Shami Cosmetics — 04 storage buckets & policies
-- Run after 03_functions.sql.
--
-- product-images : public read (public bucket URLs), only the owner uploads/changes/deletes.
-- payment-proofs : private. Guests/customers may only INSERT into
--                  <public_token>/<file>.(jpg|jpeg|png|webp|heic|heif) of a CliQ order that is
--                  still awaiting transfer. Max 5 MB, images only. No one but the owner can read
--                  (via signed URLs). Staff cannot read. No updates/overwrites.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-images', 'product-images', true,  5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/avif']),
  ('payment-proofs', 'payment-proofs', false, 5242880,
   array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- True only for "<token>/<name>.<image ext>" where <token> is an unpaid CliQ order's public_token.
create or replace function can_upload_payment_proof(object_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_parts text[] := string_to_array(coalesce(object_name, ''), '/');
begin
  if coalesce(array_length(v_parts, 1), 0) <> 2 then
    return false;
  end if;
  if v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if lower(v_parts[2]) !~ '^[a-z0-9_-]{1,80}\.(jpe?g|png|webp|heic|heif)$' then
    return false;
  end if;
  return exists (
    select 1 from orders o
    where o.public_token = v_parts[1]::uuid
      and o.payment_method = 'cliq'
      and o.payment_status = 'awaiting_transfer'
      and o.status not in ('cancelled', 'returned')
  );
end $$;

revoke execute on function can_upload_payment_proof(text) from public, anon, authenticated;
grant execute on function can_upload_payment_proof(text) to anon, authenticated, service_role;

-- ---------- product-images ----------
drop policy if exists "shami product-images owner insert" on storage.objects;
drop policy if exists "shami product-images owner update" on storage.objects;
drop policy if exists "shami product-images owner delete" on storage.objects;

create policy "shami product-images owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_owner());

create policy "shami product-images owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images' and public.is_owner())
  with check (bucket_id = 'product-images' and public.is_owner());

create policy "shami product-images owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and public.is_owner());

-- ---------- payment-proofs ----------
drop policy if exists "shami payment-proofs upload for unpaid cliq order" on storage.objects;
drop policy if exists "shami payment-proofs owner read" on storage.objects;

create policy "shami payment-proofs upload for unpaid cliq order" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'payment-proofs' and public.can_upload_payment_proof(name));

-- Owner only (createSignedUrl needs SELECT). Staff intentionally have no policy.
create policy "shami payment-proofs owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and public.is_owner());
