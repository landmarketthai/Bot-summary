-- Durable per-line Produce staging for partially valid LINE documents.
--
-- This snapshot is deliberately stored on pending_sessions rather than in
-- produce_items. A line may be safely understood while another line in the
-- same document still needs human correction; exposing the understood subset
-- as finalized Produce would contaminate Settlement and reporting. The
-- snapshot therefore proves "we retained these good lines" without changing
-- any financial source of truth.

ALTER TABLE public.pending_sessions
  ADD COLUMN IF NOT EXISTS partial_capture_revision bigint,
  ADD COLUMN IF NOT EXISTS partial_capture jsonb,
  ADD COLUMN IF NOT EXISTS partial_capture_updated_at timestamptz;

ALTER TABLE public.pending_sessions
  DROP CONSTRAINT IF EXISTS pending_sessions_partial_capture_shape;

ALTER TABLE public.pending_sessions
  ADD CONSTRAINT pending_sessions_partial_capture_shape CHECK (
    partial_capture IS NULL
    OR (
      jsonb_typeof(partial_capture) = 'object'
      AND (partial_capture ->> 'version') = '1'
      AND jsonb_typeof(partial_capture -> 'items') = 'array'
      AND jsonb_typeof(partial_capture -> 'issues') = 'array'
    )
  );

CREATE INDEX IF NOT EXISTS pending_sessions_partial_capture_review_idx
  ON public.pending_sessions (updated_at)
  WHERE partial_capture IS NOT NULL;

COMMENT ON COLUMN public.pending_sessions.partial_capture IS
  'Durable non-financial snapshot of accepted and needs-review Produce lines. Final reports ignore it until the generation finalizes normally.';
COMMENT ON COLUMN public.pending_sessions.partial_capture_revision IS
  'ingest_revision whose Produce partial-capture snapshot was evaluated.';
