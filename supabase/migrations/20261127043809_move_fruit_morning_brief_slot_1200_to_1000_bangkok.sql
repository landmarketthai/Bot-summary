-- Synchronize the 10:00 Bangkok fruit Morning Brief schedule with the
-- matching migration already applied to Supabase Production.
-- Keep all vegetable slots (14:00 through 18:00) unchanged.
DO $migration$
DECLARE
  v_def text;
  v_old text;
  v_new text;
  v_name text;
BEGIN
  FOR v_name IN SELECT unnest(ARRAY[
    'morning_brief_slot',
    'morning_brief_should_invoke',
    'morning_brief_dispatch'
  ]) LOOP
    SELECT pg_get_functiondef(p.oid) INTO STRICT v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_name = 'morning_brief_slot' THEN
      v_old := 'WHEN p_scope=''fruit'' AND minute>=720 AND minute<725 THEN 720';
      v_new := 'WHEN p_scope=''fruit'' AND minute>=600 AND minute<605 THEN 600';
    ELSE
      v_old := 'CASE WHEN p_scope=''fruit'' THEN 720 ELSE 840 END';
      v_new := 'CASE WHEN p_scope=''fruit'' THEN 600 ELSE 840 END';
    END IF;

    IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
      RAISE EXCEPTION 'Unexpected % definition (primary gate)', v_name;
    END IF;
    v_def := replace(v_def, v_old, v_new);

    IF v_name = 'morning_brief_dispatch' THEN
      v_old := 'CASE WHEN p_scope=''fruit'' THEN 720 ELSE 1080 END';
      v_new := 'CASE WHEN p_scope=''fruit'' THEN 600 ELSE 1080 END';
      IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
        RAISE EXCEPTION 'Unexpected % definition (final slot)', v_name;
      END IF;
      v_def := replace(v_def, v_old, v_new);
    END IF;

    EXECUTE v_def;
  END LOOP;
END $migration$;

-- The canonical Supabase pg_cron job is 03:00 UTC = 10:00 Bangkok.
-- Only the fruit job may be altered; leave vegetables untouched.
DO $schedule$
DECLARE v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id
    FROM cron.job
   WHERE jobname = 'daily-morning-brief' AND active
     AND schedule = '0 5 * * *'
     AND command = 'SELECT public.morning_brief_dispatch(''fruit'');';
  IF FOUND THEN
    PERFORM cron.alter_job(v_job_id, schedule => '0 3 * * *');
  END IF;
END $schedule$;
