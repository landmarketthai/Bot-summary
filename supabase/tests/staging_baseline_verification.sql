-- TEST ONLY. Executed after all 130 unchanged migrations, never on Production.
-- 0044/0048 and later migrations also run their own assertions during replay.
BEGIN;
DO $$
DECLARE
  v_name text;
  v_role text;
  v_privilege text;
  v_expected record;
  v_generation uuid;
  v_new_generation uuid;
BEGIN
  -- Actual financial read prerequisites (sales/load.ts, white-sheet/persist.ts).
  FOREACH v_name IN ARRAY ARRAY[
    'raw_messages', 'produce_sessions', 'produce_items', 'produce_transactions',
    'parse_errors', 'imported_sessions', 'pending_sessions',
    'pending_session_ingest', 'pending_session_admission',
    'pending_session_retired_generations', 'pending_produce_deferred_events',
    'accountability_rounds', 'central_selling_prices', 'settlement_entries',
    'digital_white_sheet_cash_entries', 'white_sheet_lifecycle_events',
    'white_sheet_review_turns', 'produce_session_notifications',
    'produce_notification_attempts', 'line_menu_states'
  ] LOOP
    IF to_regclass('public.' || v_name) IS NULL THEN
      RAISE EXCEPTION 'Missing required relation public.%', v_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT FROM pg_class WHERE oid = 'public.produce_transactions'::regclass AND relkind = 'v') THEN
    RAISE EXCEPTION 'produce_transactions must remain a view';
  END IF;

  -- Type/nullability/default shape from historical 0042, 0034, P2E expand,
  -- and 20261008150000. More complete historical PK/FK assertions run in 0044.
  FOR v_expected IN SELECT * FROM (VALUES
    ('pending_sessions', 'session_generation', 'uuid', true, 'gen_random_uuid()'),
    ('pending_sessions', 'close_event_timestamp_ms', 'bigint', false, NULL),
    ('pending_sessions', 'close_requested_at', 'timestamp with time zone', false, NULL),
    ('pending_sessions', 'finalization_status', 'text', true, '''pending''::text'),
    ('pending_sessions', 'finalized_produce_session_id', 'uuid', false, NULL),
    ('pending_sessions', 'accountability_round_id', 'uuid', false, NULL),
    ('pending_session_ingest', 'raw_text', 'text', true, NULL),
    ('pending_session_admission', 'admitted_at', 'timestamp with time zone', true, 'now()'),
    ('pending_session_retired_generations', 'accumulated_text', 'text', true, NULL),
    ('pending_session_retired_generations', 'retired_at', 'timestamp with time zone', true, 'now()')
  ) AS expected(tbl, col, typ, required, def) LOOP
    IF NOT EXISTS (
      SELECT FROM pg_attribute a LEFT JOIN pg_attrdef d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = ('public.' || v_expected.tbl)::regclass
        AND a.attname = v_expected.col AND NOT a.attisdropped
        AND format_type(a.atttypid, a.atttypmod) = v_expected.typ
        AND a.attnotnull = v_expected.required
        AND pg_get_expr(d.adbin, d.adrelid) IS NOT DISTINCT FROM v_expected.def
    ) THEN
      RAISE EXCEPTION 'Column shape mismatch %.%', v_expected.tbl, v_expected.col;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT FROM pg_constraint WHERE conrelid = 'public.pending_sessions'::regclass
      AND contype = 'f' AND confrelid = 'public.produce_sessions'::regclass
      AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (finalized_produce_session_id)%'
  ) THEN
    RAISE EXCEPTION 'Missing real 0034 finalization FK (partial fixture is insufficient)';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pgcrypto' AND n.nspname = 'extensions')
    OR NOT EXISTS (SELECT FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pg_trgm' AND n.nspname = 'extensions') THEN
    RAISE EXCEPTION 'Extension schema mismatch';
  END IF;

  -- Current RPC identities from 0048, generation rotation and White Sheet DDL.
  FOR v_expected IN SELECT * FROM (VALUES
    ('register_pending_session_ingest(text,text,bigint,text)', 'void'),
    ('check_pending_close_ready(text)', 'jsonb'),
    ('append_pending_session(text,text,text,text,bigint,boolean,uuid,integer)', 'jsonb'),
    ('open_pending_plain_text_generation(text,text,text,text,bigint,text,text,boolean,integer,uuid,text)', 'jsonb'),
    ('finalize_white_sheet_cash_entry(text,text,date,uuid,text)', 'digital_white_sheet_cash_entries'),
    ('reopen_white_sheet_cash_entry(text,text,date,uuid,text,text)', 'digital_white_sheet_cash_entries')
  ) AS expected(identity, result) LOOP
    IF to_regprocedure('public.' || v_expected.identity) IS NULL THEN
      RAISE EXCEPTION 'Missing RPC %', v_expected.identity;
    END IF;
    IF replace(pg_get_function_result(('public.' || v_expected.identity)::regprocedure), 'public.', '') <> v_expected.result
      OR NOT has_function_privilege('service_role', ('public.' || v_expected.identity)::regprocedure, 'EXECUTE')
      OR has_function_privilege('anon', ('public.' || v_expected.identity)::regprocedure, 'EXECUTE')
      OR has_function_privilege('authenticated', ('public.' || v_expected.identity)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'RPC result/ACL mismatch %', v_expected.identity;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT FROM pg_trigger WHERE tgrelid = 'public.pending_sessions'::regclass
      AND tgname = 'pending_sessions_retain_unresolved_generation' AND tgenabled = 'O'
      AND tgfoid = 'public.pending_sessions_retain_unresolved_generation()'::regprocedure
  ) THEN RAISE EXCEPTION 'Missing/enabled retention trigger mismatch'; END IF;
  IF EXISTS (
    SELECT FROM pg_proc WHERE oid = 'public.pending_sessions_retain_unresolved_generation()'::regprocedure
      AND (NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[])
  ) THEN RAISE EXCEPTION 'Retention definer/search_path drift'; END IF;
  IF EXISTS (
    SELECT FROM pg_proc p,
      LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid = 'public.pending_sessions_retain_unresolved_generation()'::regprocedure
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) THEN RAISE EXCEPTION 'PUBLIC can execute retention function'; END IF;

  -- The recovered ledger RLS is an explicit local test condition, not a claim
  -- about historical Production. Evidence ACL contracts come from migrations.
  FOREACH v_name IN ARRAY ARRAY[
    'pending_sessions', 'pending_session_ingest', 'pending_session_admission',
    'pending_session_retired_generations', 'white_sheet_review_turns',
    'produce_session_notifications', 'produce_notification_attempts',
    'line_menu_states', 'line_operator_identities', 'line_guided_menu_markets'
  ] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_name)::regclass) THEN
      RAISE EXCEPTION 'RLS disabled on %', v_name;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
        IF has_table_privilege(v_role, ('public.' || v_name)::regclass, v_privilege) THEN
          RAISE EXCEPTION 'Unexpected % % on %', v_role, v_privilege, v_name;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  FOREACH v_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
    IF has_table_privilege('service_role', 'public.pending_session_retired_generations', v_privilege)
       IS DISTINCT FROM (v_privilege = 'SELECT') THEN
      RAISE EXCEPTION 'Retired evidence service-role ACL mismatch %', v_privilege;
    END IF;
    IF has_table_privilege('service_role', 'public.white_sheet_review_turns', v_privilege)
       IS DISTINCT FROM (v_privilege IN ('SELECT','INSERT','DELETE')) THEN
      RAISE EXCEPTION 'Review-turn service-role ACL mismatch %', v_privilege;
    END IF;
  END LOOP;

  -- Real full-schema retention exercise; all synthetic writes roll back below.
  -- Contract: 20261008150000. No stub functions or fake Supabase responses.
  FOREACH v_name IN ARRAY ARRAY['failed_closed', 'pending', 'finalized'] LOOP
    v_generation := gen_random_uuid();
    v_new_generation := gen_random_uuid();
    INSERT INTO public.pending_sessions
      (session_key, session_generation, accumulated_text, finalization_status)
      VALUES ('staging-baseline-check:' || v_name, v_generation, 'synthetic local evidence', v_name);
    UPDATE public.pending_sessions SET session_generation = v_new_generation,
      accumulated_text = 'synthetic next generation', finalization_status = 'pending'
      WHERE session_key = 'staging-baseline-check:' || v_name;
    IF NOT EXISTS (
      SELECT FROM public.pending_sessions
      WHERE session_key = 'staging-baseline-check:' || v_name
        AND session_generation = v_new_generation
        AND accumulated_text = 'synthetic next generation'
    ) THEN RAISE EXCEPTION 'Active generation rotation failed for %', v_name; END IF;
    IF v_name <> 'finalized' AND NOT EXISTS (
      SELECT FROM public.pending_session_retired_generations
      WHERE session_generation = v_generation AND accumulated_text = 'synthetic local evidence'
        AND finalization_status = v_name
    ) THEN RAISE EXCEPTION 'Lost retiring evidence for %', v_name; END IF;
    IF v_name = 'finalized' AND EXISTS (
      SELECT FROM public.pending_session_retired_generations WHERE session_generation = v_generation
    ) THEN RAISE EXCEPTION 'Resolved generation incorrectly retained'; END IF;
  END LOOP;
END $$;
ROLLBACK;
