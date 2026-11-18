-- OPERATOR ONLY. Run in one deliberate transaction, after suspending delivery.
DO $rollback$
DECLARE b morning_brief_private.morning_brief_cron_backup; j bigint;
BEGIN
  IF current_setting('morning_brief_v3.rollback',true) IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Rollback requires operator review';
  END IF;
  IF (SELECT count(*) FROM morning_brief_private.morning_brief_cron_backup) <> 2 THEN
    RAISE EXCEPTION 'Rollback requires the two original job backups';
  END IF;
  IF EXISTS(SELECT 1 FROM morning_brief_private.morning_brief_cron_backup backup_row
    LEFT JOIN cron.job cron_row ON cron_row.jobid=backup_row.jobid
    WHERE backup_row.owner_name<>current_user OR cron_row.jobid IS NULL OR cron_row.username<>current_user) THEN
    RAISE EXCEPTION 'Rollback requires the preserved cron owner and original jobs';
  END IF;
  UPDATE morning_brief_private.morning_brief_dispatch_config SET enabled=false;
  FOR b IN SELECT * FROM morning_brief_private.morning_brief_cron_backup LOOP
    -- Restoring an active old sender can ignore the durable ledger. Restore
    -- schedules/auth exactly, but keep delivery suspended for reconciliation.
    PERFORM cron.alter_job(b.jobid,schedule:=b.schedule,command:=b.command,active:=false);
  END LOOP;
  SELECT jobid INTO j FROM cron.job WHERE jobname='daily-morning-brief-vegetable-v3-final'
    AND command=$cmd$SELECT public.morning_brief_dispatch('vegetable');$cmd$;
  IF j IS NOT NULL THEN PERFORM cron.unschedule(j); END IF;
END $rollback$;
-- Preserve ledger, check history, backups, private artifact paths and ref JSON.
-- Do not re-enable legacy active flags until all accepted/unknown deliveries
-- have been reconciled, or a legacy app can resend them.
