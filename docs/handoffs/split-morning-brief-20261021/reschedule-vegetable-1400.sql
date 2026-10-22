-- Operator-only schedule change. Do not execute on Production without explicit approval.
-- Update the existing job; preserve its command, recipients, auth and active state.
do $reschedule$
declare
  vegetable_job_id bigint;
begin
  if coalesce(current_setting('cron.timezone', true), '') not in ('GMT', 'UTC') then
    raise exception 'Expected UTC Cron timezone; inspect before changing the schedule';
  end if;

  select jobid into strict vegetable_job_id
  from cron.job
  where jobname = 'daily-morning-brief-vegetable'
    and command like '%/api/cron/daily-morning-brief%'
    and command like '%scope=vegetable%';

  if exists (
    select 1 from cron.job
    where jobid <> vegetable_job_id and active
      and command like '%/api/cron/daily-morning-brief%'
      and command like '%scope=vegetable%'
  ) then
    raise exception 'Another active Vegetable job exists; reconcile duplicates before rescheduling';
  end if;

  perform cron.alter_job(job_id := vegetable_job_id, schedule := '0 7 * * *');
end
$reschedule$;

select jobid, jobname, schedule, active
from cron.job
where jobname in ('daily-morning-brief', 'daily-morning-brief-vegetable')
order by jobid;
