import type { SupabaseClient } from "@supabase/supabase-js";
import type { GuidedJourneyContext } from "@/lib/line/guided-menu/journey";
import { pushLineMessage } from "@/lib/line/reply";
import { logger } from "@/lib/logger";
import {
  checkSettlementArithmetic,
  extractionToJson,
  isFieldConfident,
  isLikelySettlementSheet,
  parseSettlementSheetDate,
} from "@/lib/settlement-ocr/extraction-schema";
import {
  SettlementSheetEvidenceService,
  type SettlementSheetIngestInput,
} from "@/lib/settlement-ocr/evidence-service";
import { CascadingSettlementSheetExtractor } from "@/lib/settlement-ocr/cascade-extractor";
import {
  buildSettlementSheetDraftSummary,
  buildSettlementSheetDuplicateReply,
  SETTLEMENT_SHEET_FAILED_REPLY,
} from "@/lib/settlement-ocr/line-summary";
import { buildSettlementOcrTemplate } from "@/lib/settlement-ocr/template";
import type { SettlementSheetExtractor } from "@/lib/settlement-ocr/types";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;
type DraftRow = Database["public"]["Tables"]["settlement_sheet_drafts"]["Row"];
type PushMessage = (to: string, text: string) => Promise<void>;
type ScheduleBackgroundTask = (task: () => Promise<void>) => void;

const defaultPushMessage: PushMessage = async (to, text) => {
  await pushLineMessage(to, text);
};

const defaultSchedule: ScheduleBackgroundTask = (task) => {
  void task();
};

export interface SettlementSheetImageHandlerDeps {
  evidenceService?: SettlementSheetEvidenceService;
  extractor?: SettlementSheetExtractor;
  pushMessage?: PushMessage;
  scheduleBackgroundTask?: ScheduleBackgroundTask;
}

/**
 * Orchestrates one settlement-sheet photo end to end: ingest (with the
 * idempotency/dedupe rules in evidence-service.ts), background extraction,
 * arithmetic cross-check, and the single LINE reply that IS the draft/review
 * step — see template.ts for why sending that reply back is the entire
 * confirm/correct mechanism. This class never writes settlement_entries.
 */
export class SettlementSheetImageHandler {
  private readonly evidenceService: SettlementSheetEvidenceService;
  private readonly extractor: SettlementSheetExtractor;
  private readonly pushMessage: PushMessage;
  private readonly scheduleBackgroundTask: ScheduleBackgroundTask;

  constructor(
    private readonly supabase: Supabase,
    deps: SettlementSheetImageHandlerDeps = {},
  ) {
    this.evidenceService = deps.evidenceService ?? new SettlementSheetEvidenceService(supabase);
    this.extractor = deps.extractor ?? new CascadingSettlementSheetExtractor();
    this.pushMessage = deps.pushMessage ?? defaultPushMessage;
    this.scheduleBackgroundTask = deps.scheduleBackgroundTask ?? defaultSchedule;
  }

  async handleImage(input: SettlementSheetIngestInput): Promise<void> {
    const log = logger.child({ sourceId: input.sourceId, lineMessageId: input.lineMessageId });
    const result = await this.evidenceService.ingest(input);

    switch (result.kind) {
      case "already_ingested":
        // LINE webhook redelivery of a message we already processed (or are
        // still processing) — nothing new to ingest or announce.
        log.info("settlement sheet image already ingested — skipping");
        return;
      case "failed":
        await this.pushSafe(input.sourceId, SETTLEMENT_SHEET_FAILED_REPLY, log);
        return;
      case "duplicate_image":
        await this.pushSafe(
          input.sourceId,
          buildSettlementSheetDuplicateReply(result.draft.template_text),
          log,
        );
        return;
      case "new":
        this.scheduleBackgroundTask(() => this.processDraft(result.draft.id, input.context));
        return;
    }
  }

  async processDraft(draftId: string, context: GuidedJourneyContext): Promise<void> {
    const log = logger.child({ draftId });

    let draft: DraftRow;
    try {
      draft = await this.loadDraft(draftId);
    } catch (error) {
      log.error("settlement sheet draft load failed", { error: safeMessage(error) });
      return;
    }

    // The background task carries the guided identity resolved when the image
    // arrived. Re-check every ownership binding before reading or updating the
    // draft so a rotated/replayed round cannot process under another member's
    // context.
    if (
      draft.source_id !== context.sourceId
      || draft.line_user_id !== context.lineUserId
      || draft.business_date !== context.businessDate
      || draft.accountability_round_id !== (context.accountabilityRoundId ?? null)
    ) {
      log.warn("settlement sheet draft ownership mismatch", {
        draftSourceId: draft.source_id,
        contextSourceId: context.sourceId,
        draftLineUserId: draft.line_user_id,
        contextLineUserId: context.lineUserId,
      });
      return;
    }

    try {
      const bytes = await this.downloadEvidence(draft.storage_bucket, draft.storage_path);
      const extraction = await this.extractor.extract({
        bytes,
        mimeType: draft.mime_type ?? "image/jpeg",
      });

      if (!isLikelySettlementSheet(extraction)) {
        // Conservative non-hijack: not confidently a settlement sheet — record
        // the classification for forensics, but send NO reply. Same silent
        // behavior as an ordinary photo outside any recognized flow.
        await this.updateDraft(draftId, {
          status: "NOT_SETTLEMENT_SHEET",
          extracted_json: extractionToJson(extraction),
          confidence: extraction.documentTypeConfidence,
        });
        log.info("image not a settlement sheet — ignored silently", {
          documentTypeConfidence: extraction.documentTypeConfidence,
        });
        return;
      }

      const ocrDate = parseSettlementSheetDate(extraction.dateText);
      const dateMismatch = ocrDate !== null && ocrDate !== context.businessDate;

      const arithmetic = checkSettlementArithmetic({
        salesTotal: extraction.salesTotal.value,
        transferAmount: extraction.transferAmount.value,
        cashSubmitted: extraction.cashSubmitted.value,
        expensesTotal: extraction.expensesTotal.value,
        laborTotal: extraction.laborTotal.value,
        cashRemaining: extraction.cashRemaining.value,
      });

      // cash_submitted stays required here as evidence/cross-check input to
      // checkSettlementArithmetic's ledgerOk/cashOk — it is NEVER what feeds
      // the template below. money_cash = cash_remaining (see extraction-schema.ts).
      const requiredFields = [
        extraction.salesTotal,
        extraction.transferAmount,
        extraction.cashSubmitted,
        extraction.expensesTotal,
        extraction.laborTotal,
        extraction.cashRemaining,
      ];
      const missingRequired = requiredFields.some((field) => field.value === null);
      const lowConfidence = requiredFields.some((field) => !isFieldConfident(field));
      const needsReview = missingRequired || lowConfidence || arithmetic.ok !== true || dateMismatch;

      const templateText = buildSettlementOcrTemplate(context, {
        moneyTransfer: extraction.transferAmount.value ?? 0,
        moneyCash: extraction.cashRemaining.value ?? 0,
        expenses: extraction.expensesTotal.value ?? 0,
        labor: extraction.laborTotal.value ?? 0,
      });

      const overallConfidence = Math.min(...requiredFields.map((field) => field.confidence));

      await this.updateDraft(draftId, {
        status: needsReview ? "NEEDS_REVIEW" : "READY",
        transfer_amount: extraction.transferAmount.value,
        cash_submitted: extraction.cashSubmitted.value,
        expenses_total: extraction.expensesTotal.value,
        labor_total: extraction.laborTotal.value,
        sales_total: extraction.salesTotal.value,
        cash_remaining: extraction.cashRemaining.value,
        arithmetic_expected_sales: arithmetic.expectedSales,
        arithmetic_difference: arithmetic.difference,
        arithmetic_ok: arithmetic.ok,
        confidence: Number.isFinite(overallConfidence) ? overallConfidence : 0,
        extracted_json: extractionToJson(extraction),
        template_text: templateText,
        extraction_provider: extraction.extractionProvider ?? null,
        extraction_model: extraction.extractionModel ?? null,
        extraction_pass: extraction.extractionPass ?? null,
      });

      const summary = buildSettlementSheetDraftSummary({
        extraction,
        arithmetic,
        templateText,
        dateMismatch,
      });
      await this.pushSafe(context.sourceId, summary, log);
    } catch (error) {
      log.error("settlement sheet extraction failed", { error: safeMessage(error) });
      await this.updateDraft(draftId, {
        status: "FAILED",
        failure_reason: safeMessage(error).slice(0, 500),
      });
      await this.pushSafe(context.sourceId, SETTLEMENT_SHEET_FAILED_REPLY, log);
    }
  }

  private async loadDraft(draftId: string): Promise<DraftRow> {
    const { data, error } = await this.supabase
      .from("settlement_sheet_drafts")
      .select("*")
      .eq("id", draftId)
      .single();
    if (error || !data) throw new Error("Settlement sheet draft could not be loaded");
    return data;
  }

  private async downloadEvidence(bucket: string, path: string): Promise<Uint8Array> {
    const { data, error } = await this.supabase.storage.from(bucket).download(path);
    if (error || !data) throw new Error("Private settlement sheet evidence could not be downloaded");
    return new Uint8Array(await data.arrayBuffer());
  }

  private async updateDraft(
    draftId: string,
    patch: Database["public"]["Tables"]["settlement_sheet_drafts"]["Update"],
  ): Promise<void> {
    const { error } = await this.supabase
      .from("settlement_sheet_drafts")
      .update(patch)
      .eq("id", draftId);
    if (error) {
      logger.error("settlement sheet draft update failed", { draftId, error: error.message });
    }
  }

  private async pushSafe(
    sourceId: string,
    text: string,
    log: ReturnType<typeof logger.child>,
  ): Promise<void> {
    try {
      await this.pushMessage(sourceId, text);
    } catch {
      log.error("settlement sheet draft push failed");
    }
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
