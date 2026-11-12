-- Durable per-recipient delivery ledger for category review cards.
--
-- Replaces the single global notified_revision (20261022130000), which could
-- not represent partial delivery across groups and marked failed sends as
-- announced. One row per (candidate, revision, group):
--   pending    -> not yet attempted (or explicitly requeued)
--   retryable  -> attempted, not delivered, will be tried again (bounded)
--   delivered  -> LINE accepted it; never sent again for this revision
--   blocked    -> definitive rejection or attempts exhausted; excluded from
--                 the queue until an explicit requeue, so it cannot starve it
-- Rows are claimed with a lease (FOR UPDATE SKIP LOCKED) so overlapping cron
-- runs never claim the same delivery. Only the current revision of a pending
-- candidate is ever claimed, so obsolete revisions are never sent.
-- notified_revision / needs_announcement are left in place, unused.

BEGIN;

CREATE TABLE public.produce_category_deliveries (
  candidate_id uuid NOT NULL REFERENCES public.produce_category_candidates(id),
  revision integer NOT NULL CHECK (revision >= 1),
  group_id text NOT NULL CHECK (length(btrim(group_id)) > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','retryable','delivered','blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token uuid NULL,
  claimed_until timestamptz NULL,
  last_error_code integer NULL,
  last_error text NULL CHECK (last_error IS NULL OR length(last_error) <= 200),
  delivered_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, revision, group_id)
);

CREATE INDEX produce_category_deliveries_queue_idx
  ON public.produce_category_deliveries (status, group_id)
  WHERE status IN ('pending','retryable');

ALTER TABLE public.produce_category_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.produce_category_deliveries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.produce_category_deliveries TO service_role;

-- Enqueue the current revision of every pending candidate for each group,
-- then claim up to p_limit claimable deliveries FIFO (candidate created_at,
-- product_name, group). Each claim counts as one attempt.
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

-- Record the outcome of one claimed delivery. Only the holder of the current
-- claim token can complete it; a late or duplicate completion is ignored.
CREATE OR REPLACE FUNCTION public.complete_produce_category_delivery(
  p_candidate_id uuid,
  p_revision integer,
  p_group_id text,
  p_claim_token uuid,
  p_outcome text,
  p_error_code integer,
  p_error text,
  p_max_attempts integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_outcome NOT IN ('delivered','retryable','blocked') OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'invalid category delivery outcome';
  END IF;

  UPDATE public.produce_category_deliveries d SET
    status = CASE
      WHEN p_outcome = 'retryable' AND d.attempts >= p_max_attempts THEN 'blocked'
      ELSE p_outcome END,
    delivered_at = CASE WHEN p_outcome = 'delivered' THEN now() ELSE d.delivered_at END,
    last_error_code = CASE WHEN p_outcome = 'delivered' THEN NULL ELSE p_error_code END,
    last_error = CASE WHEN p_outcome = 'delivered' THEN NULL ELSE left(p_error, 200) END,
    claim_token = NULL,
    claimed_until = NULL,
    updated_at = now()
  WHERE d.candidate_id = p_candidate_id AND d.revision = p_revision AND d.group_id = p_group_id
    AND d.claim_token = p_claim_token AND d.status IN ('pending','retryable')
  RETURNING d.status INTO v_status;

  RETURN coalesce(v_status, 'ignored');
END;
$$;

-- Explicit recovery after credentials or recipient configuration are fixed:
-- blocked (and exhausted retryable) deliveries of current revisions go back
-- to pending with a fresh attempt budget. p_group_id NULL = every group.
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

-- Operational counts for current revisions of pending candidates. No error
-- text, tokens or recipient configuration beyond the group id.
CREATE OR REPLACE FUNCTION public.produce_category_delivery_health()
RETURNS TABLE (group_id text, status text, deliveries bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.group_id, d.status, count(*)
  FROM public.produce_category_deliveries d
  JOIN public.produce_category_candidates c
    ON c.id = d.candidate_id AND c.revision = d.revision AND c.status = 'pending'
  GROUP BY d.group_id, d.status
  ORDER BY d.group_id, d.status;
$$;

REVOKE ALL ON FUNCTION public.claim_produce_category_deliveries(text[], integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_produce_category_delivery(uuid, integer, text, uuid, text, integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_produce_category_deliveries(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.produce_category_delivery_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_produce_category_deliveries(text[], integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_produce_category_delivery(uuid, integer, text, uuid, text, integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_produce_category_deliveries(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.produce_category_delivery_health() TO service_role;

COMMIT;
