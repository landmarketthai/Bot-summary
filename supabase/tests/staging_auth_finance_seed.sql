-- LOCAL TEST ONLY. Plain INSERT intentionally refuses a reused fixture.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'botsummary_baseline_replay_20261009b' OR current_user <> 'postgres'
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Require exact synthetic local PG17 target';
  END IF;
END $$;
INSERT INTO public.accountability_rounds
  (id,source_type,source_id,owner_line_user_id,business_date,seller_label,market_label,market_label_normalized,created_line_event_id)
VALUES ('61090000-0000-4000-8000-000000000001','group','uat-20261009-finance','uat-20261009-owner',
  '2026-10-07','น้อย','ราชพฤกษ์','ราชพฤกษ์','uat-20261009-finance-round');
INSERT INTO public.raw_messages
  (id,line_event_id,destination,event_type,source_type,source_id,user_id,message_type,raw_text,payload,is_processed,created_at)
VALUES ('61090000-0000-4000-8000-000000000002','uat-20261009-finance-withdraw','uat-20261009-channel',
  'message','group','uat-20261009-finance','uat-20261009-owner','text',
  E'น้อย-ราชพฤกษ์ เบิก 7/10/2569\n1.มะม่วง 10 ลูก 10 บาท\nจบรายการเบิก',
  jsonb_build_object('timestamp',extract(epoch FROM timestamptz '2026-10-07T01:00:00Z')*1000),true,'2026-10-07T01:00:00Z');
INSERT INTO public.produce_sessions
  (id,raw_message_id,line_user_id,staff_name,session_date,session_title,total_items,parser_errors,transaction_time,session_kind,accountability_round_id,created_at,finalized_at)
VALUES ('61090000-0000-4000-8000-000000000003','61090000-0000-4000-8000-000000000002',
  'uat-20261009-owner','น้อย','2026-10-07','ราชพฤกษ์',1,NULL,'','main',
  '61090000-0000-4000-8000-000000000001','2026-10-07T01:01:00Z','2026-10-07T01:01:00Z');
INSERT INTO public.produce_items
  (id,session_id,item_number,product_name,price_per_unit,quantity,unit,section,transaction_type,created_at)
VALUES ('61090000-0000-4000-8000-000000000004','61090000-0000-4000-8000-000000000003',
  1,'มะม่วง',10,10,'ลูก','main','เบิก','2026-10-07T01:01:00Z');
-- Legacy text carries full identity; partial structured metadata is invalid.
INSERT INTO public.pending_sessions
  (id,session_key,source_id,line_user_id,session_generation,accumulated_text,finalization_status,terminalized,
   finalization_error,accountability_round_id,created_at,updated_at,close_requested_at,runtime_environment)
VALUES ('61090000-0000-4000-8000-000000000005','group:uat-20261009-finance:user:uat-20261009-owner',
  'uat-20261009-finance','uat-20261009-owner','61090000-0000-4000-8000-000000000006',
  E'น้อย-ราชพฤกษ์ ชั่งคืน 7/10/2569\n1.มะม่วง 3 ลูก\nจบรายการชั่งคืน','failed_closed',true,
  '{"reason":"local_uat_incomplete_return"}', '61090000-0000-4000-8000-000000000001',
  '2026-10-07T02:00:00Z','2026-10-07T02:00:00Z','2026-10-07T02:00:00Z','development');
COMMIT;
