-- OPERATOR ONLY. This file is never a migration. Default execution aborts.
-- First stage disabled dispatch_config rows using existing private HTTP SQL:
-- retain original URL, Authorization expression, headers, targets, timeout;
-- add explicit date=__BRIEF_DATE__ to GET params. Review in a private session.
-- target_keys must exactly equal SHA256 of each existing app target (UTF-8).
-- Do not print command_template, cron.command, backup.command, or headers.
-- Set LOCAL morning_brief_v3.activate = 'reviewed' in a deliberate transaction.
DO $activate$
DECLARE f cron.job; v cron.job; final_id bigint;
BEGIN
  IF current_setting('morning_brief_v3.activate',true) IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Staged activation requires operator review';
  END IF;
  IF coalesce(current_setting('cron.timezone',true),'') NOT IN ('GMT','UTC') THEN
    RAISE EXCEPTION 'Cron timezone must be verified UTC';
  END IF;
  SELECT * INTO STRICT f FROM cron.job WHERE jobname='daily-morning-brief';
  SELECT * INTO STRICT v FROM cron.job WHERE jobname='daily-morning-brief-vegetable';
  IF f.username<>current_user OR v.username<>current_user THEN
    RAISE EXCEPTION 'Activate as the existing cron owner; preserve execution identity';
  END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc
    WHERE oid='public.morning_brief_dispatch(text,timestamptz)'::regprocedure) IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'Dispatch execution owner must match the preserved cron owner';
  END IF;
  IF f.schedule <> '0 5 * * *' OR f.command NOT LIKE '%/api/cron/daily-morning-brief%'
    OR v.schedule <> '0 7 * * *' OR v.command NOT LIKE '%scope=vegetable%' THEN
    RAISE EXCEPTION 'Existing schedule/command differs from reviewed assumptions; inspect privately';
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE active AND jobid NOT IN(f.jobid,v.jobid)
    AND command LIKE '%daily-morning-brief%') THEN
    RAISE EXCEPTION 'Reconcile another active Morning Brief job first';
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='daily-morning-brief-vegetable-v3-final') THEN
    RAISE EXCEPTION 'Reserved final-slot job already exists; reconcile it before activation';
  END IF;
  IF (SELECT count(*) FROM morning_brief_private.morning_brief_dispatch_config
    WHERE NOT enabled AND scope IN ('fruit','vegetable') AND cardinality(target_keys)>0) <> 2 THEN
    RAISE EXCEPTION 'Both disabled dispatch configs must be privately staged and reviewed';
  END IF;
  IF EXISTS(SELECT 1 FROM morning_brief_private.morning_brief_cron_backup) THEN
    RAISE EXCEPTION 'Backup already exists: do not overwrite rollout history';
  END IF;
  INSERT INTO morning_brief_private.morning_brief_cron_backup(jobid,schedule,command,active) SELECT jobid,schedule,command,active
    FROM cron.job WHERE jobid IN(f.jobid,v.jobid);
  -- Keep Fruit at 12:00 Bangkok. Vegetable: eight slots plus the exact 18:00 final slot.
  PERFORM cron.alter_job(f.jobid,command := $cmd$SELECT public.morning_brief_dispatch('fruit');$cmd$);
  PERFORM cron.alter_job(v.jobid,schedule := '0,30 7-10 * * *',
    command := $cmd$SELECT public.morning_brief_dispatch('vegetable');$cmd$);
  final_id := cron.schedule('daily-morning-brief-vegetable-v3-final','0 11 * * *',
    $cmd$SELECT public.morning_brief_dispatch('vegetable');$cmd$);
  PERFORM cron.alter_job(final_id,active := v.active);
  UPDATE morning_brief_private.morning_brief_dispatch_config SET enabled=true;
END $activate$;
-- Safe verification columns only; never SELECT * FROM cron.job.
SELECT jobid,jobname,schedule,active FROM cron.job
  WHERE jobname IN ('daily-morning-brief','daily-morning-brief-vegetable','daily-morning-brief-vegetable-v3-final');
