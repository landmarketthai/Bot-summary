-- Self-learning produce CATEGORY dictionary (classification only).
--
-- Category is presentation, never product identity: nothing here renames a
-- product, merges SKUs, allocates a product code, or touches produce
-- transactions, quantities, prices, money or fingerprints. Candidates are
-- discovered from persisted transactions; only an authorized admin decision
-- creates a rule, and rules are read by reports at run time.

BEGIN;

CREATE TABLE public.produce_category_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name text NOT NULL UNIQUE CHECK (length(btrim(product_name)) > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','legitimate_other')),
  suggested_category text NULL CHECK (suggested_category IN ('ท','ม','ผ','ป','ห','พ')),
  confidence text NOT NULL DEFAULT 'low' CHECK (confidence IN ('high','medium','low')),
  suggestion_reason text NOT NULL DEFAULT '',
  similar_product_name text NULL,
  occurrence_count integer NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
  distinct_dates integer NOT NULL DEFAULT 0 CHECK (distinct_dates >= 0),
  first_seen date NULL,
  last_seen date NULL,
  sample_markets text[] NOT NULL DEFAULT '{}',
  -- Bumped only when the reviewable proposal changes; postbacks carry it so a
  -- tap on an outdated card fails as stale.
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  notified_revision integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.produce_category_rules (
  product_name text PRIMARY KEY CHECK (length(btrim(product_name)) > 0),
  category_code text NOT NULL CHECK (category_code IN ('ท','ม','ผ','ป','ห','พ','other')),
  decision_id uuid NOT NULL,
  approved_by_line_user_id text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.produce_category_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.produce_category_candidates(id),
  candidate_revision integer NOT NULL,
  action text NOT NULL CHECK (action IN (
    'approve_suggested','select_category','approve_alias','new_product','reject','legitimate_other'
  )),
  category_code text NULL CHECK (category_code IN ('ท','ม','ผ','ป','ห','พ','other')),
  -- approve_alias records the reviewed target for an engineering follow-up;
  -- the runtime only copies its CATEGORY, never its identity.
  alias_target text NULL,
  decided_by_line_user_id text NOT NULL,
  source_id text NOT NULL,
  line_event_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.produce_category_rules
  ADD CONSTRAINT produce_category_rules_decision_fk
  FOREIGN KEY (decision_id) REFERENCES public.produce_category_decisions(id);

CREATE INDEX produce_category_candidates_review_idx
  ON public.produce_category_candidates(status, notified_revision, revision);

-- Decisions are the audit trail: append-only.
CREATE OR REPLACE FUNCTION public.produce_category_decisions_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'produce_category_decisions is append-only';
END;
$$;
CREATE TRIGGER produce_category_decisions_append_only
  BEFORE UPDATE OR DELETE ON public.produce_category_decisions
  FOR EACH ROW EXECUTE FUNCTION public.produce_category_decisions_append_only();

ALTER TABLE public.produce_category_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produce_category_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produce_category_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.produce_category_candidates FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.produce_category_rules FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.produce_category_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.produce_category_candidates TO service_role;
GRANT SELECT ON public.produce_category_rules TO service_role;
GRANT SELECT ON public.produce_category_decisions TO service_role;

-- Record (or refresh) evidence for one discovered name. A decided candidate
-- only gets fresh evidence; it is reopened solely when a REJECTED proposal is
-- replaced by a different suggested category.
CREATE OR REPLACE FUNCTION public.observe_produce_category_candidate(
  p_product_name text,
  p_suggested_category text,
  p_confidence text,
  p_reason text,
  p_similar_product_name text,
  p_occurrence_count integer,
  p_distinct_dates integer,
  p_first_seen date,
  p_last_seen date,
  p_sample_markets text[]
) RETURNS public.produce_category_candidates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_name text := btrim(normalize(p_product_name, NFC));
  v_row public.produce_category_candidates%ROWTYPE;
  v_reopen boolean;
  v_changed boolean;
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION 'blank product name'; END IF;

  INSERT INTO public.produce_category_candidates(
    product_name, suggested_category, confidence, suggestion_reason, similar_product_name,
    occurrence_count, distinct_dates, first_seen, last_seen, sample_markets
  ) VALUES (
    v_name, p_suggested_category, p_confidence, coalesce(p_reason, ''), p_similar_product_name,
    p_occurrence_count, p_distinct_dates, p_first_seen, p_last_seen, coalesce(p_sample_markets, '{}')
  )
  ON CONFLICT (product_name) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN RETURN v_row; END IF;

  SELECT * INTO v_row FROM public.produce_category_candidates
  WHERE product_name = v_name FOR UPDATE;

  -- Pending: a changed proposal is a new revision (old cards go stale).
  -- Rejected: reopened only by a different, non-empty suggestion.
  -- Approved / legitimate_other: evidence only, never re-alerted.
  v_reopen := v_row.status = 'rejected' AND p_suggested_category IS NOT NULL
    AND p_suggested_category IS DISTINCT FROM v_row.suggested_category;
  v_changed := v_row.status = 'pending'
    AND (p_suggested_category IS DISTINCT FROM v_row.suggested_category
      OR p_similar_product_name IS DISTINCT FROM v_row.similar_product_name);

  UPDATE public.produce_category_candidates SET
    occurrence_count = greatest(occurrence_count, p_occurrence_count),
    distinct_dates = greatest(distinct_dates, p_distinct_dates),
    first_seen = least(first_seen, p_first_seen),
    last_seen = greatest(last_seen, p_last_seen),
    sample_markets = coalesce(p_sample_markets, '{}'),
    suggested_category = CASE WHEN v_reopen OR v_changed THEN p_suggested_category ELSE suggested_category END,
    confidence = CASE WHEN v_reopen OR v_changed THEN p_confidence ELSE confidence END,
    suggestion_reason = CASE WHEN v_reopen OR v_changed THEN coalesce(p_reason, '') ELSE suggestion_reason END,
    similar_product_name = CASE WHEN v_reopen OR v_changed THEN p_similar_product_name ELSE similar_product_name END,
    status = CASE WHEN v_reopen THEN 'pending' ELSE status END,
    revision = CASE WHEN v_reopen OR v_changed THEN revision + 1 ELSE revision END,
    updated_at = now()
  WHERE id = v_row.id
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- One admin decision. Authorization (verified LINE user + review group) is
-- enforced by the server before this call; this function owns idempotency
-- (line_event_id), staleness (status + revision) and the audit row.
CREATE OR REPLACE FUNCTION public.decide_produce_category_candidate(
  p_candidate_id uuid,
  p_revision integer,
  p_action text,
  p_category_code text,
  p_alias_target text,
  p_line_user_id text,
  p_source_id text,
  p_line_event_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_candidate public.produce_category_candidates%ROWTYPE;
  v_existing public.produce_category_decisions%ROWTYPE;
  v_category text;
  v_status text;
  v_decision_id uuid;
BEGIN
  IF coalesce(btrim(p_line_user_id), '') = '' OR coalesce(btrim(p_source_id), '') = ''
     OR coalesce(btrim(p_line_event_id), '') = '' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  SELECT * INTO v_existing FROM public.produce_category_decisions WHERE line_event_id = p_line_event_id;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'duplicate', 'decision_id', v_existing.id,
      'action', v_existing.action, 'category_code', v_existing.category_code);
  END IF;

  SELECT * INTO v_candidate FROM public.produce_category_candidates
  WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_candidate.status <> 'pending' OR v_candidate.revision <> p_revision THEN
    RETURN jsonb_build_object('status', 'stale', 'candidate_status', v_candidate.status);
  END IF;

  v_category := CASE p_action
    WHEN 'approve_suggested' THEN v_candidate.suggested_category
    WHEN 'select_category' THEN p_category_code
    WHEN 'approve_alias' THEN p_category_code
    WHEN 'new_product' THEN p_category_code
    WHEN 'legitimate_other' THEN 'other'
    WHEN 'reject' THEN NULL
  END;
  IF p_action NOT IN ('approve_suggested','select_category','approve_alias','new_product','reject','legitimate_other')
     OR (p_action NOT IN ('reject','legitimate_other') AND (v_category IS NULL OR v_category NOT IN ('ท','ม','ผ','ป','ห','พ')))
     OR (p_action = 'approve_alias' AND (coalesce(p_alias_target, '') = ''
       OR p_alias_target IS DISTINCT FROM v_candidate.similar_product_name)) THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  INSERT INTO public.produce_category_decisions(
    candidate_id, candidate_revision, action, category_code, alias_target,
    decided_by_line_user_id, source_id, line_event_id
  ) VALUES (
    v_candidate.id, v_candidate.revision, p_action, v_category,
    CASE WHEN p_action = 'approve_alias' THEN p_alias_target END,
    p_line_user_id, p_source_id, p_line_event_id
  ) RETURNING id INTO v_decision_id;

  v_status := CASE p_action WHEN 'reject' THEN 'rejected'
    WHEN 'legitimate_other' THEN 'legitimate_other' ELSE 'approved' END;
  UPDATE public.produce_category_candidates
  SET status = v_status, updated_at = now()
  WHERE id = v_candidate.id;

  IF v_category IS NOT NULL THEN
    INSERT INTO public.produce_category_rules(product_name, category_code, decision_id, approved_by_line_user_id)
    VALUES (v_candidate.product_name, v_category, v_decision_id, p_line_user_id)
    ON CONFLICT (product_name) DO UPDATE SET
      category_code = EXCLUDED.category_code,
      decision_id = EXCLUDED.decision_id,
      approved_by_line_user_id = EXCLUDED.approved_by_line_user_id,
      approved_at = now();
  END IF;

  RETURN jsonb_build_object('status', 'applied', 'decision_id', v_decision_id,
    'action', p_action, 'category_code', v_category, 'product_name', v_candidate.product_name);
END;
$$;

REVOKE ALL ON FUNCTION public.observe_produce_category_candidate(text,text,text,text,text,integer,integer,date,date,text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decide_produce_category_candidate(uuid,integer,text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.produce_category_decisions_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_produce_category_candidate(text,text,text,text,text,integer,integer,date,date,text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.decide_produce_category_candidate(uuid,integer,text,text,text,text,text,text) TO service_role;

COMMIT;
