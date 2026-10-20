import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { downloadLineMessageContent, type LineMessageContent } from "@/lib/line/content";
import { logger } from "@/lib/logger";
import { SLIP_INGEST_POLICY } from "@/lib/slips/ingest-policy";
import { IoTimeoutError, withTimeout } from "@/lib/slips/io-timeout";
import { computeSlipVisualHashes } from "@/lib/slips/visual-hash";
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
/**
 * `ctx.signal` aborts at the timeout; a provider that ignores it is still cut
 * off by withTimeout, so the bound never depends on the provider's behaviour.
 */
export type DownloadContent = (
  messageId: string,
  ctx?: { signal: AbortSignal; timeoutMs: number },
) => Promise<LineMessageContent>;

const defaultDownload: DownloadContent = (messageId, ctx) =>
  downloadLineMessageContent(messageId, undefined, {
    timeoutMs: ctx?.timeoutMs,
    signal: ctx?.signal,
  });

export interface SlipEvidenceTimeouts {
  downloadMs: number;
  uploadMs: number;
}

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

type VisualHashColumns = { visual_hash_full?: string | null; visual_hash_center?: string | null };

/** Postgres 42703 / PostgREST PGRST204 naming a visual_hash column, nothing broader. */
export function isVisualHashColumnMissing(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error || (error.code !== "42703" && error.code !== "PGRST204")) return false;
  return (error.message ?? "").includes("visual_hash_");
}

export function computeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class SlipEvidenceService implements SlipEvidenceIngestor {
  constructor(
    private readonly supabase: Supabase,
    private readonly downloadContent: DownloadContent = defaultDownload,
    private readonly timeouts: SlipEvidenceTimeouts = {
      downloadMs: SLIP_INGEST_POLICY.io.lineDownloadTimeoutMs,
      uploadMs: SLIP_INGEST_POLICY.io.storageUploadTimeoutMs,
    },
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
      content = await withTimeout("line_download", this.timeouts.downloadMs, (signal) =>
        this.downloadContent(input.lineMessageId, { signal, timeoutMs: this.timeouts.downloadMs }),
      );
    } catch (error) {
      log.error("slip evidence download failed", {
        error: safeErrorMessage(error),
        timedOut: error instanceof IoTimeoutError,
      });
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
    const visualHashes = await computeSlipVisualHashes(content.bytes);
    if (!visualHashes) log.warn("slip visual fingerprint unavailable", { reason: "image_decode_failed" });
    // A hung upload is cut off at the timeout and recorded as STORAGE_FAILED.
    // If it completes later it writes the same bytes to the same
    // message-id-derived path (upsert) and nothing else: the evidence row and
    // the ledger attach are only ever written by the attempt that is awaiting
    // here, and attach is fenced by the attempt token. An orphan is harmless.
    let storageError: { message: string } | null;
    try {
      ({ error: storageError } = await withTimeout("storage_upload", this.timeouts.uploadMs, () =>
        this.supabase.storage
          .from(SLIP_EVIDENCE_BUCKET)
          .upload(storagePath, content.bytes, {
            contentType: content.mimeType ?? "image/jpeg",
            // The path is derived from the LINE message id, so a retry after a
            // crash between upload and DB insert rewrites identical bytes.
            upsert: true,
          }),
      ));
    } catch (error) {
      storageError = { message: safeErrorMessage(error) };
    }

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
      visualHashFull: visualHashes?.full ?? null,
      visualHashCenter: visualHashes?.center ?? null,
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
      visualHashFull?: string | null;
      visualHashCenter?: string | null;
      status: SlipEvidenceStatus;
    },
  ): Promise<{ id: string; status: SlipEvidenceStatus }> {
    const visual: VisualHashColumns = evidence.visualHashFull || evidence.visualHashCenter
      ? { visual_hash_full: evidence.visualHashFull ?? null, visual_hash_center: evidence.visualHashCenter ?? null }
      : {};
    // Fingerprints are optional (20261019143000). A schema without those
    // columns must still record the image: never lose a slip over a hash.
    const writeWithVisual = async <T extends { error: { code?: string; message?: string } | null }>(
      write: (columns: VisualHashColumns) => PromiseLike<T>,
    ): Promise<T> => {
      const result = await write(visual);
      if (!isVisualHashColumnMissing(result.error) || Object.keys(visual).length === 0) return result;
      logger.warn("slip visual fingerprint not stored: schema lacks visual_hash columns", {
        lineMessageId: input.lineMessageId,
      });
      return write({});
    };

    const { data, error } = await writeWithVisual((columns) => this.supabase
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
        ...columns,
        status: evidence.status,
      })
      .select("id")
      .single());

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
        // A retry after STORAGE_FAILED must carry the fingerprint too, or the
        // recovered image would be invisible to near-duplicate review.
        const { error: updateError } = await writeWithVisual((columns) => this.supabase
          .from("slip_evidences")
          .update({
            storage_path: evidence.storagePath,
            mime_type: evidence.mimeType,
            byte_size: evidence.byteSize,
            sha256: evidence.sha256,
            ...columns,
            status: evidence.status,
          })
          .eq("id", existing.id));
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
