BEGIN;

CREATE TABLE public.produce_dictionary_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_name text NOT NULL UNIQUE CHECK (length(btrim(normalized_name)) > 0),
  raw_name_sample text NOT NULL CHECK (length(btrim(raw_name_sample)) > 0),
  state text NOT NULL DEFAULT 'observing'
    CHECK (state IN ('observing','needs_review','promoted','alias','rejected')),
  distinct_sessions integer NOT NULL DEFAULT 0 CHECK (distinct_sessions >= 0),
  distinct_days integer NOT NULL DEFAULT 0 CHECK (distinct_days >= 0),
  category_code_hint text NULL CHECK (category_code_hint IS NULL OR category_code_hint ~ '^[มผปทหพ]$'),
  category_name_hint text NULL,
  similar_product_code text NULL REFERENCES public.produce_product_codes(product_code),
  promoted_product_code text NULL REFERENCES public.produce_product_codes(product_code),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.produce_dictionary_candidate_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.produce_dictionary_candidates(id) ON DELETE CASCADE,
  session_key text NOT NULL,
  session_generation uuid NOT NULL,
  business_date date NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, session_generation)
);

CREATE TABLE public.produce_dictionary_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.produce_dictionary_candidates(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('NEW_PRODUCT','ALIAS','REJECT','NEEDS_REVIEW')),
  reason text NOT NULL,
  product_code text NULL REFERENCES public.produce_product_codes(product_code),
  target_product_code text NULL REFERENCES public.produce_product_codes(product_code),
  decided_by text NOT NULL DEFAULT 'system',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX produce_dictionary_decisions_terminal_once
  ON public.produce_dictionary_decisions(candidate_id, decision)
  WHERE decision IN ('NEW_PRODUCT','ALIAS','REJECT');
CREATE INDEX produce_dictionary_candidates_state_idx
  ON public.produce_dictionary_candidates(state, distinct_sessions, distinct_days);
CREATE INDEX produce_dictionary_occurrences_candidate_date_idx
  ON public.produce_dictionary_candidate_occurrences(candidate_id, business_date);

ALTER TABLE public.produce_dictionary_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produce_dictionary_candidate_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produce_dictionary_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.produce_dictionary_candidates FROM anon, authenticated;
REVOKE ALL ON public.produce_dictionary_candidate_occurrences FROM anon, authenticated;
REVOKE ALL ON public.produce_dictionary_decisions FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.observe_produce_dictionary_candidate(
  p_normalized_name text,
  p_raw_name text,
  p_session_key text,
  p_session_generation uuid,
  p_business_date date,
  p_category_code text,
  p_category_name text,
  p_similar_product_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text := btrim(regexp_replace(normalize(p_normalized_name, NFC), '\s+', ' ', 'g'));
  v_candidate public.produce_dictionary_candidates%ROWTYPE;
  v_existing_code text;
  v_sessions integer;
  v_days integer;
  v_next integer;
  v_code text;
BEGIN
  IF v_name = '' OR p_session_key IS NULL OR p_session_generation IS NULL OR p_business_date IS NULL THEN
    RAISE EXCEPTION 'invalid auto-dictionary observation';
  END IF;

  SELECT product_code INTO v_existing_code
  FROM public.produce_product_codes
  WHERE code_enabled AND canonical_name = v_name
  ORDER BY product_code LIMIT 1;

  IF v_existing_code IS NOT NULL THEN
    RETURN jsonb_build_object('status','existing','product_code',v_existing_code);
  END IF;

  INSERT INTO public.produce_dictionary_candidates(
    normalized_name, raw_name_sample, category_code_hint, category_name_hint, similar_product_code
  ) VALUES (
    v_name, btrim(p_raw_name), p_category_code, p_category_name, p_similar_product_code
  )
  ON CONFLICT (normalized_name) DO UPDATE SET
    raw_name_sample = EXCLUDED.raw_name_sample,
    last_seen_at = now(),
    updated_at = now(),
    category_code_hint = COALESCE(public.produce_dictionary_candidates.category_code_hint, EXCLUDED.category_code_hint),
    category_name_hint = COALESCE(public.produce_dictionary_candidates.category_name_hint, EXCLUDED.category_name_hint),
    similar_product_code = COALESCE(public.produce_dictionary_candidates.similar_product_code, EXCLUDED.similar_product_code)
  RETURNING * INTO v_candidate;

  INSERT INTO public.produce_dictionary_candidate_occurrences(
    candidate_id, session_key, session_generation, business_date
  ) VALUES (v_candidate.id, p_session_key, p_session_generation, p_business_date)
  ON CONFLICT (candidate_id, session_generation) DO NOTHING;

  SELECT count(DISTINCT session_generation), count(DISTINCT business_date)
  INTO v_sessions, v_days
  FROM public.produce_dictionary_candidate_occurrences
  WHERE candidate_id = v_candidate.id;

  UPDATE public.produce_dictionary_candidates SET
    distinct_sessions = v_sessions,
    distinct_days = v_days,
    last_seen_at = now(),
    updated_at = now()
  WHERE id = v_candidate.id
  RETURNING * INTO v_candidate;

  IF v_candidate.state IN ('promoted','alias','rejected') THEN
    RETURN jsonb_build_object(
      'status',v_candidate.state,'candidate_id',v_candidate.id,
      'distinct_sessions',v_sessions,'distinct_days',v_days,
      'product_code',v_candidate.promoted_product_code
    );
  END IF;

  IF p_similar_product_code IS NOT NULL OR v_candidate.similar_product_code IS NOT NULL THEN
    UPDATE public.produce_dictionary_candidates
    SET state = 'needs_review', updated_at = now()
    WHERE id = v_candidate.id;
    INSERT INTO public.produce_dictionary_decisions(candidate_id, decision, reason, target_product_code)
    SELECT v_candidate.id, 'NEEDS_REVIEW', 'similar_existing_product',
      COALESCE(p_similar_product_code, v_candidate.similar_product_code)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.produce_dictionary_decisions
      WHERE candidate_id = v_candidate.id AND decision = 'NEEDS_REVIEW' AND reason = 'similar_existing_product'
    );
    RETURN jsonb_build_object('status','needs_review','reason','similar_existing_product',
      'candidate_id',v_candidate.id,'distinct_sessions',v_sessions,'distinct_days',v_days);
  END IF;

  IF v_sessions < 3 OR v_days < 2 THEN
    RETURN jsonb_build_object('status','observing','candidate_id',v_candidate.id,
      'distinct_sessions',v_sessions,'distinct_days',v_days);
  END IF;

  IF p_category_code IS NULL OR p_category_name IS NULL
     OR p_category_code !~ '^[มผปทหพ]$' OR btrim(p_category_name) = '' THEN
    UPDATE public.produce_dictionary_candidates
    SET state = 'needs_review', updated_at = now()
    WHERE id = v_candidate.id;
    INSERT INTO public.produce_dictionary_decisions(candidate_id, decision, reason)
    SELECT v_candidate.id, 'NEEDS_REVIEW', 'category_unknown'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.produce_dictionary_decisions
      WHERE candidate_id = v_candidate.id AND decision = 'NEEDS_REVIEW' AND reason = 'category_unknown'
    );
    RETURN jsonb_build_object('status','needs_review','reason','category_unknown',
      'candidate_id',v_candidate.id,'distinct_sessions',v_sessions,'distinct_days',v_days);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('produce-product-code:' || p_category_code));
  SELECT product_code INTO v_existing_code
  FROM public.produce_product_codes
  WHERE code_enabled AND canonical_name = v_name
  ORDER BY product_code LIMIT 1;
  IF v_existing_code IS NOT NULL THEN
    UPDATE public.produce_dictionary_candidates
    SET state='promoted', promoted_product_code=v_existing_code, updated_at=now()
    WHERE id=v_candidate.id;
    RETURN jsonb_build_object('status','existing','candidate_id',v_candidate.id,'product_code',v_existing_code);
  END IF;

  SELECT COALESCE(max((substring(product_code from 2))::integer), 0) + 1
  INTO v_next
  FROM public.produce_product_codes
  WHERE category_code = p_category_code;
  v_code := p_category_code || CASE
    WHEN v_next < 100 THEN lpad(v_next::text, 2, '0')
    ELSE v_next::text
  END;

  INSERT INTO public.produce_product_codes(
    product_code, category_code, category_name, canonical_name, code_enabled
  ) VALUES (v_code, p_category_code, btrim(p_category_name), v_name, true);

  UPDATE public.produce_dictionary_candidates SET
    state = 'promoted', promoted_product_code = v_code, updated_at = now()
  WHERE id = v_candidate.id;

  INSERT INTO public.produce_dictionary_decisions(
    candidate_id, decision, reason, product_code, metadata
  ) VALUES (
    v_candidate.id, 'NEW_PRODUCT', 'safe_auto_threshold', v_code,
    jsonb_build_object('distinct_sessions',v_sessions,'distinct_days',v_days,
      'category_code',p_category_code,'category_name',p_category_name)
  ) ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('status','promoted','candidate_id',v_candidate.id,
    'product_code',v_code,'distinct_sessions',v_sessions,'distinct_days',v_days);
END;
$$;

REVOKE ALL ON FUNCTION public.observe_produce_dictionary_candidate(text,text,text,uuid,date,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.observe_produce_dictionary_candidate(text,text,text,uuid,date,text,text,text) TO service_role;

COMMIT;
