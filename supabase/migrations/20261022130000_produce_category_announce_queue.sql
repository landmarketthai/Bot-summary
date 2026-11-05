-- Review-announcement queue for produce_category_candidates.
--
-- The notifier must select ONLY candidates whose current revision has not
-- been announced. PostgREST cannot compare two columns, so the condition is a
-- generated column; the notifier reads it FIFO (created_at, product_name) with
-- a small per-run limit, so every unannounced candidate is reached in turn.

BEGIN;

ALTER TABLE public.produce_category_candidates
  ADD COLUMN needs_announcement boolean
  GENERATED ALWAYS AS (
    status = 'pending' AND (notified_revision IS NULL OR notified_revision < revision)
  ) STORED;

CREATE INDEX produce_category_candidates_announce_queue_idx
  ON public.produce_category_candidates (created_at, product_name)
  WHERE needs_announcement;

COMMIT;
