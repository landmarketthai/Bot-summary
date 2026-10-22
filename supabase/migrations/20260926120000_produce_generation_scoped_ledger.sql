-- Generation-scoped ledger ownership for the pending-produce ingest and
-- admission ledgers.
--
-- Forward-only. No existing migration is modified. No ledger row is deleted by
-- this migration; every (session_key, session_generation) pair that already
-- has ingest or admission evidence — or a current pending_sessions row — is
-- backfilled into a new registry BEFORE the new constraint is validated, so
-- zero orphans are created.
--
-- This is a pending-forward migration: it sorts strictly after the Production
-- ledger max recorded in supabase/migration-history-manifest.json, and every
-- migration that asserts the pre-existing session_key-only ledger FK
-- (0044_reconcile_pending_close_baseline.sql) sorts BEFORE it, so applying the
-- full chain in filename order never trips a stale-schema assertion.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The defect
-- ─────────────────────────────────────────────────────────────────────────────
-- pending_session_ingest     PRIMARY KEY (session_generation, line_event_id)
--                            FOREIGN KEY (session_key) REFERENCES
--                              pending_sessions(session_key) ON DELETE CASCADE
-- pending_session_admission  same shape.
--
-- pending_sessions holds exactly ONE row per session_key (UNIQUE(session_key)).
-- session_generation is mutated IN PLACE on that one row every time a
-- generation rotates (open_pending_plain_text_generation,
-- PendingSessionService.replaceGeneration) — it is never append-only. The
-- ingest/admission tables, by contrast, accumulate one row per LINE event
-- across EVERY generation a session_key has ever had. The overwhelming
-- majority of ledger rows therefore do NOT match the CURRENT generation
-- recorded on their session_key's pending_sessions row — that is expected, not
-- corruption; it is the historical ledger doing its job.
--
-- Because the two ledger tables' ONLY ownership key is session_key, deleting
-- the single pending_sessions row for a session_key cascades to EVERY
-- generation's ledger rows for that key, not just the one being acted on.
--
-- This is reachable. `PendingSessionService.deleteGeneration` in
-- src/lib/line/pending-session-service.ts (called from the catch block of
-- `replaceGeneration`, i.e. whenever the ingest/admission insert for a
-- freshly-rotated generation fails) used to issue:
--   DELETE FROM pending_sessions WHERE session_key = $1 AND session_generation = $2
-- The WHERE clause is correctly scoped to one generation, but because the
-- table-level CASCADE is keyed on session_key alone, it deletes ingest/
-- admission evidence for every OTHER generation of that key too — the exact
-- opposite of what the method name promises. `PendingSessionService.delete`
-- (a full-key purge) depends on the same FK and is intentionally left with
-- full-purge semantics (see below).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the fix is NOT "add session_generation to the existing FK"
-- ─────────────────────────────────────────────────────────────────────────────
-- pending_sessions has only ONE row per session_key, so it can never be the
-- referenced side of a composite (session_key, session_generation) foreign
-- key: as soon as a generation rotates, the OLD (session_key, generation)
-- tuple stops existing in pending_sessions (the row was UPDATEd, not
-- inserted), which would either reject the rotation outright (default
-- ON UPDATE NO ACTION) or silently corrupt history (ON UPDATE CASCADE
-- rewriting old ledger rows to the new generation). A composite FK straight
-- into pending_sessions is the wrong parent, full stop.
--
-- The fix instead introduces an APPEND-ONLY registry,
-- `pending_session_generations`, of every generation a session_key has ever
-- had. It is the parent the ledger tables reference by composite key. Its own
-- relationship to pending_sessions stays keyed on session_key ON DELETE
-- CASCADE — identical to today's contract — so a genuine full-key purge
-- (`PendingSessionService.delete`) continues to wipe every generation. What
-- changes is that deleting ONE registry row (one generation) now cascades to
-- ONLY that generation's ledger rows.
--
-- `PendingSessionService.deleteGeneration` is updated in the same change to
-- target `pending_session_generations` instead of `pending_sessions`, which is
-- what actually closes the defect end-to-end: the schema change alone does not
-- fix the reachable bug until the app-code change ships too. See the deployment
-- ordering contract below — the two sides are NOT symmetrically compatible.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Deployment ordering contract (READ BEFORE DEPLOYING)
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration MUST be applied before the new application code is deployed.
--
--   * old app + new schema  → SUPPORTED (see mixed-version safety below). The
--     migration can and should land first, ahead of the code rollout.
--   * new app + old schema  → NOT SUPPORTED. The new `deleteGeneration` queries
--     `pending_session_generations`; that table does not exist until this
--     migration runs, so new code running against the old schema fails outright.
--
-- Therefore the safe order is strictly: apply migration 20260926120000, THEN
-- deploy the new app code. Never deploy the new code first, and never roll the
-- schema back while the new code is live.
--
-- Do NOT "fix" a new-app-on-old-schema failure by adding a fallback that lets
-- `deleteGeneration` delete from `pending_sessions` again: that path is the
-- original session_key-only cascade and restores the data-loss defect this
-- change exists to close. The only correct remedy is to apply the migration.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Mixed-version safety (rolling deploy, old app code + new schema)
-- ─────────────────────────────────────────────────────────────────────────────
-- This section covers ONLY the supported window above (old app, new schema);
-- see the ordering contract for why the reverse (new app, old schema) is not.
-- * Old app INSERTing into ingest/admission: the BEFORE INSERT trigger below
--   auto-registers (session_key, session_generation) in the registry first, so
--   the new composite FK is always satisfied regardless of which build wrote
--   the row. No app code needs to know the registry exists to write a ledger
--   row safely.
-- * Old `deleteGeneration` (DELETE FROM pending_sessions WHERE key AND gen):
--   still deletes the one current pending_sessions row and — via the registry's
--   own session_key ON DELETE CASCADE — still wipes every generation for that
--   key. That is the SAME over-broad behaviour the old FK already had, i.e. no
--   regression during the window before the app code ships; the new app code
--   is what narrows it to one generation.
-- * `open_pending_plain_text_generation` (rotation RPC) and the carry-forward
--   re-admission both INSERT ledger rows for freshly-minted or retired
--   generations; the trigger registers each on first write, so neither breaks.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Lock behaviour
-- ─────────────────────────────────────────────────────────────────────────────
--   1. CREATE TABLE pending_session_generations: new table, no lock on any
--      existing table.
--   2. Backfill INSERT ... SELECT ... UNION ... ON CONFLICT DO NOTHING: takes
--      ROW SHARE on the three source tables (readers), ROW EXCLUSIVE on the new
--      table. Does not block concurrent readers or writers.
--   3. DROP CONSTRAINT / ADD CONSTRAINT ... NOT VALID on ingest/admission:
--      briefly takes SHARE ROW EXCLUSIVE on the child table (blocks concurrent
--      writers, not readers) for the metadata change only — no row scan here.
--   4. VALIDATE CONSTRAINT: takes SHARE UPDATE EXCLUSIVE, which does NOT block
--      concurrent INSERT/UPDATE/DELETE, only concurrent DDL. It scans the child
--      table to prove no violation exists.
--   NOTE: steps 3-4 only keep writes unblocked during the scan if VALIDATE runs
--   in a SEPARATE transaction from ADD CONSTRAINT ... NOT VALID. Tooling that
--   wraps the whole file in one transaction holds step 3's SHARE ROW EXCLUSIVE
--   lock until COMMIT, so step 4's scan blocks writers for its duration too. At
--   current ledger scale that scan completes well under a second, so exposure is
--   small either way; stated explicitly rather than assumed away.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotency
-- ─────────────────────────────────────────────────────────────────────────────
-- Every DDL statement is guarded (IF NOT EXISTS / IF EXISTS / catalog check
-- before ADD CONSTRAINT / CREATE OR REPLACE / DROP TRIGGER IF EXISTS then
-- CREATE). Re-applying this file in full is a no-op the second time.
--
-- Disposable test proof:
-- src/lib/line/migration-generation-scoped-ledger.pg.test.ts
-- (guarded by ALLOW_DISPOSABLE_POSTGRES_TESTS=1; CI hard-fails via
-- REQUIRE_GENERATION_LEDGER_POSTGRES=1).

-- Preconditions: the three tables this migration rewires must already exist.
DO $$
BEGIN
  IF to_regclass('public.pending_sessions') IS NULL THEN
    RAISE EXCEPTION '20260926120000: public.pending_sessions is missing';
  END IF;
  IF to_regclass('public.pending_session_ingest') IS NULL THEN
    RAISE EXCEPTION '20260926120000: public.pending_session_ingest is missing';
  END IF;
  IF to_regclass('public.pending_session_admission') IS NULL THEN
    RAISE EXCEPTION '20260926120000: public.pending_session_admission is missing';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Append-only generation registry.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pending_session_generations (
  session_key        text NOT NULL,
  session_generation uuid NOT NULL,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_key, session_generation),
  CONSTRAINT pending_session_generations_session_key_fkey
    FOREIGN KEY (session_key) REFERENCES public.pending_sessions(session_key) ON DELETE CASCADE
);

ALTER TABLE public.pending_session_generations ENABLE ROW LEVEL SECURITY;

-- Explicitly no anon/authenticated grants and no policies: this is internal
-- bookkeeping for server-side (service_role) writers only, matching the
-- default-deny posture already in force on pending_sessions,
-- pending_session_ingest and pending_session_admission.
REVOKE ALL ON public.pending_session_generations FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Backfill every generation that already has ledger evidence or a current
--    pending_sessions row, so the composite FK below creates zero orphans.
--    The still-present session_key-only FK on the ledger tables guarantees
--    every source session_key already exists in pending_sessions, so the
--    registry's own session_key FK cannot be violated by this backfill.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.pending_session_generations (session_key, session_generation)
SELECT session_key, session_generation FROM public.pending_sessions
UNION
SELECT session_key, session_generation FROM public.pending_session_ingest
UNION
SELECT session_key, session_generation FROM public.pending_session_admission
ON CONFLICT (session_key, session_generation) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Auto-register a generation the moment it first writes a ledger row, so no
--    future INSERT can ever create an orphan regardless of which RPC or
--    application build performs it. This is the mixed-version guarantee.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.register_pending_session_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.pending_session_generations (session_key, session_generation)
  VALUES (NEW.session_key, NEW.session_generation)
  ON CONFLICT (session_key, session_generation) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pending_session_ingest_register_generation
  ON public.pending_session_ingest;
CREATE TRIGGER pending_session_ingest_register_generation
  BEFORE INSERT ON public.pending_session_ingest
  FOR EACH ROW EXECUTE FUNCTION public.register_pending_session_generation();

DROP TRIGGER IF EXISTS pending_session_admission_register_generation
  ON public.pending_session_admission;
CREATE TRIGGER pending_session_admission_register_generation
  BEFORE INSERT ON public.pending_session_admission
  FOR EACH ROW EXECUTE FUNCTION public.register_pending_session_generation();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Redirect ownership: drop the session_key-only FK, add a
--    (session_key, session_generation) composite FK against the registry.
--
--    The old FK is dropped by DISCOVERING it from the catalog rather than by a
--    hard-coded name: the production constraint name (auto-generated from the
--    0042-era inline REFERENCES) is not guaranteed to match any single literal,
--    and leaving a second session_key-only FK in place would silently re-open
--    the exact cross-generation cascade this migration closes. We drop every FK
--    on the child table whose referenced parent is pending_sessions and whose
--    only constrained column is session_key.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_child regclass;
  v_conname text;
BEGIN
  FOREACH v_child IN ARRAY ARRAY[
    'public.pending_session_ingest'::regclass,
    'public.pending_session_admission'::regclass
  ]
  LOOP
    FOR v_conname IN
      SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = v_child
        AND con.contype = 'f'
        AND con.confrelid = 'public.pending_sessions'::regclass
        -- exactly one constrained column, and it is session_key
        AND con.conkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = v_child AND attname = 'session_key')
        ]
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_child, v_conname);
    END LOOP;
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_session_ingest_generation_fkey'
      AND conrelid = 'public.pending_session_ingest'::regclass
  ) THEN
    ALTER TABLE public.pending_session_ingest
      ADD CONSTRAINT pending_session_ingest_generation_fkey
      FOREIGN KEY (session_key, session_generation)
      REFERENCES public.pending_session_generations (session_key, session_generation)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE public.pending_session_ingest
  VALIDATE CONSTRAINT pending_session_ingest_generation_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_session_admission_generation_fkey'
      AND conrelid = 'public.pending_session_admission'::regclass
  ) THEN
    ALTER TABLE public.pending_session_admission
      ADD CONSTRAINT pending_session_admission_generation_fkey
      FOREIGN KEY (session_key, session_generation)
      REFERENCES public.pending_session_generations (session_key, session_generation)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE public.pending_session_admission
  VALIDATE CONSTRAINT pending_session_admission_generation_fkey;
