-- Disposable-DB bootstrap for 20260831120000_produce_close_validation_race.sql.
-- Does NOT touch Production. Run against an empty local database only.
--
-- The migration under test is a wrapper: it takes the row lock, compares
-- ingest_revision, and delegates to the 8-arg append_pending_session. Dragging
-- in the real 0031/0032/0049 chain would pull most of the produce schema, so
-- this models the columns those migrations give pending_sessions and provides a
-- REDUCED-BUT-FAITHFUL 8-arg append: it reproduces the contract the wrapper
-- depends on — duplicate-event no-op, repeated-close status path, immutable
-- first boundary, out-of-order admission, post-close rejection, and an
-- ingest_revision that increments on every accepted content event.
--
-- That contract is what the wrapper is tested against. The real 8-arg body
-- stays authoritative in production precisely because the wrapper delegates to
-- it rather than copying it.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE service_role WITH BYPASSRLS;
  END IF;
END $$;

CREATE TABLE public.accountability_rounds (
  id                      uuid PRIMARY KEY,
  status                  text NOT NULL DEFAULT 'open'
);

CREATE TABLE public.pending_sessions (
  id                        uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  session_key               text NOT NULL UNIQUE,
  session_generation        uuid NOT NULL,
  source_id                 text NOT NULL,
  line_user_id              text,
  accumulated_text          text NOT NULL DEFAULT '',
  ingest_revision           integer NOT NULL DEFAULT 0,
  accountability_round_id   uuid REFERENCES public.accountability_rounds(id),
  terminalized              boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  close_requested_at        timestamptz,
  close_event_timestamp_ms  bigint,
  close_line_event_id        text,
  close_session_generation  uuid,
  close_deadline_at         timestamptz,
  close_refused_at          timestamptz,
  next_attempt_at           timestamptz,
  finalization_status       text NOT NULL DEFAULT 'pending',
  finalization_started_at   timestamptz,
  finalize_hold_until       timestamptz,
  finalized_at              timestamptz,
  finalization_error        jsonb,
  expected_item_count       integer,
  runtime_environment       text,
  entry_origin              text
);

CREATE TABLE public.pending_session_admission (
  session_key         text    NOT NULL,
  session_generation  uuid    NOT NULL,
  line_event_id       text    NOT NULL,
  line_timestamp_ms   bigint  NOT NULL,
  PRIMARY KEY (session_generation, line_event_id)
);

CREATE TABLE public.pending_session_ingest (
  session_key         text    NOT NULL,
  session_generation  uuid    NOT NULL,
  line_event_id       text    NOT NULL,
  line_timestamp_ms   bigint  NOT NULL,
  raw_text            text    NOT NULL,
  PRIMARY KEY (session_generation, line_event_id)
);

CREATE TABLE public.produce_entry_validation_reviews (
  id                        uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  session_key               text NOT NULL,
  session_generation        uuid NOT NULL,
  accountability_round_id   uuid REFERENCES public.accountability_rounds(id),
  validation_digest         text NOT NULL,
  business_date             date,
  market_label              text,
  staff_label               text,
  exceptions                jsonb NOT NULL DEFAULT '[]'::jsonb,
  presented_by_line_user_id text,
  presented_line_event_id   text,
  presented_at              timestamptz NOT NULL DEFAULT now(),
  confirmed_at              timestamptz,
  confirmed_by_line_user_id text,
  confirmed_line_event_id   text,
  CONSTRAINT produce_entry_validation_reviews_identity
    UNIQUE (session_key, session_generation, validation_digest)
);

-- Reduced-but-faithful stand-in for the 8-arg append the wrapper delegates to.
CREATE FUNCTION public.append_pending_session(
  p_session_key                  text,
  p_new_text                     text,
  p_reply_token                  text,
  p_line_event_id                text,
  p_line_timestamp_ms            bigint,
  p_mark_close                   boolean,
  p_expected_session_generation  uuid,
  p_expected_item_count          integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_row         public.pending_sessions%ROWTYPE;
  v_was_closing boolean;
BEGIN
  SELECT * INTO v_row FROM public.pending_sessions
  WHERE session_key = p_session_key FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  IF p_expected_session_generation IS NULL
     OR v_row.session_generation IS DISTINCT FROM p_expected_session_generation THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'generation_conflict');
  END IF;

  IF v_row.terminalized THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'terminalized', 'session', to_jsonb(v_row));
  END IF;

  v_was_closing := v_row.close_event_timestamp_ms IS NOT NULL;

  IF p_line_event_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.pending_session_admission
       WHERE session_generation = v_row.session_generation
         AND line_event_id = p_line_event_id) THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'duplicate_event', 'session', to_jsonb(v_row));
  END IF;

  -- Repeated close is a status request; the first boundary is immutable.
  IF v_was_closing AND p_mark_close THEN
    RETURN jsonb_build_object(
      'accepted', true, 'reason', 'close_already_requested', 'session', to_jsonb(v_row));
  END IF;

  -- Out-of-order admission: at or before the boundary is admitted, after it is
  -- rejected. Unchanged by the migration under test.
  IF v_was_closing
     AND p_line_timestamp_ms IS NOT NULL
     AND p_line_timestamp_ms > v_row.close_event_timestamp_ms THEN
    RETURN jsonb_build_object(
      'accepted', false, 'reason', 'after_close_boundary', 'session', to_jsonb(v_row));
  END IF;

  IF p_line_event_id IS NOT NULL THEN
    INSERT INTO public.pending_session_admission (
      session_key, session_generation, line_event_id, line_timestamp_ms)
    VALUES (p_session_key, v_row.session_generation, p_line_event_id,
            coalesce(p_line_timestamp_ms, 0));
    INSERT INTO public.pending_session_ingest (
      session_key, session_generation, line_event_id, line_timestamp_ms, raw_text)
    VALUES (p_session_key, v_row.session_generation, p_line_event_id,
            coalesce(p_line_timestamp_ms, 0), coalesce(p_new_text, ''));
  END IF;

  UPDATE public.pending_sessions ps
  SET accumulated_text = CASE
        WHEN coalesce(p_new_text, '') = '' THEN ps.accumulated_text
        WHEN ps.accumulated_text = '' THEN p_new_text
        ELSE ps.accumulated_text || E'\n' || p_new_text END,
      ingest_revision = ps.ingest_revision + 1,
      updated_at = now(),
      expected_item_count = coalesce(p_expected_item_count, ps.expected_item_count),
      close_requested_at = CASE
        WHEN p_mark_close AND NOT v_was_closing THEN now() ELSE ps.close_requested_at END,
      close_event_timestamp_ms = CASE
        WHEN p_mark_close AND NOT v_was_closing THEN p_line_timestamp_ms
        ELSE ps.close_event_timestamp_ms END,
      close_line_event_id = CASE
        WHEN p_mark_close AND NOT v_was_closing THEN p_line_event_id ELSE ps.close_line_event_id END,
      close_session_generation = CASE
        WHEN p_mark_close AND NOT v_was_closing THEN ps.session_generation
        ELSE ps.close_session_generation END,
      close_deadline_at = CASE
        WHEN p_mark_close AND NOT v_was_closing THEN now() + interval '30 seconds'
        ELSE ps.close_deadline_at END,
      next_attempt_at = CASE
        WHEN p_mark_close AND NOT v_was_closing THEN now() ELSE ps.next_attempt_at END
  WHERE ps.session_key = p_session_key
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('accepted', true, 'reason', 'appended', 'session', to_jsonb(v_row));
END;
$$;

-- The finalization delegate is a marker here. The test verifies the schedule
-- guard before any of the existing persistence logic is reached.
CREATE FUNCTION public.try_finalize_pending_generation(
  text, uuid, text, integer, text, text, jsonb, jsonb, text[]
)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('status', 'delegated')
$$;

-- Pre-migration versions of the review RPCs, so the test proves the migration
-- ADDS the terminalized guard rather than assuming it was always there.
CREATE FUNCTION public.record_produce_validation_review(
  p_session_key             text,
  p_session_generation      uuid,
  p_accountability_round_id uuid,
  p_validation_digest       text,
  p_business_date           date,
  p_market_label            text,
  p_staff_label             text,
  p_exceptions              jsonb,
  p_line_user_id            text,
  p_line_event_id           text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.produce_entry_validation_reviews;
BEGIN
  INSERT INTO public.produce_entry_validation_reviews (
    session_key, session_generation, accountability_round_id, validation_digest,
    business_date, market_label, staff_label, exceptions,
    presented_by_line_user_id, presented_line_event_id)
  VALUES (
    p_session_key, p_session_generation, p_accountability_round_id, p_validation_digest,
    p_business_date, p_market_label, p_staff_label, p_exceptions,
    p_line_user_id, p_line_event_id)
  ON CONFLICT ON CONSTRAINT produce_entry_validation_reviews_identity DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.produce_entry_validation_reviews
    WHERE session_key = p_session_key
      AND session_generation = p_session_generation
      AND validation_digest = p_validation_digest;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'confirmed', v_row.confirmed_at IS NOT NULL,
    'confirmed_at', v_row.confirmed_at,
    'presented_line_event_id', v_row.presented_line_event_id);
END;
$$;

CREATE FUNCTION public.confirm_produce_validation_review(
  p_session_key        text,
  p_session_generation uuid,
  p_validation_digest  text,
  p_line_user_id       text,
  p_line_event_id      text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.produce_entry_validation_reviews;
BEGIN
  SELECT * INTO v_row FROM public.produce_entry_validation_reviews
  WHERE session_key = p_session_key
    AND session_generation = p_session_generation
    AND validation_digest = p_validation_digest
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.confirmed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_confirmed', 'id', v_row.id);
  END IF;

  UPDATE public.produce_entry_validation_reviews
  SET confirmed_at = now(),
      confirmed_by_line_user_id = p_line_user_id,
      confirmed_line_event_id = p_line_event_id
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('status', 'confirmed', 'id', v_row.id);
END;
$$;
