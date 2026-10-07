-- Change only the explicit close-count check in the current finalizer.
-- Preserve its locks, revision/close fences, deadlines, financial validation,
-- fingerprint reservations, containment, replacement and notification writes.
-- No data changes or recovery. Reapplying is a no-op; unexpected drift aborts.
BEGIN;
DO $migration$
DECLARE
  v_function regprocedure := to_regprocedure('public.try_finalize_pending_generation(text,uuid,text,integer,text,text,jsonb,jsonb,text[])');
  v_definition text;
  v_old text := $old$
  IF v_row.expected_item_count IS NOT NULL THEN
    IF jsonb_typeof(p_items) = 'array' THEN
      SELECT array_agg(n ORDER BY n) INTO v_missing
      FROM generate_series(1, v_row.expected_item_count) AS n
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS item
        WHERE COALESCE(item->>'item_number', '') ~ '^[0-9]+$'
          AND (item->>'item_number')::integer = n
      );
    ELSE
      SELECT array_agg(n ORDER BY n) INTO v_missing
      FROM generate_series(1, v_row.expected_item_count) AS n;
    END IF;
  END IF;
$old$;
  v_new text := $new$
  -- Human labels are metadata; the declared count is a row-count guarantee.
  IF v_row.expected_item_count IS NOT NULL AND v_item_count < v_row.expected_item_count THEN
    SELECT array_agg(n ORDER BY n) INTO v_missing
    FROM generate_series(v_item_count + 1, v_row.expected_item_count) AS n;
  END IF;
$new$;
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'produce item count: current 9-argument finalizer is missing';
  END IF;
  v_definition := replace(pg_get_functiondef(v_function), chr(13), '');
  IF strpos(v_definition, v_new) > 0 THEN RETURN; END IF;
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'produce item count: unexpected finalizer count-check definition';
  END IF;
  -- CREATE OR REPLACE retains the existing owner, signature and execute ACL.
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;
COMMIT;
