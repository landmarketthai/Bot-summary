import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const root = join(import.meta.dir, "..", "..", "..", "supabase", "migrations");

describe("settlement-sheet OCR migration guards", () => {
  it("keeps settlement drafts private and content-dedupe race-safe", () => {
    const sql = readFileSync(
      join(root, "20260922100000_settlement_sheet_ocr_drafts.sql"),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.settlement_sheet_drafts");
    expect(sql).toContain("ALTER TABLE public.settlement_sheet_drafts ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON TABLE public.settlement_sheet_drafts FROM PUBLIC, anon, authenticated");
    expect(sql).toContain("settlement_sheet_drafts_live_source_sha256_key");
    expect(sql).toContain(
      "status IN ('PROCESSING', 'READY', 'NEEDS_REVIEW', 'NOT_SETTLEMENT_SHEET')",
    );
    expect(sql).toContain("raw_message_id           uuid        NOT NULL REFERENCES public.raw_messages(id)");
  });

  it("restricts quoted-slip corrections to the service role and audit table", () => {
    const sql = readFileSync(
      join(root, "20260922103000_slip_quoted_amount_correction.sql"),
      "utf8",
    );
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("SET search_path = public");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.apply_slip_amount_correction");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.apply_slip_amount_correction");
    expect(sql).toContain("source_id = p_source_id");
    expect(sql).toContain("user_id = p_line_user_id");
    expect(sql).toContain("v_current.payload #>> '{message,quotedMessageId}'");
    expect(sql).toContain("message_id = p_quoted_message_id");
    expect(sql).toContain("message_type = 'image'::public.line_message_type");
    expect(sql).toContain("correction_raw_message_id uuid NOT NULL UNIQUE");
    expect(sql).toContain("slip_check_amount_corrections");
  });
});
