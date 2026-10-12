-- TEST-ONLY fresh replay name normalization, never a Production migration.
-- 20260731111743 adds plain UNIQUE(source_id,business_date) only if no
-- equivalent already exists; on a fresh 0029 DB the existing constraint is
-- named transfer_reconciliations_source_id_business_date_key. The later P2E
-- CONTRACT asserts and drops the same constraint under the historical name
-- transfer_reconciliations_source_date_key. Reconcile NAME only, with strict
-- exact-column and unique-type checks. No row/data/identity changes.
DO $staging_name$
DECLARE
  v_db text := current_database();
BEGIN
  IF v_db NOT IN ('botsummary_baseline_replay_20261009b',
                  'botsummary_baseline_replay_20261009c')
     OR current_user <> 'postgres'
     OR current_setting('server_version_num')::integer < 170000
     OR current_setting('server_version_num')::integer >= 180000 THEN
    RAISE EXCEPTION 'Test-only P2E constraint rename refused outside approved isolated PG17';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.transfer_reconciliations'::regclass
      AND c.conname = 'transfer_reconciliations_source_id_business_date_key'
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) = 'UNIQUE (source_id, business_date)'
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.transfer_reconciliations'::regclass
      AND c.conname = 'transfer_reconciliations_source_date_key'
  ) THEN
    RAISE EXCEPTION 'Legacy constraint does not match exact expected identity';
  END IF;
  ALTER TABLE public.transfer_reconciliations
    RENAME CONSTRAINT transfer_reconciliations_source_id_business_date_key
    TO transfer_reconciliations_source_date_key;
END;
$staging_name$;
