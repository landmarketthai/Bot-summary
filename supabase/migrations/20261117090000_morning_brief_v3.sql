-- Additive and inert: no cron job, target, auth, historical alias or row is changed.
BEGIN;

CREATE FUNCTION public.morning_brief_market(p_label text,p_seller text DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN normalize(btrim(p_label), NFC) = 'หนูเล็ก-พาซีโอ้' THEN
    CASE WHEN p_seller IS NULL OR normalize(btrim(p_seller),NFC)='หนูเล็ก' THEN 'พาซิโอ้ผัก' END
    WHEN normalize(btrim(p_seller), NFC)='หนูเล็ก' AND normalize(btrim(p_label), NFC) IN ('พาซีโอ้','พาซิโอ้','พาสิโอ้') THEN 'พาซิโอ้ผัก'
    ELSE (SELECT m.label FROM public.line_guided_menu_markets m
      WHERE m.active AND m.market_code = public.accountability_round_market_code(p_label)
        AND m.label <> 'พาซิโอ้') END
$$;

-- Shared by app and pre-HTTP cron gate. produce_transactions is the P2E
-- effective view (voided_at IS NULL), also read by fetchSalesProduceRows.
-- As-of evidence: a persisted pair plus no unresolved pending document;
-- future late amendments remain possible. No closed-round status is required.
CREATE FUNCTION public.morning_brief_context(p_date date, p_scope text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_reasons text[] := '{}'; v_markets jsonb; v_issues jsonb; v_qa jsonb; v_count int; v_bad boolean;
BEGIN
  IF p_scope NOT IN ('fruit','vegetable') THEN RAISE EXCEPTION 'invalid scope'; END IF;
  SELECT coalesce(jsonb_object_agg(id, public.morning_brief_market(market_label,seller_label)), '{}')
    INTO v_markets FROM public.accountability_rounds
    WHERE business_date = p_date AND status <> 'cancelled';
  SELECT coalesce(jsonb_object_agg(t.accountability_round_id, CASE
      WHEN r.id IS NULL THEN 'missing_round'
      WHEN r.status = 'cancelled' THEN 'cancelled_round'
      ELSE 'round_date_mismatch' END), '{}') INTO v_issues
    FROM public.produce_transactions t LEFT JOIN public.accountability_rounds r ON r.id=t.accountability_round_id
    WHERE t.transaction_date=p_date AND t.accountability_round_id IS NOT NULL
      AND (r.id IS NULL OR r.status='cancelled' OR r.business_date IS DISTINCT FROM p_date);
  SELECT coalesce(jsonb_agg(id), '[]') INTO v_qa FROM public.accountability_rounds
    WHERE (business_date=p_date OR id IN (SELECT accountability_round_id FROM public.produce_transactions WHERE transaction_date=p_date))
      AND normalize(btrim(market_label),NFC) IN
      ('ทดสอบ','ทดสอบเงินโอน','ทดสอบผลต่าง','ทดสอบราคาA','ทดสอบราคาB','ทดสอบไวท์ชีท','QAไวท์ชีท');
  IF p_scope = 'vegetable' THEN
    SELECT count(*), coalesce(bool_or(NOT (
      EXISTS (SELECT 1 FROM public.produce_transactions t WHERE t.transaction_date = p_date
        AND t.accountability_round_id = r.id AND t.transaction_type IN ('เบิก','เบิกเพิ่ม'))
      AND EXISTS (SELECT 1 FROM public.produce_transactions t WHERE t.transaction_date = p_date
        AND t.accountability_round_id = r.id AND t.transaction_type IN ('คืน','ชั่งคืนเพิ่ม')))), false)
      INTO v_count, v_bad FROM public.accountability_rounds r
      WHERE r.business_date = p_date AND r.status <> 'cancelled'
        AND public.morning_brief_market(r.market_label,r.seller_label) = 'พาซิโอ้ผัก';
    IF v_count = 0 THEN v_reasons := array_append(v_reasons, 'missing_withdrawal'); END IF;
    IF v_bad THEN v_reasons := array_append(v_reasons, 'incomplete_known_round'); END IF;
    -- Any unresolved document can alter totals, regardless of declared type.
    -- Match RESOLVED_PENDING_STATUSES; never infer finalization from raw text.
    IF EXISTS (SELECT 1 FROM public.pending_sessions p
      JOIN public.accountability_rounds r ON r.id=p.accountability_round_id
      WHERE r.business_date=p_date AND r.status <> 'cancelled'
        AND coalesce(p.finalization_status,'pending') NOT IN ('finalized','duplicate','expired_empty_draft')
        AND normalize(btrim(coalesce(r.market_label,'')),NFC) NOT IN
          ('ทดสอบ','ทดสอบเงินโอน','ทดสอบผลต่าง','ทดสอบราคาA','ทดสอบราคาB','ทดสอบไวท์ชีท','QAไวท์ชีท')
        AND (public.morning_brief_market(r.market_label,r.seller_label)='พาซิโอ้ผัก'
          OR (public.morning_brief_market(r.market_label,r.seller_label) IS NULL
            AND (coalesce(r.market_label,'')='' OR normalize(btrim(r.seller_label),NFC)='หนูเล็ก'
              OR r.market_label ~* '(พาซ|พาส|พาช|pasio|ผัก)')))) THEN
      v_reasons := array_append(v_reasons, 'unresolved_vegetable_document');
    END IF;
    -- Only plausible vegetable ambiguity blocks Vegetable. Unrelated unknown markets
    -- remain visible in the application's unassigned review without freezing this scope.
    SELECT array_cat(v_reasons, coalesce(array_agg(DISTINCT CASE
      WHEN t.accountability_round_id IS NULL THEN 'unbound_vegetable_round'
      WHEN r.id IS NULL THEN 'missing_vegetable_round'
      WHEN r.status='cancelled' THEN 'cancelled_vegetable_round'
      WHEN r.business_date IS DISTINCT FROM p_date THEN 'vegetable_round_date_mismatch'
      ELSE 'unresolved_vegetable_identity' END), '{}')) INTO v_reasons
    FROM public.produce_transactions t
    LEFT JOIN public.accountability_rounds r ON r.id=t.accountability_round_id
    WHERE t.transaction_date=p_date
      AND normalize(btrim(coalesce(r.market_label,t.market_name,'')),NFC) NOT IN
        ('ทดสอบ','ทดสอบเงินโอน','ทดสอบผลต่าง','ทดสอบราคาA','ทดสอบราคาB','ทดสอบไวท์ชีท','QAไวท์ชีท')
      AND (r.id IS NULL OR r.status='cancelled' OR r.business_date IS DISTINCT FROM p_date
        OR public.morning_brief_market(r.market_label,r.seller_label) IS NULL)
      AND coalesce(public.morning_brief_market(coalesce(r.market_label,t.market_name),r.seller_label),'พาซิโอ้ผัก')='พาซิโอ้ผัก'
      AND (coalesce(r.market_label,t.market_name,'') = '' OR normalize(btrim(r.seller_label),NFC)='หนูเล็ก'
        OR coalesce(r.market_label,t.market_name,'') ~* '(พาซ|พาส|พาช|pasio|ผัก)');
  END IF;
  RETURN jsonb_build_object('roundMarkets', v_markets, 'roundIssues', v_issues, 'qaRoundIds', v_qa, 'readiness', jsonb_build_object(
    'status', CASE WHEN cardinality(v_reasons) = 0 THEN 'ready' ELSE 'not_ready' END,
    'reasons', to_jsonb(v_reasons)));
END $$;

CREATE TABLE public.morning_brief_deliveries (
  business_date date NOT NULL,
  scope text NOT NULL CHECK (scope IN ('fruit','vegetable')),
  target_key text NOT NULL CHECK (target_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','needs_review')),
  lease_token uuid, lease_until timestamptz,
  -- Frozen payload includes artifact path and individual text/PDF acceptance.
  payload jsonb, frozen_at timestamptz, next_part integer NOT NULL DEFAULT 0 CHECK (next_part >= 0),
  first_attempt_at timestamptz, accepted_at timestamptz,
  PRIMARY KEY (business_date, scope, target_key)
);
ALTER TABLE public.morning_brief_deliveries ENABLE ROW LEVEL SECURITY;
-- Supabase's default privileges may already grant service_role table writes.
REVOKE ALL ON public.morning_brief_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.morning_brief_deliveries TO service_role;

-- Serialized row claim and fenced progress. Never reset the payload or retry clock.
CREATE FUNCTION public.morning_brief_delivery(p_date date, p_scope text, p_target text,
  p_action text, p_token uuid DEFAULT NULL, p_payload jsonb DEFAULT NULL, p_part integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.morning_brief_deliveries; v_now timestamptz := clock_timestamp();
BEGIN
  IF p_action = 'claim' THEN
    INSERT INTO public.morning_brief_deliveries(business_date,scope,target_key) VALUES(p_date,p_scope,p_target)
      ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO STRICT d FROM public.morning_brief_deliveries
    WHERE business_date=p_date AND scope=p_scope AND target_key=p_target FOR UPDATE;
  IF d.state <> 'pending' THEN RETURN to_jsonb(d); END IF;
  -- LINE's retry-key window is 24h. Stop conservatively at 23h; never guess
  -- whether an expired unknown request reached LINE.
  IF (d.first_attempt_at IS NOT NULL AND d.first_attempt_at <= v_now - interval '23 hours')
    OR (d.frozen_at IS NOT NULL AND d.frozen_at <= v_now - interval '6 days') THEN
    UPDATE public.morning_brief_deliveries SET state='needs_review', lease_token=NULL, lease_until=NULL
      WHERE business_date=p_date AND scope=p_scope AND target_key=p_target RETURNING * INTO d;
    RETURN to_jsonb(d);
  END IF;
  IF p_action = 'claim' THEN
    IF d.lease_until > v_now THEN RETURN jsonb_build_object('state','busy'); END IF;
    d.lease_token := gen_random_uuid(); d.lease_until := v_now + interval '5 minutes';
  ELSE
    IF d.lease_token IS NULL OR p_token IS NULL OR d.lease_token IS DISTINCT FROM p_token
      OR d.lease_until IS NULL OR d.lease_until <= v_now THEN
      RAISE EXCEPTION 'lost delivery lease';
    END IF;
    IF p_action = 'freeze' AND d.payload IS NULL THEN
      IF jsonb_typeof(p_payload->'parts') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'missing delivery parts';
      END IF;
      IF jsonb_array_length(p_payload->'parts') < 1 THEN
        RAISE EXCEPTION 'missing delivery parts';
      END IF;
      d.payload := p_payload; d.frozen_at := v_now;
    ELSIF p_action = 'prepare' THEN
      IF d.payload IS NULL OR p_part IS DISTINCT FROM d.next_part THEN RAISE EXCEPTION 'invalid part'; END IF;
      d.first_attempt_at := coalesce(d.first_attempt_at,v_now);
    ELSIF p_action = 'accept' THEN
      IF d.payload IS NULL OR d.first_attempt_at IS NULL OR p_part IS DISTINCT FROM d.next_part THEN RAISE EXCEPTION 'invalid part'; END IF;
      d.next_part := d.next_part+1;
      IF d.next_part = jsonb_array_length(d.payload->'parts') THEN
        d.state := 'accepted'; d.accepted_at := v_now;
      END IF;
    ELSIF p_action = 'release' THEN
      d.lease_token := NULL; d.lease_until := NULL;
    ELSE RAISE EXCEPTION 'invalid delivery action'; END IF;
  END IF;
  UPDATE public.morning_brief_deliveries SET state=d.state,lease_token=d.lease_token,
    lease_until=d.lease_until,payload=d.payload,frozen_at=d.frozen_at,next_part=d.next_part,
    first_attempt_at=d.first_attempt_at,accepted_at=d.accepted_at
    WHERE business_date=p_date AND scope=p_scope AND target_key=p_target;
  RETURN to_jsonb(d);
END $$;

CREATE FUNCTION public.morning_brief_slot(p_scope text,p_now timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH local AS (SELECT extract(hour FROM p_now AT TIME ZONE 'Asia/Bangkok')::int*60
    + extract(minute FROM p_now AT TIME ZONE 'Asia/Bangkok')::int AS minute)
  SELECT CASE WHEN p_scope='fruit' AND minute>=720 AND minute<725 THEN 720
    WHEN p_scope='vegetable' AND minute>=840 AND minute<1085 AND minute%30<5 THEN minute-minute%30 END FROM local
$$;

-- Cheap preflight. Targets are SHA256 hashes of the existing app configuration,
-- supplied by the operator; an empty/mismatched list must never mean delivered.
CREATE FUNCTION public.morning_brief_should_invoke(p_date date,p_scope text,p_targets text[],
  p_now timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_scope IN ('fruit','vegetable') AND cardinality(p_targets)>0
    AND p_date IN ((p_now AT TIME ZONE 'Asia/Bangkok')::date-1, (p_now AT TIME ZONE 'Asia/Bangkok')::date-2)
    AND public.morning_brief_slot(p_scope,p_now) IS NOT NULL
    AND (p_date=(p_now AT TIME ZONE 'Asia/Bangkok')::date-1 OR (
      public.morning_brief_slot(p_scope,p_now)=CASE WHEN p_scope='fruit' THEN 720 ELSE 840 END
      AND EXISTS (SELECT 1 FROM public.morning_brief_deliveries d
        WHERE d.business_date=p_date AND d.scope=p_scope AND d.target_key=ANY(p_targets) AND d.state='pending')))
    AND (public.morning_brief_context(p_date,p_scope)->'readiness'->>'status'='ready'
      OR EXISTS (SELECT 1 FROM public.morning_brief_deliveries d
        WHERE d.business_date=p_date AND d.scope=p_scope AND d.target_key=ANY(p_targets)
          AND d.state='pending' AND d.payload IS NOT NULL
          AND (d.lease_until IS NULL OR d.lease_until<=p_now)
          AND (d.first_attempt_at IS NULL OR d.first_attempt_at>p_now-interval '23 hours')))
    AND EXISTS (SELECT 1 FROM unnest(p_targets) k WHERE NOT EXISTS (
      SELECT 1 FROM public.morning_brief_deliveries d WHERE d.business_date=p_date AND d.scope=p_scope AND d.target_key=k
        AND (d.state IN ('accepted','needs_review') OR d.lease_until>p_now
          OR d.first_attempt_at<=p_now-interval '23 hours')))
$$;

-- Count-only diagnostics; never return target hashes or frozen URLs/bodies.
CREATE FUNCTION public.morning_brief_delivery_status(p_date date,p_scope text,p_targets text[],
  p_now timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('acceptedCount',count(*) FILTER (WHERE state='accepted'),
    'busyCount',count(*) FILTER (WHERE state='pending' AND lease_until>p_now),
    'pendingCount',count(*) FILTER (WHERE state='pending'),
    'reviewCount',count(*) FILTER (WHERE state='needs_review' OR (state='pending' AND
      (first_attempt_at<=p_now-interval '23 hours' OR frozen_at<=p_now-interval '6 days'))))
  FROM public.morning_brief_deliveries WHERE business_date=p_date AND scope=p_scope AND target_key=ANY(p_targets)
$$;
REVOKE ALL ON FUNCTION public.morning_brief_delivery_status(date,text,text[],timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.morning_brief_delivery_status(date,text,text[],timestamptz) TO service_role;

-- Staged by an operator AFTER schema/app checks. Existing HTTP SQL is copied
-- privately with only its date parameter replaced by __BRIEF_DATE__. No auth
-- or recipient configuration is invented here. No row is seeded or enabled.
CREATE SCHEMA morning_brief_private;
REVOKE ALL ON SCHEMA morning_brief_private FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE morning_brief_private.morning_brief_dispatch_config (
  scope text PRIMARY KEY CHECK(scope IN ('fruit','vegetable')),
  enabled boolean NOT NULL DEFAULT false,
  target_keys text[] NOT NULL CHECK(cardinality(target_keys)>0),
  command_template text NOT NULL
);
-- A normal CHECK violation can print the entire failing row, including credentials.
CREATE FUNCTION morning_brief_private.validate_dispatch_config() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.scope IS NULL OR NEW.scope NOT IN ('fruit','vegetable') OR NEW.enabled IS NULL
    OR NEW.target_keys IS NULL OR coalesce(cardinality(NEW.target_keys),0)=0
    OR EXISTS(SELECT 1 FROM unnest(NEW.target_keys) k WHERE k IS NULL OR k !~ '^[0-9a-f]{64}$')
    OR cardinality(NEW.target_keys)<>(SELECT count(DISTINCT k) FROM unnest(NEW.target_keys) k)
    OR NEW.command_template IS NULL OR position('__BRIEF_DATE__' IN NEW.command_template)=0
    OR NEW.command_template !~* '^\s*SELECT\s+net[.]http_get\s*[(]'
    OR NEW.command_template ~ '(;|--|/\*|\*/)' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Invalid private Morning Brief dispatch configuration';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morning_brief_private.validate_dispatch_config() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER validate_dispatch_config BEFORE INSERT OR UPDATE ON morning_brief_private.morning_brief_dispatch_config
FOR EACH ROW EXECUTE FUNCTION morning_brief_private.validate_dispatch_config();
CREATE TABLE public.morning_brief_checks (
  business_date date NOT NULL, scope text NOT NULL, check_date date NOT NULL, slot integer NOT NULL,
  outcome text NOT NULL DEFAULT 'checking' CHECK(outcome IN
    ('checking','not_ready','invoked','accepted','busy','review','skipped','enqueue_failed')),
  PRIMARY KEY(business_date,scope,check_date,slot)
);
CREATE TABLE morning_brief_private.morning_brief_cron_backup (
  jobid bigint PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, active boolean NOT NULL,
  owner_name name NOT NULL DEFAULT current_user
);
ALTER TABLE morning_brief_private.morning_brief_dispatch_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.morning_brief_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE morning_brief_private.morning_brief_cron_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON morning_brief_private.morning_brief_dispatch_config,public.morning_brief_checks,morning_brief_private.morning_brief_cron_backup FROM PUBLIC,anon,authenticated,service_role;

-- Exact set parity against private config, never expose hashes or HTTP SQL.
-- Missing/disabled config fails closed while legacy crons remain suspended.
CREATE FUNCTION public.morning_brief_target_parity(p_scope text,p_targets text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH config AS (SELECT enabled,target_keys FROM morning_brief_private.morning_brief_dispatch_config WHERE scope=p_scope),
    expected AS (SELECT DISTINCT unnest(target_keys) AS k FROM config),
    actual AS (SELECT DISTINCT unnest(p_targets) AS k),
    counts AS (SELECT (SELECT count(*) FROM expected) AS configured,
      (SELECT count(*) FROM actual) AS requested,
      (SELECT count(*) FROM (SELECT k FROM expected EXCEPT SELECT k FROM actual) missing) AS missing,
      (SELECT count(*) FROM (SELECT k FROM actual EXCEPT SELECT k FROM expected) excess) AS excess)
  SELECT jsonb_build_object('matched',coalesce((SELECT enabled FROM config),false)
      AND configured>0 AND missing=0 AND excess=0,
    'configuredCount',configured,'requestedCount',requested,'missingCount',missing,'excessCount',excess)
  FROM counts
$$;
REVOKE ALL ON FUNCTION public.morning_brief_target_parity(text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.morning_brief_target_parity(text,text[]) TO service_role;

CREATE FUNCTION public.morning_brief_dispatch(p_scope text,p_now timestamptz DEFAULT clock_timestamp()) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c morning_brief_private.morning_brief_dispatch_config; v_local timestamp := p_now AT TIME ZONE 'Asia/Bangkok';
  v_slot integer; v_date date; v_offset integer; v_outcome text; v_status jsonb;
BEGIN
  SELECT * INTO c FROM morning_brief_private.morning_brief_dispatch_config WHERE scope=p_scope AND enabled;
  IF NOT FOUND THEN RETURN; END IF;
  v_slot := public.morning_brief_slot(p_scope,p_now);
  IF v_slot IS NULL THEN RETURN; END IF;
  FOR v_offset IN 1..2 LOOP
    v_date := v_local::date-v_offset;
    -- Exactly one next-day recovery opportunity, at the first slot. No history scan.
    IF v_offset=2 AND v_slot<>(CASE WHEN p_scope='fruit' THEN 720 ELSE 840 END) THEN CONTINUE; END IF;
    IF v_offset=1 THEN
      INSERT INTO public.morning_brief_deliveries(business_date,scope,target_key)
        SELECT v_date,p_scope,k FROM unnest(c.target_keys) k ON CONFLICT DO NOTHING;
    ELSIF NOT EXISTS(SELECT 1 FROM public.morning_brief_deliveries WHERE business_date=v_date AND scope=p_scope AND state='pending') THEN CONTINUE;
    END IF;
    INSERT INTO public.morning_brief_checks(business_date,scope,check_date,slot)
      VALUES(v_date,p_scope,v_local::date,v_slot) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.morning_brief_deliveries SET state='needs_review',lease_token=NULL,lease_until=NULL
      WHERE business_date=v_date AND scope=p_scope AND state='pending'
        AND first_attempt_at<=p_now-interval '23 hours';
    IF public.morning_brief_should_invoke(v_date,p_scope,c.target_keys,p_now) THEN
      -- pg_net queues HTTP until transaction commit; a request ID is NOT LINE acceptance.
      BEGIN
        EXECUTE replace(c.command_template,'__BRIEF_DATE__',v_date::text);
        v_outcome := 'invoked';
      EXCEPTION WHEN OTHERS THEN
        -- Retain a sanitized observation; never SQLERRM/query/header context.
        v_outcome := 'enqueue_failed';
      END;
    ELSE
      v_status := public.morning_brief_delivery_status(v_date,p_scope,c.target_keys,p_now);
      v_outcome := CASE WHEN (v_status->>'reviewCount')::int>0 THEN 'review'
        WHEN (v_status->>'acceptedCount')::int=cardinality(c.target_keys) THEN 'accepted'
        WHEN (v_status->>'busyCount')::int>0 THEN 'busy'
        WHEN public.morning_brief_context(v_date,p_scope)->'readiness'->>'status'='not_ready' THEN 'not_ready'
        ELSE 'skipped' END;
    END IF;
    UPDATE public.morning_brief_checks SET outcome=v_outcome
      WHERE business_date=v_date AND scope=p_scope AND check_date=v_local::date AND slot=v_slot;
    -- At most one final-slot observation per date/scope; no recipient/market PII.
    IF v_offset=1 AND v_slot=(CASE WHEN p_scope='fruit' THEN 720 ELSE 1080 END)
      AND v_outcome NOT IN ('invoked','accepted') THEN
      RAISE LOG 'Morning Brief final check: scope=%, outcome=%',p_scope,v_outcome;
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.morning_brief_slot(text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.morning_brief_slot(text,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.morning_brief_market(text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.morning_brief_context(date,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.morning_brief_delivery(date,text,text,text,uuid,jsonb,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.morning_brief_should_invoke(date,text,text[],timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.morning_brief_market(text,text),public.morning_brief_context(date,text),
  public.morning_brief_delivery(date,text,text,text,uuid,jsonb,integer),public.morning_brief_should_invoke(date,text,text[],timestamptz) TO service_role;
-- Dispatch can execute private HTTP SQL, so only the migration/cron owner may call it.
REVOKE ALL ON FUNCTION public.morning_brief_dispatch(text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
