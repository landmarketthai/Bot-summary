-- P0: durable accounting for every LINE slip image, and finalization that
-- cannot complete before earlier-received images are accounted for.
--
-- Incident (Production, batch d3ed6db7-822b-43fd-9fd0-06609a771a93): 25 image
-- events were received, only 5 reached the batch. Verified causal chain:
--   1. Slip images ride the ordered webhook queue, strictly head-of-line per
--      LINE source. One image whose download/storage failed was released back
--      to 'pending' and stopped the drain (`return processed`), so every later
--      image waited behind it.
--   2. "จบสลิป" is NOT queued: it ran immediately and moved the batch to
--      'closing'. claim_closing_slip_batch only counted evidences already
--      attached, so a batch with 5 attached evidences looked complete.
--   3. Images processed after the batch left 'closing' found no active session
--      and were acknowledged as 'processed' without a download, evidence row or
--      any record of the loss.
--
-- This migration adds:
--   * slip_image_events: one durable ledger row per unique queued LINE image
--     message, written in the SAME transaction as the queue receipt (trigger;
--     a ledger failure aborts the receipt), attributed to the batch by LINE
--     event time. Images received before their session exists are 'unbound'
--     and are bound when the session is created, when their worker runs, or
--     when the batch is claimed for finalization.
--   * RPCs: begin (lease + attempt budget), attach (idempotent), fail (bounded
--     backoff), due-list, OCR re-drive list, accounting, health.
--   * claim_closing_slip_batch: reconciles every image receipt in the
--     session's LINE window, then refuses to claim while ledger rows are still
--     in flight, bounded by p_ingest_max_seconds so an irrecoverable image
--     cannot block a batch forever.
--
-- Deployment prerequisite: apply this migration BEFORE deploying application
-- code that uses it. The application takes its legacy image path ONLY when the
-- ledger function is verifiably absent (42883 / PGRST202); any other ledger
-- error keeps the image pending in the queue (retryable, never acknowledged).

BEGIN;

-- ── 1. LINE timestamps of the open/close commands (attribution window) ────────
ALTER TABLE public.slip_batches
  ADD COLUMN IF NOT EXISTS open_event_ts_ms bigint,
  ADD COLUMN IF NOT EXISTS close_event_ts_ms bigint;

COMMENT ON COLUMN public.slip_batches.open_event_ts_ms IS
  'LINE event timestamp (ms) of the open command. Images sent earlier never belong to this batch.';
COMMENT ON COLUMN public.slip_batches.close_event_ts_ms IS
  'LINE event timestamp (ms) of the accepted close command. Images with a later LINE timestamp never belong to this batch, however late their worker runs.';

-- ── 2. Ledger ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.slip_image_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  line_message_id text        NOT NULL UNIQUE,
  raw_message_id  uuid        NOT NULL UNIQUE
                              REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  -- NULL only while no session covers the image's LINE time (see 'unbound').
  batch_id        uuid        REFERENCES public.slip_batches(id) ON DELETE CASCADE,
  source_id       text        NOT NULL,
  source_type     text        NOT NULL,
  line_user_id    text,
  event_ts_ms     bigint      NOT NULL,
  state           text        NOT NULL DEFAULT 'received',
  attempts        integer     NOT NULL DEFAULT 0,
  lease_until     timestamptz,
  next_retry_at   timestamptz,
  evidence_id     uuid        REFERENCES public.slip_evidences(id) ON DELETE SET NULL,
  last_error      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT slip_image_events_state_check CHECK (state IN (
    'unbound',               -- received before any session covering its LINE
                             -- time existed (e.g. same webhook as the open
                             -- command); bound when that session is created
    'no_session',            -- processed in LINE order and no session covers
                             -- it: not a slip of any batch (rebindable)
    'received',              -- durably received, not yet ingested
    'ingesting',             -- a worker holds the lease (download/store/attach)
    'retry_pending',         -- attempt failed; retry scheduled at next_retry_at
    'attached',              -- evidence stored and attached to the batch
    'failed_permanent',      -- attempt budget exhausted; visible, never zero-baht
    'excluded_after_close',  -- LINE time is after the close command
    'excluded_not_slip',     -- consumed by another flow (e.g. white sheet OCR)
    'late_after_finalize'    -- batch was finalized before this image attached
  )),
  CONSTRAINT slip_image_events_attempts_check CHECK (attempts >= 0),
  CONSTRAINT slip_image_events_attached_evidence_check
    CHECK (state <> 'attached' OR evidence_id IS NOT NULL),
  CONSTRAINT slip_image_events_binding_check
    CHECK ((batch_id IS NULL) = (state IN ('unbound', 'no_session')))
);

CREATE INDEX IF NOT EXISTS slip_image_events_unbound_idx
  ON public.slip_image_events (source_id, event_ts_ms)
  WHERE batch_id IS NULL;

CREATE INDEX IF NOT EXISTS slip_image_events_batch_state_idx
  ON public.slip_image_events (batch_id, state);
CREATE INDEX IF NOT EXISTS slip_image_events_open_idx
  ON public.slip_image_events (received_at)
  WHERE state IN ('received', 'ingesting', 'retry_pending');

ALTER TABLE public.slip_image_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.slip_image_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.slip_image_events TO service_role;

CREATE OR REPLACE FUNCTION public.set_slip_image_event_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_slip_image_events_updated_at ON public.slip_image_events;
CREATE TRIGGER trg_slip_image_events_updated_at
  BEFORE UPDATE ON public.slip_image_events
  FOR EACH ROW EXECUTE FUNCTION public.set_slip_image_event_updated_at();

-- ── 3. Capture at receipt (same transaction as the queue row) ─────────────────
-- LINE time of an event: payload.timestamp, else the receipt time.
CREATE OR REPLACE FUNCTION public.slip_image_event_ts(p_payload jsonb, p_fallback timestamptz)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(
    CASE WHEN (p_payload->>'timestamp') ~ '^[0-9]{1,15}$'
         THEN (p_payload->>'timestamp')::bigint END,
    floor(extract(epoch FROM p_fallback) * 1000)::bigint
  );
$fn$;

-- Attribute by LINE time, newest session first: the batch whose [open, close]
-- window contains the image. Open-ended windows (still collecting, or closing
-- without a recorded close time) match any later image. Rows from before this
-- migration have no open time; fall back to created_at with a small grace.
-- Returns (NULL, 'unbound') when no session covers the image (yet).
CREATE OR REPLACE FUNCTION public.resolve_slip_image_batch(
  p_source_id text,
  p_ts        bigint,
  OUT batch_id uuid,
  OUT state    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_b  record;
  v_lo bigint;
BEGIN
  FOR v_b IN
    SELECT b.id, b.status, b.created_at, b.open_event_ts_ms, b.close_event_ts_ms
      FROM public.slip_batches b
     WHERE b.source_id = p_source_id
     ORDER BY b.created_at DESC
     LIMIT 5
  LOOP
    v_lo := COALESCE(
      v_b.open_event_ts_ms,
      floor(extract(epoch FROM v_b.created_at) * 1000)::bigint - 15000
    );
    IF p_ts >= v_lo AND (v_b.close_event_ts_ms IS NULL OR p_ts <= v_b.close_event_ts_ms) THEN
      IF v_b.status IN ('collecting', 'closing') THEN
        batch_id := v_b.id; state := 'received'; RETURN;
      ELSIF v_b.close_event_ts_ms IS NOT NULL THEN
        -- Sent inside a session that has already been finalized: record the
        -- loss explicitly instead of letting it vanish.
        batch_id := v_b.id; state := 'late_after_finalize'; RETURN;
      END IF;
    END IF;
  END LOOP;

  -- Sent after the latest close command and before any newer session opened.
  SELECT b.id INTO batch_id
    FROM public.slip_batches b
   WHERE b.source_id = p_source_id
     AND b.status = 'closing'
     AND b.close_event_ts_ms IS NOT NULL
     AND p_ts > b.close_event_ts_ms
   ORDER BY b.created_at DESC
   LIMIT 1;
  state := CASE WHEN batch_id IS NULL THEN 'unbound' ELSE 'excluded_after_close' END;
END;
$fn$;

-- EVERY queued LINE image gets a ledger row, including images received before
-- the session that will own them exists (open command in the same webhook, or
-- still queued ahead of them). There is deliberately no exception handler: a
-- ledger write failure aborts the queue receipt itself, the webhook answers
-- retryable and LINE redelivers. A receipt without a ledger row cannot exist.
CREATE OR REPLACE FUNCTION public.capture_slip_image_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_raw                 record;
  v_ts                  bigint;
  v_batch_id            uuid;
  v_state               text;
  v_resolution_deferred boolean := false;
BEGIN
  SELECT r.message_type::text AS message_type,
         r.message_id,
         r.source_type::text  AS source_type,
         r.user_id,
         r.payload
    INTO v_raw
    FROM public.raw_messages r
   WHERE r.id = NEW.raw_message_id;

  IF NOT FOUND
     OR v_raw.message_type IS DISTINCT FROM 'image'
     OR v_raw.message_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_ts := public.slip_image_event_ts(v_raw.payload, NEW.received_at);
  BEGIN
    SELECT batch_id, state INTO v_batch_id, v_state
      FROM public.resolve_slip_image_batch(NEW.source_id, v_ts);
  EXCEPTION WHEN undefined_function THEN
    IF position('resolve_slip_image_batch' IN SQLERRM) = 0 THEN RAISE; END IF;
    -- Partial migration: preserve a ledger-backed queue barrier, never a
    -- raw-only receipt. begin_slip_image_attempt retries resolution and keeps
    -- this row head-of-line until the helper is restored.
    v_batch_id := NULL;
    v_state := 'unbound';
    v_resolution_deferred := true;
  END;

  INSERT INTO public.slip_image_events (
    line_message_id, raw_message_id, batch_id, source_id, source_type,
    line_user_id, event_ts_ms, state, resolved_at, last_error
  ) VALUES (
    v_raw.message_id, NEW.raw_message_id, v_batch_id, NEW.source_id,
    COALESCE(v_raw.source_type, 'user'), v_raw.user_id, v_ts, v_state,
    CASE WHEN v_state IN ('received', 'unbound') THEN NULL ELSE now() END,
    CASE WHEN v_resolution_deferred THEN 'resolve_slip_image_batch unavailable at receipt' END
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_capture_slip_image_event ON public.line_webhook_event_queue;
CREATE TRIGGER trg_capture_slip_image_event
  AFTER INSERT ON public.line_webhook_event_queue
  FOR EACH ROW EXECUTE FUNCTION public.capture_slip_image_event();

-- One LINE request may contain [open, images..., close]. Receipt must be
-- all-or-nothing: otherwise cron could claim an already-persisted close while
-- a middle image is absent. Calling the established single-event entrypoint
-- keeps its idempotency and capture trigger, inside this RPC's transaction.
CREATE OR REPLACE FUNCTION public.receive_line_webhook_payload(p_events jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_event   jsonb;
  v_receipt jsonb;
  v_result  jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_events) < 1 THEN
    RAISE EXCEPTION 'slip receipt: p_events must be a non-empty array';
  END IF;

  FOR v_event IN
    SELECT value
      FROM jsonb_array_elements(p_events) WITH ORDINALITY AS item(value, ordinal)
     ORDER BY ordinal
  LOOP
    v_receipt := public.receive_line_webhook_event(
      v_event->>'line_event_id', v_event->>'destination', v_event->>'event_type',
      v_event->>'source_type', v_event->>'source_id', v_event->>'user_id',
      v_event->>'message_id', v_event->>'message_type', v_event->>'raw_text',
      v_event->'payload'
    );
    v_result := v_result || jsonb_build_array(v_receipt || jsonb_build_object(
      'line_event_id', v_event->>'line_event_id',
      'source_id', v_event->>'source_id'
    ));
  END LOOP;
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.receive_line_webhook_payload(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_line_webhook_payload(jsonb) TO service_role;

-- A new session adopts every not-yet-bound image sent at or after its open
-- command (LINE time), in the same transaction that creates the session.
-- Receipts committed concurrently are bound by begin_slip_image_attempt or
-- claim_closing_slip_batch instead.
CREATE OR REPLACE FUNCTION public.bind_unbound_slip_image_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status NOT IN ('collecting', 'closing') THEN RETURN NEW; END IF;
  UPDATE public.slip_image_events
     SET batch_id = NEW.id, state = 'received', resolved_at = NULL, last_error = NULL
   WHERE source_id = NEW.source_id
     AND batch_id IS NULL
     AND state IN ('unbound', 'no_session')
     AND event_ts_ms >= COALESCE(
           NEW.open_event_ts_ms,
           floor(extract(epoch FROM NEW.created_at) * 1000)::bigint - 15000);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_bind_unbound_slip_image_events ON public.slip_batches;
CREATE TRIGGER trg_bind_unbound_slip_image_events
  AFTER INSERT ON public.slip_batches
  FOR EACH ROW EXECUTE FUNCTION public.bind_unbound_slip_image_events();

-- ── 4. begin: lease + attempt budget ──────────────────────────────────────────
-- Returns {claimed:false,...} for unknown, locked, already-resolved, leased or
-- not-yet-due rows. Attempts are counted here, so a worker that crashes
-- mid-attempt still consumes budget and cannot loop forever.
CREATE OR REPLACE FUNCTION public.begin_slip_image_attempt(
  p_line_message_id text,
  p_max_attempts    integer DEFAULT 5,
  p_lease_seconds   integer DEFAULT 120
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ev     public.slip_image_events%ROWTYPE;
  v_status text;
  v_res    record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.slip_image_events WHERE line_message_id = p_line_message_id
  ) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'no_ledger');
  END IF;

  SELECT * INTO v_ev
    FROM public.slip_image_events
   WHERE line_message_id = p_line_message_id
   FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    -- Another worker holds the row right now; it owns this attempt.
    RETURN jsonb_build_object('claimed', false, 'reason', 'locked');
  END IF;

  -- Received before its session existed. The ordered queue processes events
  -- in LINE order, so any open command sent before this image has run by now:
  -- bind to the session covering its LINE time, or resolve as no_session.
  IF v_ev.state = 'unbound' THEN
    v_res := public.resolve_slip_image_batch(v_ev.source_id, v_ev.event_ts_ms);
    IF v_res.batch_id IS NULL THEN
      UPDATE public.slip_image_events
         SET state = 'no_session', resolved_at = now()
       WHERE id = v_ev.id;
      RETURN jsonb_build_object('claimed', false, 'reason', 'resolved', 'state', 'no_session');
    END IF;
    UPDATE public.slip_image_events
       SET batch_id = v_res.batch_id, state = v_res.state,
           resolved_at = CASE WHEN v_res.state = 'received' THEN NULL ELSE now() END
     WHERE id = v_ev.id
    RETURNING * INTO v_ev;
  END IF;

  IF v_ev.state NOT IN ('received', 'retry_pending', 'ingesting') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'resolved', 'state', v_ev.state);
  END IF;
  IF v_ev.state = 'ingesting' AND v_ev.lease_until > now() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'leased', 'state', v_ev.state);
  END IF;
  IF v_ev.state = 'retry_pending' AND v_ev.next_retry_at > now() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_due', 'state', v_ev.state);
  END IF;

  -- Another flow (e.g. white sheet OCR) already consumed this image: it marked
  -- the raw message processed and no slip evidence exists. Never ingest it.
  IF v_ev.state = 'received'
     AND EXISTS (SELECT 1 FROM public.raw_messages r
                  WHERE r.id = v_ev.raw_message_id AND r.is_processed)
     AND NOT EXISTS (SELECT 1 FROM public.slip_evidences se
                      WHERE se.line_message_id = v_ev.line_message_id) THEN
    UPDATE public.slip_image_events
       SET state = 'excluded_not_slip', resolved_at = now(),
           last_error = 'consumed_by_other_flow'
     WHERE id = v_ev.id;
    RETURN jsonb_build_object('claimed', false, 'reason', 'resolved', 'state', 'excluded_not_slip');
  END IF;

  SELECT b.status INTO v_status FROM public.slip_batches b WHERE b.id = v_ev.batch_id;
  IF v_status IS NULL OR v_status NOT IN ('collecting', 'closing') THEN
    UPDATE public.slip_image_events
       SET state = 'late_after_finalize', lease_until = NULL, next_retry_at = NULL,
           resolved_at = now(), last_error = COALESCE(last_error, 'batch_finalized_before_ingest')
     WHERE id = v_ev.id;
    RETURN jsonb_build_object('claimed', false, 'reason', 'batch_finalized', 'state', 'late_after_finalize');
  END IF;

  IF v_ev.attempts >= p_max_attempts THEN
    UPDATE public.slip_image_events
       SET state = 'failed_permanent', lease_until = NULL, next_retry_at = NULL,
           resolved_at = now(), last_error = COALESCE(last_error, 'attempt_budget_exhausted')
     WHERE id = v_ev.id;
    RETURN jsonb_build_object('claimed', false, 'reason', 'budget_exhausted', 'state', 'failed_permanent');
  END IF;

  UPDATE public.slip_image_events
     SET state = 'ingesting',
         attempts = attempts + 1,
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
         next_retry_at = NULL
   WHERE id = v_ev.id
  RETURNING * INTO v_ev;

  RETURN jsonb_build_object(
    'claimed', true,
    'event_id', v_ev.id,
    'line_message_id', v_ev.line_message_id,
    'raw_message_id', v_ev.raw_message_id,
    'batch_id', v_ev.batch_id,
    'source_id', v_ev.source_id,
    'source_type', v_ev.source_type,
    'line_user_id', v_ev.line_user_id,
    'event_ts_ms', v_ev.event_ts_ms,
    'attempt', v_ev.attempts
  );
END;
$fn$;

-- ── 5. attach: idempotent, ordered by LINE time, never silent ─────────────────
-- Lock order is batch -> ledger row everywhere (claim_closing_slip_batch does
-- the same), so attach and the finalizer claim cannot deadlock.
-- p_attempt is the fencing token returned by begin_slip_image_attempt
-- (attempts is bumped on every claim). A stale worker whose lease expired and
-- was re-claimed holds an older token and cannot touch the newer claim.
CREATE OR REPLACE FUNCTION public.attach_slip_image_event(
  p_line_message_id text,
  p_evidence_id     uuid,
  p_attempt         integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_batch_id uuid;
  v_batch    public.slip_batches%ROWTYPE;
  v_ev       public.slip_image_events%ROWTYPE;
  v_ev_batch uuid;
  v_ev_index integer;
  v_index    integer;
BEGIN
  SELECT batch_id INTO v_batch_id
    FROM public.slip_image_events WHERE line_message_id = p_line_message_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'no_ledger');
  END IF;
  IF v_batch_id IS NULL THEN
    -- Only begin_slip_image_attempt binds; never attach an unbound image.
    RAISE EXCEPTION 'slip image % is not bound to a batch', p_line_message_id;
  END IF;

  SELECT * INTO v_batch FROM public.slip_batches WHERE id = v_batch_id FOR UPDATE;
  SELECT * INTO v_ev FROM public.slip_image_events
   WHERE line_message_id = p_line_message_id FOR UPDATE;

  IF v_ev.state = 'attached' THEN
    SELECT se.batch_index INTO v_ev_index FROM public.slip_evidences se WHERE se.id = v_ev.evidence_id;
    RETURN jsonb_build_object('outcome', 'already_attached', 'batch_id', v_ev.batch_id,
                              'batch_index', v_ev_index, 'evidence_id', v_ev.evidence_id);
  END IF;
  IF v_ev.state IN ('excluded_after_close', 'excluded_not_slip', 'late_after_finalize') THEN
    RETURN jsonb_build_object('outcome', v_ev.state);
  END IF;
  IF v_ev.attempts IS DISTINCT FROM p_attempt THEN
    RETURN jsonb_build_object('outcome', 'stale_claim', 'state', v_ev.state);
  END IF;

  IF v_batch.status NOT IN ('collecting', 'closing') THEN
    UPDATE public.slip_image_events
       SET state = 'late_after_finalize', lease_until = NULL, next_retry_at = NULL,
           evidence_id = p_evidence_id, resolved_at = now(),
           last_error = 'batch_finalized_before_attach'
     WHERE id = v_ev.id;
    RETURN jsonb_build_object('outcome', 'late_after_finalize', 'batch_id', v_batch_id);
  END IF;

  IF v_batch.close_event_ts_ms IS NOT NULL AND v_ev.event_ts_ms > v_batch.close_event_ts_ms THEN
    UPDATE public.slip_image_events
       SET state = 'excluded_after_close', lease_until = NULL, next_retry_at = NULL,
           evidence_id = p_evidence_id, resolved_at = now()
     WHERE id = v_ev.id;
    RETURN jsonb_build_object('outcome', 'excluded_after_close', 'batch_id', v_batch_id);
  END IF;

  -- Evidence already linked to a batch (legacy path or an earlier attempt that
  -- crashed before the ledger update): reconcile instead of attaching twice.
  SELECT se.batch_id, se.batch_index INTO v_ev_batch, v_ev_index
    FROM public.slip_evidences se WHERE se.id = p_evidence_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'slip evidence % not found', p_evidence_id;
  END IF;
  IF v_ev_batch IS NOT NULL THEN
    UPDATE public.slip_image_events
       SET state = 'attached', evidence_id = p_evidence_id, lease_until = NULL,
           next_retry_at = NULL, resolved_at = now(), last_error = NULL
     WHERE id = v_ev.id;
    RETURN jsonb_build_object('outcome', 'already_attached', 'batch_id', v_ev_batch,
                              'batch_index', v_ev_index, 'evidence_id', p_evidence_id);
  END IF;

  v_index := public.attach_evidence_to_slip_batch(v_batch_id, p_evidence_id);

  UPDATE public.slip_image_events
     SET state = 'attached', evidence_id = p_evidence_id, lease_until = NULL,
         next_retry_at = NULL, resolved_at = now(), last_error = NULL
   WHERE id = v_ev.id;

  RETURN jsonb_build_object('outcome', 'attached', 'batch_id', v_batch_id,
                            'batch_index', v_index, 'evidence_id', p_evidence_id);
END;
$fn$;

-- ── 6. fail: bounded exponential backoff ──────────────────────────────────────
-- p_error is a short machine code (download_failed, storage_failed, ...), never
-- a raw provider message, so no URL or token can land in the ledger.
CREATE OR REPLACE FUNCTION public.fail_slip_image_event(
  p_line_message_id text,
  p_error           text,
  p_attempt         integer,
  p_max_attempts    integer DEFAULT 5,
  p_permanent       boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ev    public.slip_image_events%ROWTYPE;
  v_code  text := left(coalesce(nullif(btrim(p_error), ''), 'unknown'), 80);
  v_delay integer;
BEGIN
  SELECT * INTO v_ev FROM public.slip_image_events
   WHERE line_message_id = p_line_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'no_ledger');
  END IF;
  IF v_ev.state NOT IN ('received', 'ingesting', 'retry_pending') THEN
    RETURN jsonb_build_object('outcome', 'already_resolved', 'state', v_ev.state);
  END IF;
  IF v_ev.attempts IS DISTINCT FROM p_attempt THEN
    -- Fencing token mismatch: a newer claim owns the row; leave it untouched.
    RETURN jsonb_build_object('outcome', 'stale_claim', 'state', v_ev.state);
  END IF;

  IF p_permanent OR v_ev.attempts >= p_max_attempts THEN
    UPDATE public.slip_image_events
       SET state = 'failed_permanent', lease_until = NULL, next_retry_at = NULL,
           resolved_at = now(), last_error = v_code
     WHERE id = v_ev.id;
    RETURN jsonb_build_object('outcome', 'failed_permanent', 'attempts', v_ev.attempts);
  END IF;

  -- 15s, 30s, 60s, 120s, 240s (cap 300s)
  v_delay := least(15 * power(2, greatest(v_ev.attempts - 1, 0))::integer, 300);
  UPDATE public.slip_image_events
     SET state = 'retry_pending', lease_until = NULL, last_error = v_code,
         next_retry_at = now() + make_interval(secs => v_delay)
   WHERE id = v_ev.id;
  RETURN jsonb_build_object('outcome', 'retry_pending', 'attempts', v_ev.attempts,
                            'retry_in_seconds', v_delay);
END;
$fn$;

-- ── 7. Recovery work lists ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_due_slip_image_events(
  p_limit integer DEFAULT 10
) RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT ev.line_message_id
    FROM public.slip_image_events ev
    LEFT JOIN public.line_webhook_event_queue q ON q.raw_message_id = ev.raw_message_id
   WHERE (ev.state = 'retry_pending' AND ev.next_retry_at <= now())
      OR (ev.state = 'ingesting' AND ev.lease_until < now())
      -- The queue worker finished the event but the ledger never resolved
      -- (worker crashed between queue completion and ledger update).
      OR (ev.state = 'received' AND q.status = 'processed'
          AND ev.received_at < now() - interval '30 seconds')
   -- Fair across a burst: fewest attempts first, so the oldest few images
   -- cannot take every sweep while the rest of the batch stays at attempt 1.
   ORDER BY ev.attempts, COALESCE(ev.next_retry_at, ev.lease_until, ev.received_at), ev.received_at, ev.id
   LIMIT greatest(1, least(coalesce(p_limit, 10), 50));
$fn$;

-- Attached evidence whose OCR never started (worker died after attach) or has
-- been PROCESSING implausibly long. Completed checks are never re-run.
CREATE OR REPLACE FUNCTION public.list_slip_ocr_redrive(
  p_limit integer DEFAULT 10
) RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT ev.evidence_id
    FROM public.slip_image_events ev
    JOIN public.slip_batches b ON b.id = ev.batch_id
    LEFT JOIN public.slip_checks sc ON sc.evidence_id = ev.evidence_id
   WHERE ev.state = 'attached'
     AND b.status IN ('collecting', 'closing')
     AND (
       (sc.id IS NULL AND ev.resolved_at < now() - interval '90 seconds')
       OR (sc.status = 'PROCESSING' AND sc.updated_at < now() - interval '5 minutes')
     )
   ORDER BY ev.resolved_at
   LIMIT greatest(1, least(coalesce(p_limit, 10), 50));
$fn$;

-- ── 8. Accounting + health (observability) ────────────────────────────────────
-- waiting     : still being ingested (received/ingesting/retry_pending) and the
--               queue row for a never-started event is not dead.
-- queue_dead  : never-started events whose queue row went failed/stale — will
--               never be processed; permanently incomplete.
-- incomplete  : everything that is NOT in the batch and NOT deliberately
--               excluded: waiting + queue_dead + failed_permanent + late.
CREATE OR REPLACE FUNCTION public.slip_batch_image_accounting(
  p_batch_id uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH e AS (
    SELECT ev.state, ev.event_ts_ms, ev.received_at, q.status AS queue_status, sc.status AS check_status
      FROM public.slip_image_events ev
      LEFT JOIN public.line_webhook_event_queue q ON q.raw_message_id = ev.raw_message_id
      LEFT JOIN public.slip_checks sc ON sc.evidence_id = ev.evidence_id
     WHERE ev.batch_id = p_batch_id
  ), c AS (
    SELECT
      count(*) FILTER (WHERE state NOT IN ('excluded_after_close', 'excluded_not_slip')) AS received_total,
      count(*) FILTER (WHERE state = 'attached') AS attached,
      count(*) FILTER (
        WHERE state IN ('received', 'ingesting', 'retry_pending')
          AND NOT (state = 'received' AND queue_status IN ('failed', 'stale'))
      ) AS waiting,
      count(*) FILTER (WHERE state = 'retry_pending') AS retry_pending,
      count(*) FILTER (WHERE state = 'received' AND queue_status IN ('failed', 'stale')) AS queue_dead,
      count(*) FILTER (WHERE state = 'failed_permanent') AS failed_permanent,
      count(*) FILTER (WHERE state = 'late_after_finalize') AS late_after_finalize,
      count(*) FILTER (WHERE state = 'excluded_after_close') AS excluded_after_close,
      count(*) FILTER (WHERE state = 'excluded_not_slip') AS excluded_not_slip,
      count(*) FILTER (WHERE state = 'attached'
                         AND check_status IN ('EXTRACTED', 'PARTIAL_EXTRACTED', 'NEED_REVIEW', 'FAILED')) AS ocr_complete,
      count(*) FILTER (WHERE state = 'attached'
                         AND (check_status IS NULL OR check_status = 'PROCESSING')) AS ocr_pending,
      floor(extract(epoch FROM now() - min(received_at) FILTER (
        WHERE state IN ('received', 'ingesting', 'retry_pending'))))::bigint AS oldest_unresolved_age_seconds
    FROM e
  )
  SELECT jsonb_build_object(
    'batch_id', p_batch_id,
    'received_total', received_total,
    'attached', attached,
    'waiting', waiting,
    'retry_pending', retry_pending,
    'queue_dead', queue_dead,
    'failed_permanent', failed_permanent,
    'late_after_finalize', late_after_finalize,
    'excluded_after_close', excluded_after_close,
    'excluded_not_slip', excluded_not_slip,
    'ocr_complete', ocr_complete,
    'ocr_pending', ocr_pending,
    'incomplete', waiting + queue_dead + failed_permanent + late_after_finalize,
    'oldest_unresolved_age_seconds', oldest_unresolved_age_seconds
  ) FROM c;
$fn$;

CREATE OR REPLACE FUNCTION public.slip_image_ledger_health()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'unbound', count(*) FILTER (WHERE state = 'unbound'),
    'received', count(*) FILTER (WHERE state = 'received'),
    'ingesting', count(*) FILTER (WHERE state = 'ingesting'),
    'retry_pending', count(*) FILTER (WHERE state = 'retry_pending'),
    'failed_permanent_24h', count(*) FILTER (WHERE state = 'failed_permanent' AND resolved_at > now() - interval '24 hours'),
    'late_after_finalize_24h', count(*) FILTER (WHERE state = 'late_after_finalize' AND resolved_at > now() - interval '24 hours'),
    'oldest_unresolved_age_seconds', floor(extract(epoch FROM now() - min(received_at) FILTER (
      WHERE state IN ('received', 'ingesting', 'retry_pending'))))::bigint
  )
  FROM public.slip_image_events
  WHERE received_at > now() - interval '7 days';
$fn$;

-- ── 9. Finalizer claim: do not finish before the ledger is accounted for ─────
-- Replaces the 3-argument function. p_ingest_max_seconds is the upper bound on
-- how long a closing batch waits for in-flight images, counted cohort-wide
-- from the later of the close and the batch's last image receipt; after it
-- the batch is claimed as forced (was_timeout = true) and the summary reports
-- the gap. The default mirrors DEFAULT_INGEST_MAX_SECONDS (ingest-policy.ts:
-- 25-image burst, no in-request retries, worst-case attempts, 5-min cron).
--
-- OCR gate: attached evidence whose check is missing or still PROCESSING
-- (e.g. the background OCR worker crashed) can still be re-driven by the cron
-- sweep, so the batch is NOT finalized past it until a bounded OCR wait ends:
-- claim lease 300 s + one 30 s job + 120 s margin, plus one sweep gap (420 s)
-- per 10 attached images (the redrive lanes per sweep). Counted from the later
-- of the close and the last attach. Mirrors requiredOcrWaitSeconds().
DROP FUNCTION IF EXISTS public.claim_closing_slip_batch(uuid, integer, integer);

CREATE OR REPLACE FUNCTION public.claim_closing_slip_batch(
  p_batch_id           uuid,
  p_quiet_seconds      integer,
  p_max_seconds        integer,
  p_ingest_max_seconds integer DEFAULT 2160
) RETURNS TABLE(claimed_id uuid, claimed_source_id text, was_timeout boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  v_batch       public.slip_batches%ROWTYPE;
  v_now         timestamptz := now();
  v_close_start timestamptz;
  v_ingest_from timestamptz;
  v_timed_out   boolean;
  v_quiet_ok    boolean;
  v_unresolved  bigint;
  v_ingest_cut  boolean := false;
  v_ocr_open    bigint;
  v_ev_count    bigint;
  v_ck_count    bigint;
  v_pr_count    bigint;
  v_lo          bigint;
  v_hi          bigint;
BEGIN
  -- Lock the batch row; serializes against attach_evidence_to_slip_batch and
  -- attach_slip_image_event.
  SELECT * INTO v_batch
  FROM   public.slip_batches
  WHERE  id = p_batch_id AND status = 'closing'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  v_close_start := COALESCE(v_batch.closing_at, v_batch.last_image_at);

  -- Reconcile every queue receipt sent inside this session's LINE window
  -- before deciding anything, so a receipt the ledger does not yet account
  -- for can never be finalized past.
  v_lo := COALESCE(v_batch.open_event_ts_ms,
                   floor(extract(epoch FROM v_batch.created_at) * 1000)::bigint - 15000);
  v_hi := COALESCE(v_batch.close_event_ts_ms,
                   floor(extract(epoch FROM v_close_start) * 1000)::bigint);

  -- (a) unbound receipts committed concurrently with the session's creation.
  UPDATE public.slip_image_events
     SET batch_id = p_batch_id, state = 'received', resolved_at = NULL, last_error = NULL
   WHERE source_id = v_batch.source_id
     AND batch_id IS NULL
     AND state IN ('unbound', 'no_session')
     AND event_ts_ms BETWEEN v_lo AND v_hi;

  -- (b) image receipts with no ledger row at all (queued before this
  -- migration was applied, during rollout). Already attached here -> attached;
  -- otherwise received, so the batch waits for them like any other image.
  INSERT INTO public.slip_image_events (
    line_message_id, raw_message_id, batch_id, source_id, source_type,
    line_user_id, event_ts_ms, state, evidence_id, resolved_at
  )
  SELECT r.message_id, r.id, p_batch_id, q.source_id, COALESCE(r.source_type::text, 'user'),
         r.user_id, t.ts,
         CASE WHEN se.batch_id = p_batch_id THEN 'attached' ELSE 'received' END,
         CASE WHEN se.batch_id = p_batch_id THEN se.id END,
         CASE WHEN se.batch_id = p_batch_id THEN v_now END
    FROM public.line_webhook_event_queue q
    JOIN public.raw_messages r ON r.id = q.raw_message_id
    CROSS JOIN LATERAL (SELECT public.slip_image_event_ts(r.payload, q.received_at) AS ts) t
    LEFT JOIN public.slip_evidences se ON se.line_message_id = r.message_id
   WHERE q.source_id = v_batch.source_id
     AND q.received_at >= v_batch.created_at - interval '1 hour'
     AND r.message_type::text = 'image'
     AND r.message_id IS NOT NULL
     AND t.ts BETWEEN v_lo AND v_hi
     AND NOT EXISTS (SELECT 1 FROM public.slip_image_events ev
                      WHERE ev.raw_message_id = r.id OR ev.line_message_id = r.message_id)
  ON CONFLICT DO NOTHING;

  -- (c) evidence already attached to THIS batch through a path that never
  -- touched the ledger (an old app version running against the new schema, or
  -- a legacy attach). The image is in the batch: account for it as attached
  -- instead of waiting for a ledger transition that will never come.
  UPDATE public.slip_image_events ev
     SET state = 'attached', evidence_id = se.id, lease_until = NULL,
         next_retry_at = NULL, resolved_at = v_now, last_error = NULL
    FROM public.slip_evidences se
   WHERE ev.batch_id = p_batch_id
     AND ev.state IN ('received', 'ingesting', 'retry_pending')
     AND se.line_message_id = ev.line_message_id
     AND se.batch_id = p_batch_id;

  -- Images whose LINE time is after the close command never belong here.
  IF v_batch.close_event_ts_ms IS NOT NULL THEN
    UPDATE public.slip_image_events
       SET state = 'excluded_after_close', lease_until = NULL, next_retry_at = NULL,
           resolved_at = v_now
     WHERE batch_id = p_batch_id
       AND state IN ('received', 'ingesting', 'retry_pending')
       AND event_ts_ms > v_batch.close_event_ts_ms;
  END IF;

  -- Images another flow already consumed (white sheet OCR marks the raw
  -- message processed and never creates slip evidence) are not slips.
  UPDATE public.slip_image_events ev
     SET state = 'excluded_not_slip', resolved_at = v_now,
         last_error = 'consumed_by_other_flow'
    FROM public.raw_messages r
   WHERE ev.batch_id = p_batch_id
     AND ev.state = 'received'
     AND r.id = ev.raw_message_id
     AND r.is_processed
     AND NOT EXISTS (SELECT 1 FROM public.slip_evidences se
                      WHERE se.line_message_id = ev.line_message_id);

  -- In-flight images: received/ingesting/retry_pending, except never-started
  -- events whose queue row is dead (those can never complete).
  SELECT count(*) INTO v_unresolved
    FROM public.slip_image_events ev
    LEFT JOIN public.line_webhook_event_queue q ON q.raw_message_id = ev.raw_message_id
   WHERE ev.batch_id = p_batch_id
     AND ev.state IN ('received', 'ingesting', 'retry_pending')
     AND NOT (ev.state = 'received' AND q.status IN ('failed', 'stale'));

  IF v_unresolved > 0 THEN
    -- Cohort-wide: a receipt that only reached the ledger after the close
    -- (late webhook delivery, reconciliation above) gets the whole wait too.
    SELECT GREATEST(v_close_start, max(ev.received_at)) INTO v_ingest_from
      FROM public.slip_image_events ev
     WHERE ev.batch_id = p_batch_id
       AND ev.state NOT IN ('excluded_after_close', 'excluded_not_slip');
    IF v_now - COALESCE(v_ingest_from, v_close_start) < make_interval(secs => p_ingest_max_seconds) THEN
      RETURN;  -- still within the bounded ingest wait
    END IF;
    v_ingest_cut := true;  -- bound exhausted: finalize and report the gap
  END IF;

  -- OCR time is measured from the later of close and the last attach, so a
  -- long ingest does not consume the OCR budget of the images that landed late.
  v_timed_out := v_now - GREATEST(v_close_start, v_batch.last_image_at)
                   >= make_interval(secs => p_max_seconds);
  v_quiet_ok  := v_now - v_batch.last_image_at
                   >= make_interval(secs => p_quiet_seconds);

  -- OCR gate (see header): checks that are missing or PROCESSING are still
  -- recoverable by the redrive; p_max_seconds alone must not finalize past them.
  SELECT count(*) FILTER (WHERE sc.id IS NULL OR sc.status = 'PROCESSING'), count(*)
    INTO v_ocr_open, v_ev_count
    FROM public.slip_evidences se
    LEFT JOIN public.slip_checks sc ON sc.evidence_id = se.id
   WHERE se.batch_id = p_batch_id;
  IF v_ocr_open > 0 THEN
    IF v_now - GREATEST(v_close_start, v_batch.last_image_at)
         < make_interval(secs => 450 + ceil(v_ev_count::numeric / 10)::integer * 420) THEN
      RETURN;  -- still within the bounded OCR wait
    END IF;
    v_timed_out := true;  -- OCR bound exhausted: finalize, unread slips go to review
  END IF;

  IF v_ingest_cut THEN
    v_timed_out := true;
  END IF;

  IF NOT v_timed_out AND NOT v_quiet_ok THEN RETURN; END IF;

  -- If not timed out, also require all checks to be terminal.
  IF NOT v_timed_out THEN
    SELECT COUNT(*) INTO v_ev_count
    FROM   public.slip_evidences
    WHERE  batch_id = p_batch_id;

    IF v_ev_count > 0 THEN
      SELECT COUNT(*) INTO v_ck_count
      FROM   public.slip_checks sc
      JOIN   public.slip_evidences se ON sc.evidence_id = se.id
      WHERE  se.batch_id = p_batch_id;

      IF v_ck_count < v_ev_count THEN RETURN; END IF;

      SELECT COUNT(*) INTO v_pr_count
      FROM   public.slip_checks sc
      JOIN   public.slip_evidences se ON sc.evidence_id = se.id
      WHERE  se.batch_id = p_batch_id AND sc.status = 'PROCESSING';

      IF v_pr_count > 0 THEN RETURN; END IF;
    END IF;
  END IF;

  UPDATE public.slip_batches
  SET    status = 'processing'
  WHERE  id = p_batch_id;

  RETURN QUERY SELECT v_batch.id, v_batch.source_id, v_timed_out;
END;
$$;

-- ── 10. Privileges ────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.capture_slip_image_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bind_unbound_slip_image_events() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_slip_image_batch(text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.slip_image_event_ts(jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_slip_image_attempt(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_slip_image_event(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_slip_image_event(text, text, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_due_slip_image_events(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_slip_ocr_redrive(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.slip_batch_image_accounting(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.slip_image_ledger_health() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_closing_slip_batch(uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_slip_image_attempt(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_slip_image_event(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_slip_image_event(text, text, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_due_slip_image_events(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_slip_ocr_redrive(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.slip_batch_image_accounting(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.slip_image_ledger_health() TO service_role;
-- The closing claim is SECURITY INVOKER and calls this helper while reconciling
-- queued image receipts. Without this grant service_role gets 42501 and no
-- batches are claimable, despite the RPC itself being granted.
GRANT EXECUTE ON FUNCTION public.slip_image_event_ts(jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_closing_slip_batch(uuid, integer, integer, integer) TO service_role;

COMMIT;
