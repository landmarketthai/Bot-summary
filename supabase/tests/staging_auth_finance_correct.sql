-- LOCAL TEST ONLY: backing-table correction, not parser/ingestion E2E.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'botsummary_baseline_replay_20261009b' OR current_user <> 'postgres'
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Require exact synthetic local PG17 target';
  END IF;
  IF NOT EXISTS (SELECT FROM public.pending_session_retired_generations
    WHERE session_generation='61090000-0000-4000-8000-000000000006' AND finalization_status='failed_closed') THEN
    RAISE EXCEPTION 'Must first verify retained failure';
  END IF;
END $$;
INSERT INTO public.raw_messages
  (id,line_event_id,destination,event_type,source_type,source_id,user_id,message_type,raw_text,payload,is_processed,created_at)
VALUES ('61090000-0000-4000-8000-000000000008','uat-20261009-finance-return','uat-20261009-channel',
  'message','group','uat-20261009-finance','uat-20261009-owner','text',
  E'น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\n1.มะม่วง 3 ลูก\nจบรายการชั่งคืน',
  jsonb_build_object('timestamp',extract(epoch FROM timestamptz '2026-10-07T04:00:00Z')*1000),true,'2026-10-07T04:00:00Z');
INSERT INTO public.produce_sessions
  (id,raw_message_id,line_user_id,staff_name,session_date,session_title,total_items,parser_errors,transaction_time,session_kind,accountability_round_id,created_at,finalized_at)
VALUES ('61090000-0000-4000-8000-000000000009','61090000-0000-4000-8000-000000000008',
  'uat-20261009-owner','น้อย','2026-10-07','ราชพฤกษ์',1,NULL,'','main',
  '61090000-0000-4000-8000-000000000001','2026-10-07T04:01:00Z','2026-10-07T04:01:00Z');
INSERT INTO public.produce_items
  (id,session_id,item_number,product_name,price_per_unit,quantity,unit,section,transaction_type,created_at)
VALUES ('61090000-0000-4000-8000-00000000000a','61090000-0000-4000-8000-000000000009',
  1,'มะม่วง',10,3,'ลูก','main','คืน','2026-10-07T04:01:00Z');
COMMIT;
