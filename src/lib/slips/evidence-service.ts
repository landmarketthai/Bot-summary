import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { downloadLineMessageContent, type LineMessageContent } from "@/lib/line/content";
import { logger } from "@/lib/logger";
import {
  DOWNLOAD_FAILED_SHA256,
  SLIP_EVIDENCE_BUCKET,
  type SlipEvidenceIngestor,
  type SlipEvidenceInput,
  type SlipEvidenceResult,
  type SlipEvidenceStatus,
} from "@/lib/slips/types";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;
type DownloadContent = (messageId: string) => Promise<LineMessageContent>;

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized || "unknown";
}

export function buildSlipEvidencePath(input: {
  businessDate: string;
  sourceId: string;
  lineMessageId: string;
}): string {
  return [
    "slips",
    input.businessDate,
    safePathSegment(input.sourceId),
    `${safePathSegment(input.lineMessageId)}.jpg`,
  ].join("/");
}

export function computeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class SlipEvidenceService implements SlipEvidenceIngestor {
  constructor(
    private readonly supabase: Supabase,
    private readonly downloadContent: DownloadContent = downloadLineMessageContent,
  ) {}

  async ingest(input: SlipEvidenceInput): Promise<SlipEvidenceResult> {
    const businessDate =
      bangkokBusinessDateFromTimestamp(input.eventTimestamp)
      ?? new Date(input.eventTimestamp).toISOString().slice(0, 10);
    const storagePath = buildSlipEvidencePath({
      businessDate,
      sourceId: input.sourceId,
      lineMessageId: input.lineMessageId,
    });
    const log = logger.child({
      rawMessageId: input.rawMessageId,
      lineMessageId: input.lineMessageId,
      sourceType: input.sourceType,
    });

    let content: LineMessageContent;
    try {
      content = await this.downloadContent(input.lineMessageId);
    } catch (error) {
      log.error("slip evidence download failed", { error: safeErrorMessage(error) });
      const recorded = await this.insertEvidence(input, {
        storagePath,
        mimeType: null,
        byteSize: 0,
        sha256: DOWNLOAD_FAILED_SHA256,
        status: "DOWNLOAD_FAILED",
      });
      return {
        evidenceId: recorded.id,
        status: recorded.status,
        storagePath,
        sha256: DOWNLOAD_FAILED_SHA256,
      };
    }

    const sha256 = computeSha256(content.bytes);
    const { error: storageError } = await this.supabase.storage
      .from(SLIP_EVIDENCE_BUCKET)
      .upload(storagePath, content.bytes, {
        contentType: content.mimeType ?? "image/jpeg",
        // The path is derived from the LINE message id, so a retry after a
        // crash between upload and DB insert rewrites identical bytes.
        upsert: true,
      });

    if (storageError) {
      log.error("slip evidence storage failed", {
        error: storageError.message,
        byteSize: content.bytes.byteLength,
      });
      const recorded = await this.insertEvidence(input, {
        storagePath,
        mimeType: content.mimeType,
        byteSize: content.bytes.byteLength,
        sha256,
        status: "STORAGE_FAILED",
      });
      return { evidenceId: recorded.id, status: recorded.status, storagePath, sha256 };
    }

    const recorded = await this.insertEvidence(input, {
      storagePath,
      mimeType: content.mimeType,
      byteSize: content.bytes.byteLength,
      sha256,
      status: "RECEIVED",
    });
    const evidenceId = recorded.id;

    const { error: processedError } = await this.supabase
      .from("raw_messages")
      .update({ is_processed: true })
      .eq("id", input.rawMessageId);

    if (processedError) {
      log.warn("slip evidence saved but raw message was not marked processed", {
        error: processedError.message,
      });
    }

    log.info("slip evidence received", {
      byteSize: content.bytes.byteLength,
      mimeType: content.mimeType,
    });

    return { evidenceId, status: recorded.status, storagePath, sha256 };
  }

  /**
   * Records the evidence row. line_message_id is UNIQUE, so a retry of the same
   * LINE message must reconcile with the existing row instead of failing:
   *   - existing RECEIVED  -> keep it (never downgrade a stored image)
   *   - existing *_FAILED  -> overwrite with this attempt's outcome
   */
  private async insertEvidence(
    input: SlipEvidenceInput,
    evidence: {
      storagePath: string;
      mimeType: string | null;
      byteSize: number;
      sha256: string;
      status: SlipEvidenceStatus;
    },
  ): Promise<{ id: string; status: SlipEvidenceStatus }> {
    const { data, error } = await this.supabase
      .from("slip_evidences")
      .insert({
        raw_message_id: input.rawMessageId,
        line_message_id: input.lineMessageId,
        source_id: input.sourceId,
        source_type: input.sourceType,
        line_user_id: input.lineUserId,
        storage_bucket: SLIP_EVIDENCE_BUCKET,
        storage_path: evidence.storagePath,
        mime_type: evidence.mimeType,
        byte_size: evidence.byteSize,
        sha256: evidence.sha256,
        status: evidence.status,
      })
      .select("id")
      .single();

    if (!error && data) return { id: data.id, status: evidence.status };

    if (error?.code === "23505") {
      const { data: existing } = await this.supabase
        .from("slip_evidences")
        .select("id, status")
        .eq("line_message_id", input.lineMessageId)
        .maybeSingle();
      if (existing) {
        if (existing.status === "RECEIVED") {
          return { id: existing.id, status: "RECEIVED" };
        }
        const { error: updateError } = await this.supabase
          .from("slip_evidences")
          .update({
            storage_path: evidence.storagePath,
            mime_type: evidence.mimeType,
            byte_size: evidence.byteSize,
            sha256: evidence.sha256,
            status: evidence.status,
          })
          .eq("id", existing.id);
        if (!updateError) return { id: existing.id, status: evidence.status };
        throw new Error(`slip_evidence update failed: ${updateError.message}`);
      }
    }

    throw new Error(`slip_evidence insert failed: ${error?.message ?? "missing inserted row"}`);
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
