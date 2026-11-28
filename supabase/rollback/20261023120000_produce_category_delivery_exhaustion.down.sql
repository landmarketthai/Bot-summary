-- Roll back 20261023120000: restore the claim and requeue definitions of
-- 20261023100000 exactly. Run first (before the privilege hardening rollback).

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_produce_category_deliveries(
  p_groups text[],
  p_limit integer,
  p_lease_seconds integer,
  p_max_attempts integer
) RETURNS TABLE (
  candidate_id uuid,
  revision integer,
  group_id text,
  claim_token uuid,
  attempts integer,
  product_name text,
  suggested_category text,
  confidence text,
  suggestion_reason text,
  similar_product_name text,
  occurrence_count integer,
  distinct_dates integer,
  first_seen date,
  last_seen date,
  sample_markets text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_groups IS NULL OR cardinality(p_groups) = 0 OR p_limit < 1 OR p_limit > 100
     OR p_lease_seconds < 30 OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'invalid category delivery claim';
  END IF;

  INSERT INTO public.produce_category_deliveries AS d (candidate_id, revision, group_id)
  SELECT c.id, c.revision, g.group_id
  FROM public.produce_category_candidates c
  CROSS JOIN (SELECT DISTINCT btrim(x) AS group_id FROM unnest(p_groups) x WHERE btrim(x) <> '') g
  WHERE c.status = 'pending'
  ON CONFLICT ON CONSTRAINT produce_category_deliveries_pkey DO NOTHING;

  RETURN QUERY
  WITH picked AS (
    SELECT d.candidate_id, d.revision, d.group_id
    FROM public.produce_category_deliveries d
    JOIN public.produce_category_candidates c
      ON c.id = d.candidate_id AND c.revision = d.revision AND c.status = 'pending'
    WHERE d.group_id = ANY (p_groups)
      AND d.status IN ('pending','retryable')
      AND d.attempts < p_max_attempts
      AND (d.claimed_until IS NULL OR d.claimed_until < now())
    ORDER BY c.created_at, c.product_name, d.group_id
    LIMIT p_limit
    FOR UPDATE OF d SKIP LOCKED
  ), claimed AS (
    UPDATE public.produce_category_deliveries d SET
      claim_token = gen_random_uuid(),
      claimed_until = now() + make_interval(secs => p_lease_seconds),
      attempts = d.attempts + 1,
      updated_at = now()
    FROM picked
    WHERE d.candidate_id = picked.candidate_id AND d.revision = picked.revision AND d.group_id = picked.group_id
    RETURNING d.candidate_id, d.revision, d.group_id, d.claim_token, d.attempts
  )
  SELECT cl.candidate_id, cl.revision, cl.group_id, cl.claim_token, cl.attempts,
    c.product_name, c.suggested_category, c.confidence, c.suggestion_reason, c.similar_product_name,
    c.occurrence_count, c.distinct_dates, c.first_seen, c.last_seen, c.sample_markets
  FROM claimed cl
  JOIN public.produce_category_candidates c ON c.id = cl.candidate_id
  ORDER BY c.created_at, c.product_name, cl.group_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.requeue_produce_category_deliveries(p_group_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.produce_category_deliveries d SET
    status = 'pending', attempts = 0, claim_token = NULL, claimed_until = NULL, updated_at = now()
  FROM public.produce_category_candidates c
  WHERE c.id = d.candidate_id AND c.revision = d.revision AND c.status = 'pending'
    AND d.status IN ('blocked','retryable')
    AND (p_group_id IS NULL OR d.group_id = p_group_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMIT;
