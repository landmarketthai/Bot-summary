import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { logger } from "@/lib/logger";
import {
  listKnownProduceMarketLabels,
  loadDigitalWhiteSheetPageModel,
  loadWhiteSheetCashEntry,
  requireTrustedWhiteSheetSummary,
  saveWhiteSheetCashEntry,
  splitWhiteSheetWarnings,
  WhiteSheetHardStopError,
  WhiteSheetPersistenceError,
  type WhiteSheetCashEntryInput,
  type WhiteSheetCashEntryState,
} from "@/lib/white-sheet";
import type { WhiteSheetLoadDeps } from "@/lib/white-sheet/load";
import type { WhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import {
  buildWhiteSheetHardStopReplyMessages,
  buildWhiteSheetSummaryMessages,
} from "@/lib/line/white-sheet-summary";

type Supabase = SupabaseClient<Database>;

const GENERIC_SAVE_ERROR =
  "บันทึกปิดยอดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ";

const FINALIZED_REPLY = [
  "ปิดยอดของวันนี้ถูกยืนยันแล้ว (FINALIZED)",
  "ไม่สามารถแก้ไขผ่าน LINE ได้",
  "หากต้องการแก้ไข กรุณาติดต่อผู้ดูแลระบบ",
].join("\n");

export type WhiteSheetCloseOutcome = {
  replyMessages: string[];
  persisted: boolean;
  trusted: boolean;
};

function isFinalizedPersistenceError(error: unknown): boolean {
  return (
    error instanceof WhiteSheetPersistenceError &&
    error.message.includes("finalized")
  );
}

/**
 * Merges parsed LINE closing fields with any existing SUBMITTED entry.
 *
 * - First submission (not_submitted): omitted expenses initialize as 0.
 * - Resubmission (submitted): omitted expenses preserve persisted values;
 *   explicit values (including 0) replace. Explicit ค่าอื่น replaces both
 *   amount and note (ค่าอื่น 0 with no note clears a stale otherNote).
 * - ยอดขาย, เงินให้เจ้า, and เงินสด are always required and replace their
 *   persisted values. Each expense provenance flag records whether its line
 *   was present; saveWhiteSheetCashEntry keeps true sticky on resubmission.
 */
export function mergeWhiteSheetCloseInput(
  sourceId: string,
  command: WhiteSheetCloseCommand,
  existing: WhiteSheetCashEntryState,
  accountabilityRoundId?: string | null,
): WhiteSheetCashEntryInput {
  const identity = {
    sourceId,
    marketLabelNormalized: command.marketLabelNormalized,
    businessDate: command.businessDate,
    accountabilityRoundId,
  };

  if (existing.status === "not_submitted") {
    const other = command.other;
    return {
      ...identity,
      whiteSheetSales: command.whiteSheetSales,
      ownerCash: command.ownerCash,
      labor: command.labor ?? 0,
      locationFee: command.locationFee ?? 0,
      bag: command.bag ?? 0,
      snack: command.snack ?? 0,
      other: other?.amount ?? 0,
      otherNote: other?.note ?? null,
      actualCashSubmitted: command.actualCashSubmitted,
      laborEntered: command.labor !== undefined,
      locationFeeEntered: command.locationFee !== undefined,
      bagEntered: command.bag !== undefined,
      snackEntered: command.snack !== undefined,
      otherEntered: command.other !== undefined,
      actualCashEntered: true,
    };
  }

  const prior = existing.expenses;
  const other =
    command.other !== undefined
      ? {
          amount: command.other.amount,
          // Explicit ค่าอื่น 0 with no note clears a stale note; any supplied
          // note (including with amount 0) replaces the persisted note.
          note: command.other.note,
        }
      : {
          amount: prior.other,
          note: prior.otherNote ?? null,
        };

  return {
    ...identity,
    whiteSheetSales: command.whiteSheetSales,
    ownerCash: command.ownerCash,
    labor: command.labor ?? prior.labor,
    locationFee: command.locationFee ?? prior.locationFee,
    bag: command.bag ?? prior.bag,
    snack: command.snack ?? prior.snack,
    other: other.amount,
    otherNote: other.note,
    actualCashSubmitted: command.actualCashSubmitted,
    laborEntered: command.labor !== undefined,
    locationFeeEntered: command.locationFee !== undefined,
    bagEntered: command.bag !== undefined,
    snackEntered: command.snack !== undefined,
    otherEntered: command.other !== undefined,
    actualCashEntered: true,
  };
}

/**
 * Persist operator closing expenses/cash from a validated LINE command,
 * then reload the canonical White Sheet and format the LINE reply.
 *
 * Arithmetic always comes from the canonical loader/composer — never from
 * the LINE parser.
 */
export async function processWhiteSheetCloseCommand(
  supabase: Supabase,
  input: {
    sourceId: string;
    command: WhiteSheetCloseCommand;
    accountabilityRoundId?: string | null;
  },
  deps: WhiteSheetLoadDeps = {},
): Promise<WhiteSheetCloseOutcome> {
  const { sourceId, command, accountabilityRoundId } = input;
  const log = logger.child({
    sourceId,
    market: command.marketLabelNormalized,
    businessDate: command.businessDate,
  });

  const knownMarkets = await listKnownProduceMarketLabels(
    supabase,
    sourceId,
    command.businessDate,
  );

  if (!knownMarkets.includes(command.marketLabelNormalized)) {
    const hint =
      knownMarkets.length > 0
        ? `ตลาดที่มีข้อมูลวันนี้:\n${knownMarkets.map((m) => `- ${m}`).join("\n")}`
        : "ยังไม่พบรายการเบิก/คืนของวันนี้สำหรับแหล่งนี้";
    return {
      replyMessages: [
        [
          `ไม่พบตลาด "${command.marketLabel}" ในข้อมูลวันนี้`,
          "กรุณาใช้ชื่อตลาดให้ตรงกับรายการเบิก/คืน (ไม่มีการเดาชื่อ)",
          hint,
        ].join("\n"),
      ],
      persisted: false,
      trusted: false,
    };
  }

  let existing: WhiteSheetCashEntryState;
  try {
    existing = await loadWhiteSheetCashEntry(supabase, {
      sourceId,
      marketLabelNormalized: command.marketLabelNormalized,
      businessDate: command.businessDate,
      accountabilityRoundId,
    });
  } catch (error) {
    log.error("white sheet close existing-entry load failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      replyMessages: [GENERIC_SAVE_ERROR],
      persisted: false,
      trusted: false,
    };
  }

  // Reject FINALIZED before any merge/write so omitted-field merge cannot
  // appear to mutate a locked row.
  if (existing.status === "finalized") {
    log.info("white sheet close rejected — finalized");
    return {
      replyMessages: [FINALIZED_REPLY],
      persisted: false,
      trusted: false,
    };
  }

  const merged = mergeWhiteSheetCloseInput(
    sourceId,
    command,
    existing,
    accountabilityRoundId,
  );

  try {
    await saveWhiteSheetCashEntry(supabase, merged);
  } catch (error) {
    if (isFinalizedPersistenceError(error)) {
      log.info("white sheet close rejected — finalized");
      return {
        replyMessages: [FINALIZED_REPLY],
        persisted: false,
        trusted: false,
      };
    }

    log.error("white sheet close persistence failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      replyMessages: [GENERIC_SAVE_ERROR],
      persisted: false,
      trusted: false,
    };
  }

  let pageModel;
  try {
    pageModel = await loadDigitalWhiteSheetPageModel(supabase, {
      sourceId,
      marketKey: command.marketLabelNormalized,
      marketLabel: command.marketLabelNormalized,
      businessDate: command.businessDate,
      accountabilityRoundId,
    }, deps);
  } catch (error) {
    log.error("white sheet close canonical reload failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      replyMessages: [
        [
          "บันทึกข้อมูลปิดยอดแล้ว ✅",
          "แต่โหลดสรุปยอดไม่สำเร็จ กรุณาเปิดหน้าเว็บตรวจสอบ หรือติดต่อผู้ดูแลระบบ",
        ].join("\n"),
      ],
      persisted: true,
      trusted: false,
    };
  }

  try {
    const summary = requireTrustedWhiteSheetSummary(pageModel);
    return {
      replyMessages: buildWhiteSheetSummaryMessages(summary),
      persisted: true,
      trusted: true,
    };
  } catch (error) {
    if (error instanceof WhiteSheetHardStopError) {
      const { hardStopWarnings } = splitWhiteSheetWarnings(pageModel.summary.warnings);
      return {
        replyMessages: buildWhiteSheetHardStopReplyMessages(hardStopWarnings),
        persisted: true,
        trusted: false,
      };
    }
    throw error;
  }
}
