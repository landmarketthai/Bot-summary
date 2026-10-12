-- TEST ONLY: unused August workload on the owned synthetic c database.
-- Retained rows below are benchmark seeding, not retention-trigger evidence.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'botsummary_baseline_replay_20261009c' OR current_user <> 'postgres'
    OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN
    RAISE EXCEPTION 'Require exact synthetic local PG17 c target';
  END IF;
  IF EXISTS (SELECT FROM public.produce_sessions WHERE session_date >= '2026-08-01' AND session_date < '2026-09-01')
    OR EXISTS (SELECT FROM public.accountability_rounds WHERE business_date >= '2026-08-01' AND business_date < '2026-09-01')
    OR EXISTS (SELECT FROM public.settlement_entries WHERE settlement_date >= '2026-08-01' AND settlement_date < '2026-09-01')
    OR EXISTS (SELECT FROM public.pending_session_retired_generations WHERE business_date >= '2026-08-01' AND business_date < '2026-09-01')
    OR EXISTS (SELECT FROM public.raw_messages WHERE source_id='uat-20261010-month31')
    OR EXISTS (SELECT FROM public.pending_sessions WHERE source_id='uat-20261010-month31') THEN
    RAISE EXCEPTION 'Refuse existing August workload or reused fixture';
  END IF;
END $$;
CREATE TEMP TABLE uat_month_rounds ON COMMIT DROP AS
SELECT gen_random_uuid() AS round_id, date '2026-08-01' + day_number AS business_date,
  'ผู้ขาย' || translate(seller_number::text,'0123456789','๐๑๒๓๔๕๖๗๘๙') AS seller, 'uat-20261010-month-owner-' || seller_number AS owner_id
FROM generate_series(0,30) AS day_number CROSS JOIN generate_series(0,9) AS seller_number;
INSERT INTO public.accountability_rounds
  (id,source_type,source_id,owner_line_user_id,business_date,seller_label,market_label,market_label_normalized,created_line_event_id,created_at,updated_at)
SELECT round_id,'group','uat-20261010-month31',owner_id,business_date,seller,'ราชพฤกษ์','ราชพฤกษ์',
  'uat-20261010-month-round-' || round_id,
  business_date + time '08:00:00' AT TIME ZONE 'UTC',business_date + time '08:00:00' AT TIME ZONE 'UTC'
FROM uat_month_rounds;
CREATE TEMP TABLE uat_month_docs ON COMMIT DROP AS
SELECT r.*,gen_random_uuid() AS raw_id,gen_random_uuid() AS session_id,kind,
  CASE kind WHEN 'เบิก' THEN 'เบิก' WHEN 'คืน' THEN 'ชั่งคืน' ELSE 'ชั่งคืนเสีย' END AS header_kind
FROM uat_month_rounds r CROSS JOIN (VALUES ('เบิก'),('คืน'),('คืนเสีย')) AS kinds(kind);
INSERT INTO public.raw_messages
  (id,line_event_id,destination,event_type,source_type,source_id,user_id,message_type,raw_text,payload,is_processed,created_at)
SELECT raw_id,'uat-20261010-month-doc-' || raw_id,'uat-20261010-month-channel','message','group',
  'uat-20261010-month31',owner_id,'text',seller || '-ราชพฤกษ์ ' || header_kind || ' ' || extract(day FROM business_date)::int || '/8/2569',
  jsonb_build_object('timestamp',extract(epoch FROM (business_date + time '08:00:00' AT TIME ZONE 'UTC'))*1000),
  true,business_date + time '08:00:00' AT TIME ZONE 'UTC' FROM uat_month_docs;
INSERT INTO public.produce_sessions
  (id,raw_message_id,line_user_id,staff_name,session_date,session_title,total_items,parser_errors,transaction_time,session_kind,accountability_round_id,created_at,finalized_at)
SELECT session_id,raw_id,owner_id,seller,business_date,'ราชพฤกษ์',5,NULL,'','main',round_id,
  business_date + time '08:00:00' AT TIME ZONE 'UTC',business_date + time '12:00:00' AT TIME ZONE 'UTC'
FROM uat_month_docs;
INSERT INTO public.produce_items
  (id,session_id,item_number,product_name,price_per_unit,quantity,unit,section,transaction_type,created_at)
SELECT gen_random_uuid(),d.session_id,p.item_number,p.product_name,100,CASE WHEN d.kind='เบิก' THEN 10 ELSE 1 END,
  'โล','main',d.kind,d.business_date + time '08:00:00' AT TIME ZONE 'UTC'
FROM uat_month_docs d CROSS JOIN (VALUES (1,'หมอนทอง'),(2,'มังคุด'),(3,'ลองกอง'),(4,'มะม่วง'),(5,'มะนาว')) AS p(item_number,product_name);
INSERT INTO public.pending_session_retired_generations
  (session_generation,session_key,source_id,line_user_id,accumulated_text,finalization_status,finalization_error,
   accountability_round_id,business_date,staff_label,market_label,declared_transaction_type,generation_created_at,close_requested_at,close_refused_at)
SELECT gen_random_uuid(),'group:uat-20261010-month31:user:' || r.owner_id || ':draft-' || generation,
  'uat-20261010-month31',r.owner_id,r.seller || '-ราชพฤกษ์ ชั่งคืน ' || extract(day FROM r.business_date)::int || E'/8/2569\n1.หมอนทอง 1 โล\nจบรายการชั่งคืน',
  'failed_closed',jsonb_build_object('reason','synthetic_monthly_benchmark'),r.round_id,r.business_date,r.seller,'ราชพฤกษ์','คืน',
  r.business_date + time '15:00:00' AT TIME ZONE 'UTC',r.business_date + time '15:00:00' AT TIME ZONE 'UTC',r.business_date + time '15:00:00' AT TIME ZONE 'UTC'
FROM uat_month_rounds r CROSS JOIN generate_series(0,1) AS generation;
DO $$ BEGIN
  IF (SELECT count(*) FROM uat_month_rounds)<>310 OR (SELECT count(*) FROM uat_month_docs)<>930
    OR (SELECT count(*) FROM public.produce_transactions t JOIN public.raw_messages m ON m.id=t.raw_message_id WHERE m.source_id='uat-20261010-month31')<>4650
    OR (SELECT count(*) FROM public.pending_session_retired_generations WHERE source_id='uat-20261010-month31')<>620 THEN
    RAISE EXCEPTION 'Unexpected monthly workload counts';
  END IF;
END $$;
COMMIT;
