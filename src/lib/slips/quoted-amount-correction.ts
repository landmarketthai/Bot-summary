import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { parseManualSlipAmounts } from "@/lib/parsers/manual-slip-amount";
import { parseTypedAmountText } from "@/lib/settlement-ocr/text-evidence";
import type { Database } from "@/types/database";

type Supabase = SupabaseClient<Database>;

export interface QuotedSlipAmountCorrectionInput {
  rawMessageId: string;
  lineMessageId: string;
  quotedMessageId: string;
  sourceId: string;
  sourceType: string;
  lineUserId: string | null;
  text: string;
}

export type QuotedSlipAmountCorrectionResult = {
  handled: boolean;
  kind: "applied" | "already_applied" | "ignored" | "failed";
  amount?: number;
  reason?: string;
};

export function parseQuotedSlipAmount(text: string): number | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;

  const manualAmounts = parseManualSlipAmounts(text);
  if (manualAmounts.length === 1) return manualAmounts[0]!.amount;
  return parseTypedAmountText(text);
}

/**
 * Links a single amount message to exactly the image it quotes. The database
 * RPC owns the source/sender/evidence checks and the atomic audit+update; this
 * adapter only recognizes the existing amount grammar and keeps non-matching
 * text on the normal webhook path.
 */
export class QuotedSlipAmountCorrectionService {
  constructor(private readonly supabase: Supabase) {}

  async handle(
    input: QuotedSlipAmountCorrectionInput,
  ): Promise<QuotedSlipAmountCorrectionResult> {
    const amount = parseQuotedSlipAmount(input.text);
    if (amount === null || !input.quotedMessageId.trim()) {
      return { handled: false, kind: "ignored", reason: "not_a_single_amount" };
    }

    if (!input.lineUserId) {
      return { handled: true, kind: "ignored", reason: "missing_sender_identity" };
    }

    const { data, error } = await this.supabase.rpc("apply_slip_amount_correction", {
      p_raw_message_id: input.rawMessageId,
      p_line_message_id: input.lineMessageId,
      p_quoted_message_id: input.quotedMessageId,
      p_source_id: input.sourceId,
      p_source_type: input.sourceType,
      p_line_user_id: input.lineUserId,
      p_amount: amount,
    });

    if (error) {
      logger.warn("quoted slip amount correction refused", {
        sourceId: input.sourceId,
        lineMessageId: input.lineMessageId,
        quotedMessageId: input.quotedMessageId,
        error: error.message,
      });
      return { handled: true, kind: "failed", amount, reason: "correction_rpc_failed" };
    }

    const result = asRecord(data);
    const kind = result?.kind;
    if (kind === "applied" || kind === "already_applied") {
      return { handled: true, kind, amount };
    }
    return {
      handled: true,
      kind: "ignored",
      amount,
      reason: typeof result?.reason === "string" ? result.reason : "quoted_target_not_eligible",
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
