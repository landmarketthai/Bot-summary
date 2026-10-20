-- Read-only verification, local pr184_uat only. Source identities scope every financial count.
WITH main AS (
 SELECT t.* FROM public.produce_transactions t JOIN public.raw_messages r ON r.id=t.raw_message_id
 WHERE r.source_id='C-pr184-uat-pasio' AND t.transaction_date='2026-10-19'
), additional AS (
 SELECT t.* FROM public.produce_transactions t JOIN public.raw_messages r ON r.id=t.raw_message_id
 WHERE r.source_id='C-pr184-uat-additional'
), expired AS (
 SELECT t.* FROM public.produce_transactions t JOIN public.raw_messages r ON r.id=t.raw_message_id
 WHERE r.source_id='C-pr184-uat-expiry'
)
SELECT jsonb_pretty(jsonb_build_object(
 'environment',jsonb_build_object('database',current_database(),'serverAddress',inet_server_addr(),'serverPort',inet_server_port(),'currentUser',current_user,'productionCredentialsUsed',false),
 'main',jsonb_build_object(
  'withdrawalDocuments',(SELECT count(DISTINCT session_id) FROM main WHERE base_transaction_type='เบิก'),
  'withdrawalRows',(SELECT count(*) FROM main WHERE base_transaction_type='เบิก'),
  'withdrawalBaht',(SELECT sum(total_amount) FROM main WHERE base_transaction_type='เบิก'),
  'returnDocuments',(SELECT count(DISTINCT session_id) FROM main WHERE base_transaction_type='คืน'),
  'returnRows',(SELECT count(*) FROM main WHERE base_transaction_type='คืน'),
  'returnBaht',(SELECT sum(total_amount) FROM main WHERE base_transaction_type='คืน'),
  'documentDifferenceBaht',(SELECT sum(CASE WHEN base_transaction_type='เบิก' THEN total_amount ELSE -total_amount END) FROM main),
  'products',(SELECT jsonb_agg(x) FROM (SELECT product_name,base_transaction_type,quantity,price_per_unit,total_amount FROM main ORDER BY base_transaction_type,product_name,item_number) x)
 ),
 'additional',(SELECT jsonb_build_object('documents',count(DISTINCT session_id),'rows',count(*),'baht',sum(total_amount),'quantity',sum(quantity)) FROM additional),
 'expiryRecovery',(SELECT jsonb_build_object('documents',count(DISTINCT session_id),'rows',count(*),'baht',sum(total_amount)) FROM expired),
 'duplicateReviews',(SELECT jsonb_agg(jsonb_build_object('exceptions',exceptions,'confirmed',confirmed_at IS NOT NULL,'presentedEvent',presented_line_event_id,'confirmedEvent',confirmed_line_event_id)) FROM public.produce_entry_validation_reviews WHERE session_key LIKE '%C-pr184-uat-pasio%')
));
