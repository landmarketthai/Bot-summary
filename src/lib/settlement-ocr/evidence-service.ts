import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { downloadLineMessageContent, type LineMessageContent } from "@/lib/line/content";
import type { GuidedJourneyContext } from "@/lib/line/guided-menu/journey";
import { logger } from "@/lib/logger";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;
type DraftRow = Database["public"]["Tables"]["settlement_sheet_drafts"]["Row"];
type DownloadContent = (messageId: string) => Promise<LineMessageContent>;

export const SETTLEMENT_SHEET_BUCKET = "settlement-sheet-evidence";
/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

export function computeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized || "unknown";
}

export function buildSettlementSheetEvidencePath(input: {
  businessDate: string;
  sourceId: string;
  lineMessageId: string;
}): string {
  return [
    "settlement-sheets",
    input.businessDate,
    safePathSegment(input.sourceId),
    `${safePathSegment(input.lineMessageId)}.jpg`,
  ].join("/");
}

export interface SettlementSheetIngestInput {
  rawMessageId: string;
  lineMessageId: string;
  sourceId: string;
  sourceType: string;
  lineUserId: string;
  /** Already-resolved guided-round context — see gate.ts. Never OCR-derived. */
  context: GuidedJourneyContext;
}

export type SettlementSheetIngestResult =
  /** LINE webhook redelivered the same message — no new row, no new OCR. */
  | { kind: "already_ingested"; draft: DraftRow }
  /** New row, but byte-identical to an earlier draft for this source+date. */
  | { kind: "duplicate_image"; draft: DraftRow; original: DraftRow }
  /** New row, unique content — ready for extraction. */
  | { kind: "new"; draft: DraftRow }
  /** Download/storage failure — a FAILED row was still recorded for forensics. */
  | { kind: "failed"; draft: DraftRow | null; reason: string };

export class SettlementSheetEvidenceService {
  constructor(
    private readonly supabase: Supabase,
    private readonly downloadContent: DownloadContent = downloadLineMessageContent,
  ) {}

  async ingest(input: SettlementSheetIngestInput): Promise<SettlementSheetIngestResult> {
    const log = logger.child({
      rawMessageId: input.rawMessageId,
      lineMessageId: input.lineMessageId,
      sourceId: input.sourceId,
    });

    const storagePath = buildSettlementSheetEvidencePath({
      businessDate: input.context.businessDate,
      sourceId: input.sourceId,
      lineMessageId: input.lineMessageId,
    });

    let content: LineMessageContent;
    try {
      content = await this.downloadContent(input.lineMessageId);
    } catch (error) {
      log.error("settlement sheet evidence download failed", { error: safeErrorMessage(error) });
      const draft = await this.insertOrFindExisting(input, {
        storagePath,
        mimeType: null,
        byteSize: 0,
        sha256: "0".repeat(64),
        status: "FAILED",
        failureReason: "download_failed",
      });
      if (draft.kind === "already_ingested") return draft;
      return { kind: "failed", draft: draft.draft, reason: "download_failed" };
    }

    const sha256 = computeSha256(content.bytes);

    const { error: storageError } = await this.supabase.storage
      .from(SETTLEMENT_SHEET_BUCKET)
      .upload(storagePath, content.bytes, {
        contentType: content.mimeType ?? "image/jpeg",
        upsert: false,
      });

    if (storageError) {
      log.error("settlement sheet evidence storage failed", { error: storageError.message });
      const draft = await this.insertOrFindExisting(input, {
        storagePath,
        mimeType: content.mimeType,
        byteSize: content.bytes.byteLength,
        sha256,
        status: "FAILED",
        failureReason: "storage_failed",
      });
      if (draft.kind === "already_ingested") return draft;
      return { kind: "failed", draft: draft.draft, reason: "storage_failed" };
    }

    const inserted = await this.insertOrFindExisting(input, {
      storagePath,
      mimeType: content.mimeType,
      byteSize: content.bytes.byteLength,
      sha256,
      status: "PROCESSING",
      failureReason: null,
    });
    if (inserted.kind === "already_ingested") return inserted;

    const { error: processedError } = await this.supabase
      .from("raw_messages")
      .update({ is_processed: true })
      .eq("id", input.rawMessageId);
    if (processedError) {
      log.warn("settlement sheet evidence saved but raw message was not marked processed", {
        error: processedError.message,
      });
    }
    if (inserted.kind === "duplicate_image") return inserted;

    // Content dedupe: same source, byte-identical image
    // already ingested under a DIFFERENT line_message_id (a forward/repost).
    // Scoped to non-FAILED, non-self rows so a failed download never blocks
    // a genuine retry from being treated as new.
    const { data: original, error: dedupeError } = await this.supabase
      .from("settlement_sheet_drafts")
      .select("*")
      .eq("source_id", input.sourceId)
      .eq("sha256", sha256)
      .neq("id", inserted.draft.id)
      .neq("status", "FAILED")
      .neq("status", "DUPLICATE_IMAGE")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (dedupeError) {
      log.error("settlement sheet duplicate-content lookup failed", { error: dedupeError.message });
      return { kind: "new", draft: inserted.draft };
    }
    if (original) {
      const { data: updated, error: updateError } = await this.supabase
        .from("settlement_sheet_drafts")
        .update({
          status: "DUPLICATE_IMAGE",
          duplicate_of_draft_id: original.id,
          template_text: original.template_text,
        })
        .eq("id", inserted.draft.id)
        .select()
        .single();
      if (updateError || !updated) {
        log.error("settlement sheet duplicate-content flag failed", {
          error: updateError?.message ?? "missing row",
        });
        return { kind: "new", draft: inserted.draft };
      }
      log.info("settlement sheet duplicate image detected", { originalDraftId: original.id });
      return { kind: "duplicate_image", draft: updated, original };
    }

    return { kind: "new", draft: inserted.draft };
  }

  /**
   * Insert-first, catch-23505 race-safe pattern (same as
   * SlipSessionService.openSession): a LINE webhook redelivery races nothing
   * else, but the UNIQUE constraint on line_message_id is the actual
   * idempotency guarantee — this only decides what to return when it fires.
   */
  private async insertOrFindExisting(
    input: SettlementSheetIngestInput,
    evidence: {
      storagePath: string;
      mimeType: string | null;
      byteSize: number;
      sha256: string;
      status: "PROCESSING" | "FAILED" | "DUPLICATE_IMAGE";
      failureReason: string | null;
    },
  ): Promise<
    | { kind: "new"; draft: DraftRow }
    | { kind: "already_ingested"; draft: DraftRow }
    | { kind: "duplicate_image"; draft: DraftRow; original: DraftRow }
  > {
    const { data, error } = await this.supabase
      .from("settlement_sheet_drafts")
      .insert({
        raw_message_id: input.rawMessageId,
        line_message_id: input.lineMessageId,
        source_id: input.sourceId,
        source_type: input.sourceType,
        line_user_id: input.lineUserId,
        storage_bucket: SETTLEMENT_SHEET_BUCKET,
        storage_path: evidence.storagePath,
        mime_type: evidence.mimeType,
        byte_size: evidence.byteSize,
        sha256: evidence.sha256,
        status: evidence.status,
        failure_reason: evidence.failureReason,
        accountability_round_id: input.context.accountabilityRoundId ?? null,
        market_label: input.context.marketLabel,
        market_label_normalized: input.context.marketLabelNormalized,
        business_date: input.context.businessDate,
        staff_label: input.context.sellerLabel,
      })
      .select()
      .single();

    if (!error && data) return { kind: "new", draft: data };

    if (error?.code === UNIQUE_VIOLATION) {
      const { data: existing, error: lookupError } = await this.supabase
        .from("settlement_sheet_drafts")
        .select("*")
        .eq("line_message_id", input.lineMessageId)
        .single();
      if (!lookupError && existing) return { kind: "already_ingested", draft: existing };

      // The partial source+hash unique index protects the content-dedupe
      // decision when two forwarded images arrive concurrently. Keep the
      // losing raw message as an explicit duplicate row instead of treating
      // the race as a failed ingest.
      if (evidence.status === "PROCESSING" && evidence.sha256 !== "0".repeat(64)) {
        const { data: original, error: originalError } = await this.supabase
          .from("settlement_sheet_drafts")
          .select("*")
          .eq("source_id", input.sourceId)
          .eq("sha256", evidence.sha256)
          .neq("status", "FAILED")
          .neq("status", "DUPLICATE_IMAGE")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (!originalError && original) {
          const { data: duplicate, error: duplicateError } = await this.supabase
            .from("settlement_sheet_drafts")
            .insert({
              raw_message_id: input.rawMessageId,
              line_message_id: input.lineMessageId,
              source_id: input.sourceId,
              source_type: input.sourceType,
              line_user_id: input.lineUserId,
              storage_bucket: SETTLEMENT_SHEET_BUCKET,
              storage_path: evidence.storagePath,
              mime_type: evidence.mimeType,
              byte_size: evidence.byteSize,
              sha256: evidence.sha256,
              status: "DUPLICATE_IMAGE",
              duplicate_of_draft_id: original.id,
              template_text: original.template_text,
              failure_reason: null,
              accountability_round_id: input.context.accountabilityRoundId ?? null,
              market_label: input.context.marketLabel,
              market_label_normalized: input.context.marketLabelNormalized,
              business_date: input.context.businessDate,
              staff_label: input.context.sellerLabel,
            })
            .select()
            .single();
          if (!duplicateError && duplicate) {
            return { kind: "duplicate_image", draft: duplicate, original };
          }
        }
      }
    }

    throw new Error(`settlement_sheet_drafts insert failed: ${error?.message ?? "missing inserted row"}`);
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
