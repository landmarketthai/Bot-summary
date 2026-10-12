-- LOCAL TEST ONLY: use the installed retention trigger, never insert the ledger directly.
BEGIN;
DO $$ DECLARE n integer; BEGIN
  IF current_database() <> 'botsummary_baseline_replay_20261009b' OR current_user <> 'postgres'
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Require exact synthetic local PG17 target';
  END IF;
  UPDATE public.pending_sessions SET
    session_generation='61090000-0000-4000-8000-000000000007', accumulated_text='',
    finalization_status='expired_empty_draft', finalization_error='{"reason":"local_uat_rotation"}',
    close_requested_at=NULL, finalized_at=NULL, finalized_produce_session_id=NULL,
    created_at='2026-10-07T03:00:00Z', updated_at='2026-10-07T03:00:00Z'
  WHERE id='61090000-0000-4000-8000-000000000005'
    AND session_generation='61090000-0000-4000-8000-000000000006';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Refuse missing or reused generation'; END IF;
  IF NOT EXISTS (SELECT FROM public.pending_session_retired_generations
    WHERE session_generation='61090000-0000-4000-8000-000000000006'
      AND finalization_status='failed_closed'
      AND accountability_round_id='61090000-0000-4000-8000-000000000001'
      AND accumulated_text=E'น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\n1.มะม่วง 3 ลูก\nจบรายการชั่งคืน') THEN
    RAISE EXCEPTION 'Retained failure missing or changed';
  END IF;
END $$;
COMMIT;
