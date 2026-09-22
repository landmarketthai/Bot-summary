-- Settlement-sheet OCR MVP: handwritten daily market settlement-sheet photos
-- sent over LINE instead of the typed "ส่งยอด" guided command.
--
-- This is a DRAFT/REVIEW staging table only — it never writes
-- settlement_entries itself. The confirmed write still goes exclusively
-- through the existing submitSettlementEntryForSource() contract (via the
-- pre-filled guided template + the existing guided-marker ownership check),
-- so this migration adds no new write path for financial rows and no new
-- authoritative formula. See src/lib/settlement-ocr/*.
--
-- Additive-only: new bucket, new table, no changes to any existing table.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'settlement-sheet-evidence',
  'settlement-sheet-evidence',
  false,
  52428800,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.settlement_sheet_drafts (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_message_id           uuid        NOT NULL REFERENCES public.raw_messages(id) ON DELETE CASCADE,
  line_message_id          text        NOT NULL UNIQUE,
  source_id                text        NOT NULL,
  source_type              text        NOT NULL,
  -- Required (NOT NULL): a draft only ever gets created for an identified
  -- guided-round owner (see gate.ts) — unlike slip_evidences, this pipeline
  -- never runs for an anonymous/unidentifiable sender.
  line_user_id             text        NOT NULL,
  storage_bucket           text        NOT NULL DEFAULT 'settlement-sheet-evidence',
  storage_path             text        NOT NULL,
  mime_type                text,
  byte_size                integer,
  sha256                   text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'PROCESSING',
  -- Set when this row was recognized as a repeat/forwarded submission of an
  -- already-processed image (same source_id + sha256). OCR is skipped for
  -- these rows; the reply points back at the original draft's template so a
  -- replay can never prompt a second, independent confirmation.
  duplicate_of_draft_id    uuid        REFERENCES public.settlement_sheet_drafts(id),
  accountability_round_id  uuid        REFERENCES public.accountability_rounds(id),
  -- Identity fields come from the already-open guided round context, NOT
  -- from OCR — see src/lib/settlement-ocr/gate.ts. OCR-read market/date/staff
  -- text is kept in extracted_json only, as a non-authoritative cross-check.
  market_label             text,
  market_label_normalized  text,
  business_date            date,
  staff_label              text,
  transfer_amount          numeric(12,2),
  cash_submitted           numeric(12,2),
  expenses_total           numeric(12,2),
  labor_total              numeric(12,2),
  -- Informational only — neither column exists on settlement_entries, so
  -- neither is ever written past this draft. See draft-service.ts.
  sales_total               numeric(12,2),
  cash_remaining             numeric(12,2),
  arithmetic_expected_sales numeric(12,2),
  arithmetic_difference     numeric(12,2),
  arithmetic_ok              boolean,
  confidence                numeric(4,3),
  extracted_json             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  template_text              text,
  failure_reason              text,
  -- Model-orchestration provenance (cascade-extractor.ts). Additive/nullable:
  -- a row from before this feature, or one where the extractor threw before
  -- tagging its result, simply has all three null.
  extraction_provider        text,
  extraction_model           text,
  extraction_pass            text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT settlement_sheet_drafts_status_check
    CHECK (status IN (
      'PROCESSING', 'READY', 'NEEDS_REVIEW',
      'NOT_SETTLEMENT_SHEET', 'DUPLICATE_IMAGE', 'FAILED'
    )),
  CONSTRAINT settlement_sheet_drafts_sha256_check
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT settlement_sheet_drafts_download_hash_check
    CHECK (
      (status = 'FAILED' AND failure_reason = 'download_failed')
      OR sha256 <> repeat('0', 64)
    ),
  CONSTRAINT settlement_sheet_drafts_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT settlement_sheet_drafts_extraction_pass_check
    CHECK (extraction_pass IS NULL OR extraction_pass IN ('primary', 'fallback')),
  CONSTRAINT settlement_sheet_drafts_money_nonneg_check
    CHECK (
      (transfer_amount IS NULL OR transfer_amount >= 0)
      AND (cash_submitted IS NULL OR cash_submitted >= 0)
      AND (expenses_total IS NULL OR expenses_total >= 0)
      AND (labor_total IS NULL OR labor_total >= 0)
      AND (sales_total IS NULL OR sales_total >= 0)
      AND (cash_remaining IS NULL OR cash_remaining >= 0)
    )
);

CREATE INDEX IF NOT EXISTS settlement_sheet_drafts_raw_message_idx
  ON public.settlement_sheet_drafts (raw_message_id);

CREATE INDEX IF NOT EXISTS settlement_sheet_drafts_source_created_idx
  ON public.settlement_sheet_drafts (source_id, created_at DESC);

-- Backs the content-dedupe lookup (same source, same image bytes).
CREATE INDEX IF NOT EXISTS settlement_sheet_drafts_source_sha256_idx
  ON public.settlement_sheet_drafts (source_id, sha256);

-- The content-dedupe lookup is also a race boundary. Only one live original
-- may claim a source+hash; duplicate rows remain auditable because their
-- DUPLICATE_IMAGE status is outside this partial index.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_sheet_drafts_live_source_sha256_key
  ON public.settlement_sheet_drafts (source_id, sha256)
  WHERE sha256 <> repeat('0', 64)
    AND status IN ('PROCESSING', 'READY', 'NEEDS_REVIEW', 'NOT_SETTLEMENT_SHEET');

CREATE INDEX IF NOT EXISTS settlement_sheet_drafts_owner_idx
  ON public.settlement_sheet_drafts (source_id, line_user_id, created_at DESC);

ALTER TABLE public.settlement_sheet_drafts ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies — service-role only, same as slip_evidences.
REVOKE ALL ON TABLE public.settlement_sheet_drafts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.settlement_sheet_drafts TO service_role;

CREATE OR REPLACE FUNCTION public.set_settlement_sheet_draft_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.settlement_sheet_drafts'::regclass
      AND tgname = 'trg_settlement_sheet_drafts_updated_at'
  ) THEN
    CREATE TRIGGER trg_settlement_sheet_drafts_updated_at
      BEFORE UPDATE ON public.settlement_sheet_drafts
      FOR EACH ROW EXECUTE FUNCTION public.set_settlement_sheet_draft_updated_at();
  END IF;
END;
$$;
