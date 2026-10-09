-- =====================================================================
-- The three private storage buckets, created by a migration at last.
--
-- Spec: docs/tapswipe_crm_schema.sql (SUPABASE STORAGE), updated first.
--
-- Until now no bucket was in any migration. The hosted ones were made by
-- hand and the local ones by test helpers, and `marketing` was never made
-- on dev -- so every marketing upload there failed with "Could not create
-- upload URL: The related resource does not exist" while the helpers, which
-- created the bucket themselves, kept every suite green.
--
-- Idempotent: `on conflict (id) do nothing` fills in a missing bucket and
-- never touches an existing one, so this cannot change a live bucket's
-- privacy or limit.
--
-- The guard exists for the PGlite suite only, which has no storage schema.
-- On a real Supabase stack storage.buckets exists before migrations run.
--
-- No policy on storage.objects, by design: all access is a signed URL minted
-- by a service-role Edge Function after it has authorized the caller.
-- =====================================================================
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values
    ('documents',        'documents',        false, 52428800),
    ('residual-imports', 'residual-imports', false, 52428800),
    ('marketing',        'marketing',        false, 52428800)
  on conflict (id) do nothing;
end
$$;
