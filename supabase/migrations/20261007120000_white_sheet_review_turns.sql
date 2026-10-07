-- Transient state for the read-only White Sheet vision review flow.
--
-- This table is NOT an official white-sheet, settlement or reporting source. It
-- only lets one LINE user's review of ONE sheet image be replayed exactly:
--   * 'base'  row  = the validated preview that was rendered after the first read
--   * 'turn'  rows = one per correction message, evaluated exactly once
--   * 'approval' rows = one per "ผ่าน" typed while a sheet is under review:
--     outcome 'applied'     = accepted (stores the exact snapshot that was approved),
--     outcome 'failed'      = refused (no valid applied snapshot existed),
--     outcome 'unavailable' = refused because a concurrent transition took the parent.
--     Replay of the webhook history reads these rows, so a refused approval can never
--     advance state.
-- A correction starts from the latest applied snapshot, never from a fresh
-- model read. A failed / unavailable correction is recorded as such and can
-- never become applied later (rows are append-only).
--
-- Ordering/concurrency: claim_line_webhook_event already hands one event per
-- source to one worker at a time. The partial unique index below is the
-- database-side guard for the residual case (a lease-expired worker): every
-- applied transition (a correction turn OR an accepted approval) consumes its
-- parent snapshot, and a parent can be consumed only once. The applied history
-- of a sheet is therefore always a linear chain.
--
-- Retention: rows are only needed while a session is live (10 minutes sliding,
-- 3 hours hard cap). The application prunes the same source's rows older than
-- 3 hours whenever a new base is written; correctness never depends on that,
-- because session state is derived from raw_messages/line_webhook_event_queue,
-- never from this table.

BEGIN;

CREATE TABLE public.white_sheet_review_turns (
  raw_message_id        uuid PRIMARY KEY
                        REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  -- Insertion order. The "latest applied snapshot" is the highest turn_seq.
  turn_seq              bigint GENERATED ALWAYS AS IDENTITY,
  destination           text NOT NULL,
  source_id             text NOT NULL,
  user_id               text NOT NULL,
  sheet_image_raw_id    uuid NOT NULL
                        REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  -- The applied row this turn was built from (NULL for a base).
  parent_raw_message_id uuid
                        REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  kind                  text NOT NULL,
  outcome               text NOT NULL,
  snapshot              jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT white_sheet_review_turns_kind_allowed
    CHECK (kind IN ('base', 'turn', 'approval')),
  CONSTRAINT white_sheet_review_turns_outcome_allowed
    CHECK (outcome IN ('applied', 'failed', 'unavailable')),
  CONSTRAINT white_sheet_review_turns_scope_nonblank
    CHECK (btrim(destination) <> '' AND btrim(source_id) <> '' AND btrim(user_id) <> ''),
  CONSTRAINT white_sheet_review_turns_snapshot_iff_applied
    CHECK ((outcome = 'applied') = (snapshot IS NOT NULL)),
  CONSTRAINT white_sheet_review_turns_snapshot_object
    CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT white_sheet_review_turns_snapshot_bounded
    CHECK (snapshot IS NULL OR octet_length(snapshot::text) <= 65536),
  -- A base is the sheet image's own event; a turn or approval is a different event.
  CONSTRAINT white_sheet_review_turns_base_is_the_image
    CHECK ((kind = 'base') = (raw_message_id = sheet_image_raw_id)),
  CONSTRAINT white_sheet_review_turns_base_has_no_parent
    CHECK (kind <> 'base' OR parent_raw_message_id IS NULL),
  CONSTRAINT white_sheet_review_turns_applied_turn_has_parent
    CHECK (kind = 'base' OR outcome <> 'applied' OR parent_raw_message_id IS NOT NULL)
);

-- At most ONE applied transition per parent snapshot, across kinds: a correction
-- and an approval (or two of either) can never both be applied from the same
-- snapshot. Failed/unavailable rows do not take the slot.
CREATE UNIQUE INDEX white_sheet_review_turns_one_applied_transition_per_parent
  ON public.white_sheet_review_turns (sheet_image_raw_id, parent_raw_message_id)
  WHERE kind IN ('turn', 'approval') AND outcome = 'applied';

-- A sheet can be accepted at most once.
CREATE UNIQUE INDEX white_sheet_review_turns_one_accepted_approval_per_sheet
  ON public.white_sheet_review_turns (sheet_image_raw_id)
  WHERE kind = 'approval' AND outcome = 'applied';

-- Latest applied snapshot of a sheet (base and turns only; approvals copy a snapshot).
CREATE INDEX white_sheet_review_turns_latest_applied_idx
  ON public.white_sheet_review_turns (sheet_image_raw_id, turn_seq DESC)
  WHERE outcome = 'applied' AND kind IN ('base', 'turn');

-- Bounded opportunistic prune per source.
CREATE INDEX white_sheet_review_turns_source_created_idx
  ON public.white_sheet_review_turns (source_id, created_at);

-- Append-only: a recorded outcome can never change, so a failed correction can
-- never silently become applied.
CREATE FUNCTION public.white_sheet_review_turns_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'white_sheet_review_turns rows are append-only';
END;
$fn$;

CREATE TRIGGER white_sheet_review_turns_no_update
  BEFORE UPDATE ON public.white_sheet_review_turns
  FOR EACH ROW EXECUTE FUNCTION public.white_sheet_review_turns_append_only();

-- Backend (service role) only. No policies are defined, so anon and
-- authenticated see nothing even if a grant is ever added by mistake.
ALTER TABLE public.white_sheet_review_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.white_sheet_review_turns FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.white_sheet_review_turns_append_only() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.white_sheet_review_turns TO service_role;

COMMENT ON TABLE public.white_sheet_review_turns IS
  'Transient read-only White Sheet review snapshots. Not official data; never read by reports, loaders, settlement or any API.';

COMMIT;
