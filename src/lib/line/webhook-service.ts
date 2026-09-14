import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  LineEvent,
  LineImageMessage,
  LineMessageEvent,
  LineMessage,
  LinePostbackEvent,
  LineTextMessage,
} from "@/lib/line/types";
import type { Database, LineMessageType } from "@/types/database";
import { getSourceId, getUserId, getPendingSessionKey } from "@/lib/line/verify";
import { parserRegistry } from "@/lib/parsers/registry";
import { logger } from "@/lib/logger";
import {
  replyLineMessage,
  replyLineMessages,
  replyLineApiMessages,
  buildWeighSessionSummary,
  type LineApiMessage,
} from "@/lib/line/reply";
import {
  GuidedJourneyService,
  GuidedMenuUxHandler,
  GuidedRoundService,
  buildGuidedMenuIdentity,
  buildInvalidMenuMessage,
  buildSlipHandoffMessages,
  guardGuidedWhiteSheetSubmission,
  isExactGuidedMenuTrigger,
  isExactGuidedCloseTrigger,
  isExactGuidedCancelTrigger,
  isGuidedMenuPostbackCandidate,
  isGuidedMenuPostbackData,
  guardGuidedSlipOpen,
  GuidedMenuStateService,
  isGuidedRoundCloseCommand,
  isGuidedSettlementCommandText,
  extractGuidedMarker,
  processGuidedRoundClose,
  processGuidedSettlementSubmission,
  LINE_REPLY_MESSAGE_MAX,
} from "@/lib/line/guided-menu";
import {
  parseWeighSession,
  parseBuddhistDate,
  getWeighSessionFinalizationErrors,
  buildWeighSessionValidationReply,
} from "@/lib/parsers/weigh-session/parser";
import { buildSeedFromStructuredMetadata } from "@/lib/parsers/weigh-session/seed";
import { RE } from "@/lib/parsers/weigh-session/regex";
import {
  buildDraftItemActionReply,
  findDraftItemCommand,
  latestDraftItemAction,
  parseSubunitConfirmCommandLine,
} from "@/lib/parsers/weigh-session/draft-item-command";
import { mainCloserRefusal } from "@/lib/parsers/weigh-session/main-closer";
import {
  PendingSessionService,
  PendingSessionAfterCloseBoundaryError,
  PendingSessionClosedError,
  PendingSessionGenerationConflictError,
  PendingSessionStaleValidationSnapshotError,
  type PendingSession,
} from "@/lib/line/pending-session-service";
import {
  boundaryRejectReply,
  headerOpenedWithRetainedReply,
  incompleteCloserReply,
  isExactRecoverLatestCommand,
  isIncompleteProduceCloser,
  loadRecoverableSelection,
  recoverCommandReply,
  recoverLatestRejectedBundle,
  type RecoveryReason,
} from "@/lib/line/pending-produce-recovery";
import type { StructuredPendingSession } from "@/lib/line/produce-session-commands";
import {
  isExactReplaceFinalizedSessionCommand,
  replacementDraftCommandReply,
  startFinalizedSessionReplacementDraft,
} from "@/lib/produce/replacement-draft";
import { DailySummaryService } from "@/lib/line/daily-summary-service";
import { SessionDedupService } from "@/lib/line/session-dedup-service";
import {
  parseWhiteSheetNoteCommand,
  collapseWhiteSheetNoteFields,
  isWhiteSheetNoteFieldShaped,
  type WhiteSheetNoteParseResult,
  type WhiteSheetNoteFieldValue,
} from "@/lib/line/white-sheet-note-command";
import {
  WhiteSheetNoteSessionService,
  type ManualWhiteSheetNoteSessionRow,
} from "@/lib/line/white-sheet-note-session-service";
import type { WeighSession } from "@/lib/parsers/weigh-session/types";
import { bangkokBusinessDateNow } from "@/lib/business-date";
import { parseManualSlipAmounts } from "@/lib/parsers/manual-slip-amount";
import { ManualSlipSessionService } from "@/lib/line/manual-slip-session-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import type { SlipEvidenceIngestor } from "@/lib/slips/types";
import {
  SlipCheckService,
  type SlipCheckProcessor,
} from "@/lib/slips/check-service";
import { SlipBatchService, type SlipBatchIngestor } from "@/lib/slips/batch-service";
import { tryFinalizeSettlement } from "@/lib/settlement-finalizer";
import { parseRemainingFruitCommandFromMessage } from "@/lib/summary/remaining-fruit-command";
import { fetchRemainingFruitRows } from "@/lib/summary/remaining-fruit-data";
import { buildRemainingFruitMessagesFromRows } from "@/lib/summary/remaining-fruit-message";
import { parseSalesSummaryCommandFromMessage } from "@/lib/sales/command";
import { parsePreflightCommandFromMessage } from "@/lib/produce/preflight-command";
import { parsePurchasePlanningCommandFromMessage } from "@/lib/summary/purchase-planning-command";
import { loadPurchasePlanningReport } from "@/lib/summary/purchase-planning-service";
import { buildPurchasePlanningMessages } from "@/lib/summary/purchase-planning-message";
import { runDailyClosePreflight } from "@/lib/produce/preflight-service";
import { buildPreflightMessages } from "@/lib/produce/preflight-message";
import { loadSalesReport } from "@/lib/sales/load";
import { buildSalesSummaryMessages } from "@/lib/sales/message";
import { previousBangkokBusinessDate } from "@/lib/sales/cron";
import {
  SlipSessionService,
  parseSlipSessionHeader,
  isSlipCloseCommand,
  type SlipSessionIngestor,
  type SlipSessionHeader,
} from "@/lib/slips/slip-session-service";
import { parseWhiteSheetCloseCommandFromMessage } from "@/lib/line/white-sheet-close-command";
import { processWhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-service";
import { isPhysicalInventoryLineGroupAllowed } from "@/lib/physical-inventory/config";
import {
  classifyPhysicalInventoryStandaloneIntent,
  isExplicitEmptyHouseStockDeclaration,
  isPricedPhysicalInventoryHeaderText,
  isRecognizedPhysicalInventoryItemBlock,
  matchesPhysicalInventoryCloseLine,
  parsePhysicalInventoryDocument,
  HOUSE_STOCK_PRICED_PARSER_VERSION,
  PHYSICAL_INVENTORY_PARSER_VERSION,
} from "@/lib/physical-inventory";
import {
  PhysicalInventoryAfterCloseBoundaryError,
  PhysicalInventoryAfterCloseError,
  PhysicalInventoryGenerationConflictError,
  PhysicalInventorySessionService,
} from "@/lib/physical-inventory/session-service";
import { finalizePhysicalInventoryAfterClose } from "@/lib/physical-inventory/finalizer";
import {
  DefaultDataEntrySessionOwnershipResolver,
  type DataEntrySessionOwnershipResolver,
} from "@/lib/line/data-entry-session-ownership";
import { tryHandlePurchaseCaptureMessage } from "@/lib/purchase-capture/webhook-handler";
import { bindPlainTextRound } from "@/lib/produce/plain-text-round-binding";
import {
  closeGapBlockIsStragglerFabricable,
  confirmProduceSubunitReview,
  markProduceValidationReviewsPresented,
  deliveredPresentationDigests,
  isProduceReviewApproved,
  runProduceCloseGate,
} from "@/lib/produce/entry-validation-gate";
import {
  buildBlockingValidationReply,
  buildPlainTextReviewPresentationPages,
} from "@/lib/produce/entry-validation-message";
import {
  CANCEL_ACTIVE_DRAFT_NONE_REPLY,
  CANCEL_ACTIVE_DRAFT_REFUSED_REPLY,
  CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY,
  CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REASON,
  CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REPLY,
  cancelActiveProduceDraft,
  isExactCancelActiveDraftCommand,
} from "@/lib/produce/cancel-active-draft";
import { getRuntimeEnvironment } from "@/lib/runtime-environment";

type Supabase      = SupabaseClient<Database>;
type ChildLogger   = ReturnType<typeof logger.child>;
type QueueClaim = {
  queue_id: string;
  line_event_id: string;
  source_id: string;
  raw_message_id: string;
  receive_order: number;
  claim_token: string;
};
type OrderedEventReceipt = {
  rawMessageId: string;
  sourceId: string;
  duplicate: boolean;
};
type EventReceipt = {
  event: LineEvent;
  rawMessageId: string;
  ordered: boolean;
  sourceId: string;
};
type ReplyLineMessage = (replyToken: string, text: string) => Promise<void>;
type ReplyLineMessages = (replyToken: string, texts: string[]) => Promise<void>;
type ReplyLineApiMessages = (
  replyToken: string,
  messages: LineApiMessage[],
) => Promise<void>;
type ScheduleBackgroundTask = (task: () => Promise<void>) => void;
type PhysicalInventoryFinalizer = (params: {
  sessionId: string;
  expectedGeneration: string;
}) => Promise<unknown>;
type PhysicalInventorySessionGateway = Pick<
  PhysicalInventorySessionService,
  "findOpenSession" | "openSession" | "registerIngest"
> & Partial<Pick<PhysicalInventorySessionService, "closeOpenEvent" | "listIngestTexts">>;

const BATCH_FIRST_IMAGE_REPLY = [
  "รับรูปหลักฐานแล้วครับ",
  "ถ้ามีหลายใบ ส่งต่อได้เลย",
  `พิมพ์ "จบสลิป" เมื่อส่งครบ`,
].join("\n");

const EVIDENCE_FAILED_REPLY = "รับรูปไม่สำเร็จ กรุณาส่งใหม่อีกครั้ง";

const BATCH_FINALIZED_LATE_IMAGE_REPLY =
  "รูปนี้ไม่ถูกรวมในชุดสลิป เนื่องจากระบบเริ่มสรุปแล้ว กรุณาเปิดชุดใหม่ก่อนส่งรูป";

const NO_ACTIVE_BATCH_REPLY = [
  "ยังไม่มีชุดสลิปที่เปิดอยู่",
  "กรุณาพิมพ์หัวชุดก่อน เช่น:",
  "กี้ วัดทุ่งลานนา สลิปเงินโอน 9/6/2569",
].join("\n");

const SESSION_ALREADY_OPEN_REPLY = [
  "มีชุดสลิปที่เปิดอยู่แล้ว",
  `กรุณาพิมพ์ "จบสลิป" ก่อน เพื่อปิดชุดสลิปปัจจุบัน`,
].join("\n");

const SLIP_CLOSE_ACKNOWLEDGED_REPLY =
  "รับคำสั่งจบชุดแล้ว กำลังตรวจสอบสลิปทั้งหมด กรุณารอสรุปผล";

const ALREADY_CLOSING_REPLY = "รับทราบแล้ว กำลังสรุปสลิปอยู่ กรุณารอสักครู่";

const STALE_PRODUCE_SESSION_REPLY =
  "พบรายการเดิมที่ยังปิดไม่สมบูรณ์ กรุณาให้ทีมงานเคลียร์รายการเดิมก่อนเริ่มรายการใหม่";

// The close raced a legitimate item that was still committing. Nothing was
// lost and no close boundary was written, so the operator simply closes again
// against the complete list. This must stay recoverable wording: the failure
// mode it replaces was a silent terminal failed_closed.
/**
 * What a plain-text close gate refusal carries back to the caller.
 *
 * `reviewPresentation` marks a CONFIRMABLE review that has been recorded but
 * NOT yet proven delivered. The caller stamps delivery only after its LINE
 * reply succeeds. Blocking errors carry none: they are not confirmable.
 */
interface PlainTextCloseGateRefusal {
  refusalText: string;
  /** Extra pages when the review set needs more than one LINE message. */
  refusalPages?: string[];
  /**
   * The review rows this exact refusal text actually RENDERED, and may
   * therefore authorize once it has been delivered. One message can present
   * the whole review plus a per-item row for every risky subunit (#109",
   * confirms those individually). A review truncated out of the text is
   * absent here: unrendered is not delivered.
   */
  reviewPresentation?: {
    digests: string[];
    sessionGeneration: string;
  };
}

const CLOSE_RACED_LATE_ITEM_REPLY =
  "มีรายการส่งเข้ามาเพิ่มพอดีตอนปิดรอบ ระบบยังไม่ได้ปิดรอบ รายการทั้งหมดยังอยู่ครบ กรุณาพิมพ์ปิดรอบอีกครั้ง";

function buildPhysicalInventoryItemParseFailureReply(sequence: number | null): string {
  return [
    `รายการที่ ${sequence ?? 1} อ่านรูปแบบราคาไม่สำเร็จ`,
    "กรุณาแก้ไขแล้วส่งรายการใหม่",
    "รายการยังเปิดอยู่",
  ].join("\n");
}

function buildHouseStockExplicitEmptyAck(businessDate: string | null): string {
  const date = businessDate ? formatPhysicalInventoryBusinessDate(businessDate) : null;
  return [
    "รับทราบ ✅",
    date ? `วันที่ ${date} ไม่มีผลไม้คงเหลือในบ้าน` : "ไม่มีผลไม้คงเหลือในบ้าน",
    `ส่ง "จบ" เพื่อบันทึก`,
  ].join("\n");
}

const HOUSE_STOCK_EMPTY_THEN_ITEM_REPLY = [
  "⚠️ รายการนี้ถูกระบุว่าไม่มีผลไม้คงเหลือแล้ว",
  "หากมีสินค้า กรุณายกเลิกรายการและเริ่มใหม่",
].join("\n");

const HOUSE_STOCK_ITEM_THEN_EMPTY_REPLY = [
  "⚠️ รายการนี้มีสินค้าอยู่แล้ว",
  "ไม่สามารถระบุว่าไม่มีผลไม้คงเหลือได้",
  "หากต้องการเริ่มใหม่ กรุณายกเลิกรายการและเริ่มใหม่",
].join("\n");

const PRODUCE_ENTRY_GATE_UNAVAILABLE_REPLY = [
  "⛔ ระบบตรวจสอบรายการไม่สำเร็จ จึงยังไม่บันทึก",
  "รายการยังเปิดอยู่ กรุณาส่งข้อความจบรายการอีกครั้ง",
].join("\n");

const PRODUCE_CLOSE_PENDING_REPLY =
  "รับจบรายการแล้ว กำลังตรวจสอบรายการที่ยังส่งมาไม่ถึง กรุณารอสักครู่";

async function rejectedBundleNotice(
  service: PendingSessionService,
  sessionKey: string,
  fallback: RecoveryReason,
): Promise<string> {
  try {
    const selection = await loadRecoverableSelection(service, sessionKey);
    if (selection.kind === "one") {
      return boundaryRejectReply(selection.bundle.events.length, selection.bundle.reason);
    }
  } catch (error) {
    logger.warn("rejected Produce bundle lookup failed", {
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return boundaryRejectReply(1, fallback);
}

async function retainedBundleNotice(
  service: PendingSessionService,
  sessionKey: string,
): Promise<string | null> {
  try {
    const selection = await loadRecoverableSelection(service, sessionKey);
    if (selection.kind !== "one") return null;
    return headerOpenedWithRetainedReply(
      selection.bundle.events.length,
      selection.bundle.reason,
    );
  } catch (error) {
    logger.warn("retained Produce bundle lookup failed", {
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function deferredRejectReason(action: string): RecoveryReason {
  if (action === "rejected_after_close") return "after_close";
  if (action === "rejected_orphan") return "orphan";
  return "before_opener";
}

/** 0050: plain-text จบรายการ must not close a Guided/structured session. */
export const STRUCTURED_TEXT_CLOSE_REFUSED_REPLY =
  "รายการนี้เปิดจากเมนู กรุณากดตรวจและจบจากเมนู ไม่รับคำสั่งจบจากข้อความ";

// ── LINE Manual White Sheet entry session ───────────────────────────────────
// Temporary session state for multi-message LINE entry. On close, entered
// values are saved into digital_white_sheet_cash_entries atomically by the
// close_manual_white_sheet_note_session RPC (migration 0059) — not coupled
// to produce, slips, transfers, reconciliation, settlement, or work rounds.
const WHITE_SHEET_NOTE_FIELD_LABEL: Record<string, string> = {
  labor: "ค่าแรง",
  locationFee: "ค่าที่",
  bag: "ค่าถุง",
  snack: "ค่าขนม",
  other: "ค่าอื่น",
  actualCash: "เงินสด",
  // Task 4 (Daily Financial Settlement) — the two genuinely missing inputs.
  whiteSheetSales: "ยอดขาย",
  ownerCash: "เงินให้เจ้า",
};

const WHITE_SHEET_NOTE_NO_OPEN_SESSION_REPLY = "ยังไม่มีใบขาวมือที่เปิดอยู่";

const WHITE_SHEET_NOTE_CLOSE_EMPTY_REPLY =
  "กรุณาส่งค่าใช้จ่ายอย่างน้อย 1 รายการก่อนพิมพ์ จบใบขาวมือ";

const WHITE_SHEET_NOTE_ALREADY_CLOSED_REPLY = "ใบขาวมือนี้ปิดแล้ว";
const WHITE_SHEET_NOTE_ALREADY_CANCELLED_REPLY = "ใบขาวมือนี้ยกเลิกแล้ว";

const WHITE_SHEET_NOTE_FINALIZED_REPLY =
  "ใบขาวมือนี้ถูกปิดสรุปแล้ว (FINALIZED) แก้ไขผ่านข้อความไม่ได้ กรุณาติดต่อผู้ดูแลระบบ";

const WHITE_SHEET_NOTE_LOOKUP_ERROR_REPLY =
  "ระบบใบขาวมือขัดข้องชั่วคราว กรุณาลองอีกครั้ง";

function isoDateToBuddhistDisplay(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${Number(year) + 543}`;
}

function formatMoney(value: number): string {
  return value.toLocaleString("th-TH");
}

function buildWhiteSheetNoteFieldLines(session: ManualWhiteSheetNoteSessionRow): string[] {
  const lines: string[] = [];
  if (session.labor !== null) lines.push(`ค่าแรง: ${formatMoney(session.labor)} บาท`);
  if (session.location_fee !== null) lines.push(`ค่าที่: ${formatMoney(session.location_fee)} บาท`);
  if (session.bag !== null) lines.push(`ค่าถุง: ${formatMoney(session.bag)} บาท`);
  if (session.snack !== null) lines.push(`ค่าขนม: ${formatMoney(session.snack)} บาท`);
  if (session.other_amount !== null) {
    lines.push(
      `ค่าอื่น: ${formatMoney(session.other_amount)} บาท${session.other_note ? ` — ${session.other_note}` : ""}`,
    );
  }
  if (session.actual_cash !== null) lines.push(`เงินสด: ${formatMoney(session.actual_cash)} บาท`);
  if (session.white_sheet_sales != null) {
    lines.push(`ยอดขาย: ${formatMoney(session.white_sheet_sales)} บาท`);
  }
  if (session.owner_cash != null) lines.push(`เงินให้เจ้า: ${formatMoney(session.owner_cash)} บาท`);
  return lines;
}

type CashEntryForSummary = Database["public"]["Tables"]["digital_white_sheet_cash_entries"]["Row"];

/** Close replies must show the final canonical row, including preserved fields. */
function buildWhiteSheetNoteCanonicalSummary(
  marketLabel: string,
  businessDate: string,
  cash: CashEntryForSummary,
): string {
  const otherNote = cash.other_note ? ` — ${cash.other_note}` : "";
  const lines = [
    "จบใบขาวมือแล้ว ✅",
    "",
    `ตลาด: ${marketLabel}`,
    `วันที่: ${isoDateToBuddhistDisplay(businessDate)}`,
    `ค่าแรง: ${formatMoney(Number(cash.labor))} บาท`,
    `ค่าที่: ${formatMoney(Number(cash.location_fee))} บาท`,
    `ค่าถุง: ${formatMoney(Number(cash.bag))} บาท`,
    `ค่าขนม: ${formatMoney(Number(cash.snack))} บาท`,
    `ค่าอื่น: ${formatMoney(Number(cash.other))} บาท${otherNote}`,
    `เงินสด: ${formatMoney(Number(cash.actual_cash_submitted))} บาท`,
  ];
  // Task 4 fields are nullable (not every close carries them yet) — shown
  // only when actually entered, never rendered as a false zero.
  if (cash.white_sheet_sales != null) {
    lines.push(`ยอดขาย: ${formatMoney(Number(cash.white_sheet_sales))} บาท`);
  }
  if (cash.owner_cash != null) {
    lines.push(`เงินให้เจ้า: ${formatMoney(Number(cash.owner_cash))} บาท`);
  }
  lines.push("", "บันทึกข้อมูลใบขาวแล้ว");
  return lines.join("\n");
}

/** Reply for resuming an already-open session — must never claim closed/saved. */
function buildWhiteSheetNoteResumeSummary(session: ManualWhiteSheetNoteSessionRow): string {
  return [
    "ใบขาวมือยังเปิดอยู่",
    "",
    `ตลาด: ${session.market_label}`,
    `วันที่: ${isoDateToBuddhistDisplay(session.business_date)}`,
    ...buildWhiteSheetNoteFieldLines(session),
    "",
    "ส่งข้อมูลต่อได้เลย",
    "พิมพ์ จบใบขาวมือ เมื่อกรอกครบ",
  ].join("\n");
}

function buildWhiteSheetNoteFieldSaveReply(fields: WhiteSheetNoteFieldValue[]): string {
  const collapsed = collapseWhiteSheetNoteFields(fields);
  const lines = collapsed.map((field) => {
    const label = WHITE_SHEET_NOTE_FIELD_LABEL[field.key];
    const noteSuffix = field.note ? ` — ${field.note}` : "";
    return `${label} ${formatMoney(field.amount)} บาท${noteSuffix}`;
  });
  if (lines.length === 1) return `บันทึกแล้ว: ${lines[0]}`;
  return ["บันทึกแล้ว:", ...lines.map((line) => `- ${line}`)].join("\n");
}

function buildWhiteSheetNoteTerminalReply(latest: ManualWhiteSheetNoteSessionRow | null): string {
  if (latest?.status === "closed") return WHITE_SHEET_NOTE_ALREADY_CLOSED_REPLY;
  if (latest?.status === "cancelled") return WHITE_SHEET_NOTE_ALREADY_CANCELLED_REPLY;
  return WHITE_SHEET_NOTE_NO_OPEN_SESSION_REPLY;
}

interface WebhookServiceDependencies {
  evidenceIngestor?: SlipEvidenceIngestor;
  checkProcessor?: SlipCheckProcessor;
  batchService?: SlipBatchIngestor;
  slipSessionService?: SlipSessionIngestor;
  replyMessage?: ReplyLineMessage;
  replyMessages?: ReplyLineMessages;
  replyApiMessages?: ReplyLineApiMessages;
  guidedMenuHandler?: GuidedMenuUxHandler;
  guidedJourneyService?: GuidedJourneyService;
  guidedRoundService?: GuidedRoundService;
  guidedMenuStateService?: GuidedMenuStateService;
  scheduleBackgroundTask?: ScheduleBackgroundTask;
  physicalInventoryFinalizer?: PhysicalInventoryFinalizer;
  physicalInventoryService?: PhysicalInventorySessionGateway;
  dataEntrySessionOwnershipResolver?: DataEntrySessionOwnershipResolver;
}

export interface WebhookProcessResult {
  eventId:   string;
  eventType: string;
  status:    "saved" | "duplicate" | "error";
  parsed?:   boolean;
  error?:    string;
  pendingSessionClosed?: boolean;
  claimConflict?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bangkokToday(): string {
  return bangkokBusinessDateNow();
}

function formatPhysicalInventoryBusinessDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function hasSessionEnd(text: string): boolean {
  return text.split("\n").some((l) => RE.SESSION_END.test(l.trim()));
}

export function parseExpectedItemCount(text: string): number | null {
  for (const rawLine of text.split("\n")) {
    const line = normalizeLine(rawLine).trim();
    const raw = line.match(RE.SESSION_END_COUNT)?.[1]
      ?? line.match(RE.ADDITIONAL_END)?.[2];
    if (raw === undefined) continue;
    const count = Number.parseInt(raw, 10);
    return Number.isSafeInteger(count) && count > 0 ? count : null;
  }
  return null;
}

function hasItemLine(text: string): boolean {
  return text.split("\n").some((l) => RE.ITEM.test(l.trim()));
}

// SESSION_END lines like "จบรายการคืน" contain "คืน" which also matches SESSION_START.
// Skip SESSION_END lines before testing so pure closing messages are never treated as headers.
export function hasSessionStart(text: string): boolean {
  return text.split("\n").some((l) => {
    const line = l.trim();
    return !RE.SESSION_END.test(line) && RE.SESSION_START.test(line);
  });
}

function canonicalSessionHeader(line: string): string {
  return normalizeLine(line).trim().replace(/\s+/g, " ");
}

function isProduceSessionHeaderLine(line: string): boolean {
  if (!line || RE.SESSION_END.test(line) || !RE.SESSION_START.test(line)) {
    return false;
  }

  return (
    RE.SELLER_MARKET.test(line)
    || line.startsWith("รายการ")
    || RE.DATE_IN_TEXT.test(line)
  );
}

export function findProduceSessionHeader(text: string): string | null {
  for (const rawLine of text.split("\n")) {
    const line = canonicalSessionHeader(rawLine);
    if (isProduceSessionHeaderLine(line)) return line;
  }
  return null;
}

export function requiresFreshPendingGeneration(
  accumulatedText: string,
  incomingHeader: string,
): boolean {
  const normalizedPending = normalizeText(accumulatedText);
  if (hasSessionEnd(normalizedPending)) return true;

  const expectedHeader = canonicalSessionHeader(incomingHeader);
  const pendingHeaders = normalizedPending
    .split("\n")
    .map(canonicalSessionHeader)
    .filter(isProduceSessionHeaderLine);

  return (
    pendingHeaders.length === 0
    || pendingHeaders.some((header) => header !== expectedHeader)
  );
}

// Strip LINE export prefix "HH:MM sender " or "HH.MM sender " from each line so that
// hasSessionEnd / SESSION_START / ITEM checks work on clean content.
export function normalizeLine(line: string): string {
  return line.replace(/^\d{1,2}[:.]\d{2}\s+\S+\s+/, "");
}

export function normalizeText(text: string): string {
  return text.split("\n").map(normalizeLine).join("\n");
}

// ── Service ───────────────────────────────────────────────────────────────────

export class WebhookService {
  private readonly evidenceIngestor: SlipEvidenceIngestor;
  private readonly checkProcessor: SlipCheckProcessor;
  private readonly batchService: SlipBatchIngestor;
  private readonly slipSessionService: SlipSessionIngestor;
  private readonly replyMessage: ReplyLineMessage;
  private readonly replyMessages: ReplyLineMessages;
  private readonly replyApiMessages: ReplyLineApiMessages;
  private readonly guidedMenuHandler: GuidedMenuUxHandler;
  private readonly guidedJourney: GuidedJourneyService;
  private readonly guidedRounds: GuidedRoundService;
  private readonly guidedCatalog: GuidedMenuStateService;
  private readonly scheduleBackgroundTask: ScheduleBackgroundTask;
  private readonly physicalInventoryFinalizer: PhysicalInventoryFinalizer;
  private readonly physicalInventoryService: PhysicalInventorySessionGateway;
  private readonly dataEntrySessionOwnershipResolver: DataEntrySessionOwnershipResolver;
  private orderedQueueAvailable: boolean | null = null;

  constructor(
    private readonly supabase: Supabase,
    dependencies: WebhookServiceDependencies = {},
  ) {
    this.evidenceIngestor =
      dependencies.evidenceIngestor ?? new SlipEvidenceService(supabase);
    this.checkProcessor =
      dependencies.checkProcessor ?? new SlipCheckService(supabase);
    this.batchService =
      dependencies.batchService ?? new SlipBatchService(supabase);
    this.slipSessionService =
      dependencies.slipSessionService ?? new SlipSessionService(supabase);
    this.replyMessage = dependencies.replyMessage ?? replyLineMessage;
    this.replyMessages = dependencies.replyMessages ?? replyLineMessages;
    this.replyApiMessages = dependencies.replyApiMessages ?? replyLineApiMessages;
    this.guidedMenuHandler =
      dependencies.guidedMenuHandler ?? new GuidedMenuUxHandler(supabase);
    this.guidedJourney =
      dependencies.guidedJourneyService ?? new GuidedJourneyService(supabase);
    this.guidedRounds =
      dependencies.guidedRoundService ?? new GuidedRoundService(supabase);
    this.guidedCatalog =
      dependencies.guidedMenuStateService ?? new GuidedMenuStateService(supabase);
    this.scheduleBackgroundTask =
      dependencies.scheduleBackgroundTask
      ?? ((task) => {
        void task().catch((error) => {
          logger.error("background webhook task failed", {
            error: error instanceof Error ? error.message : "unknown_error",
          });
        });
      });
    this.physicalInventoryService =
      dependencies.physicalInventoryService
      ?? new PhysicalInventorySessionService(this.supabase);
    this.dataEntrySessionOwnershipResolver =
      dependencies.dataEntrySessionOwnershipResolver
      ?? new DefaultDataEntrySessionOwnershipResolver(
        this.supabase,
        this.physicalInventoryService,
      );
    this.physicalInventoryFinalizer =
      dependencies.physicalInventoryFinalizer
      ?? ((params) => finalizePhysicalInventoryAfterClose(this.supabase, params));
  }

  async processEvents(events: LineEvent[], destination: string): Promise<WebhookProcessResult[]> {
    // LINE's array order is the only ordering guarantee inside one payload.
    // Persist every event before any worker starts so a later close can see
    // every earlier event in the durable queue.
    const receipts: EventReceipt[] = [];
    const immediate = new Map<string, WebhookProcessResult>();
    for (const event of events) {
      const saved = await this.saveRawMessage(event, destination);
      if (saved === null) {
        immediate.set(event.webhookEventId, {
          eventId: event.webhookEventId,
          eventType: event.type,
          status: "duplicate",
        });
      } else if (saved === "error") {
        immediate.set(event.webhookEventId, {
          eventId: event.webhookEventId,
          eventType: event.type,
          status: "error",
          error: "db insert failed",
        });
      } else {
        const ordered = typeof saved === "object";
        if (ordered && saved.duplicate) {
          immediate.set(event.webhookEventId, {
            eventId: event.webhookEventId,
            eventType: event.type,
            status: "duplicate",
          });
        }
        receipts.push({
          event,
          rawMessageId: ordered ? saved.rawMessageId : saved,
          ordered,
          sourceId: ordered ? saved.sourceId : getSourceId(event.source),
        });
      }
    }

    if (this.orderedQueueAvailable !== false) {
      const resultByEventId = new Map<string, WebhookProcessResult>();
      const orderedReceipts = receipts.filter((receipt) => receipt.ordered);
      const sourceIds = [...new Set(orderedReceipts.map(({ sourceId }) => sourceId))];
      try {
        await Promise.all(
          sourceIds.map((sourceId) => this.drainOrderedSource(sourceId, destination, resultByEventId)),
        );
        for (const receipt of receipts.filter((item) => !item.ordered)) {
          resultByEventId.set(receipt.event.webhookEventId, await this.processOne(
            receipt.event, destination, 0, 1, receipt.rawMessageId,
          ));
        }
        return events.map((event) => immediate.get(event.webhookEventId)
          ?? resultByEventId.get(event.webhookEventId)
          ?? { eventId: event.webhookEventId, eventType: event.type, status: "saved" });
      } catch (error) {
        if (!this.isMissingOrderingInfrastructure(error)) throw error;
        this.orderedQueueAvailable = false;
      }
    }

    // Unit doubles and pre-0060 databases have no queue RPC. They retain the
    // old direct path; deployed databases always take the durable path above.
    for (const [eventIndex, receipt] of receipts.entries()) {
      immediate.set(receipt.event.webhookEventId, await this.processOne(
        receipt.event,
        destination,
        eventIndex,
        receipts.length,
        receipt.rawMessageId,
      ));
    }
    return events.map((event) => immediate.get(event.webhookEventId)!);
  }

  private async processOne(
    event: LineEvent,
    destination: string,
    eventIndex: number,
    eventCount: number,
    existingRawMessageId?: string,
    replyMessage: ReplyLineMessage = this.replyMessage,
  ): Promise<WebhookProcessResult> {
    const eventId = event.webhookEventId;
    const log     = logger.child({
      eventId,
      eventType: event.type,
      eventIndex,
      eventCount,
    });

    log.info("processing event");

    // ── 1. Persist raw event ──────────────────────────────────────────────────
    const saved = existingRawMessageId ?? await this.saveRawMessage(event, destination);
    const rawMessageId = saved && typeof saved === "object" ? saved.rawMessageId : saved;

    if (rawMessageId === null) {
      log.info("duplicate event — skipped");
      return { eventId, eventType: event.type, status: "duplicate" };
    }
    if (rawMessageId === "error") {
      return { eventId, eventType: event.type, status: "error", error: "db insert failed" };
    }

    log.debug("raw message saved", { rawMessageId });

    // ── 2. Guided Menu postback (opaque gpm1 tokens) ──────────────────────────
    if (event.type === "postback") {
      return this.processGuidedMenuPostback(
        event as LinePostbackEvent,
        eventId,
        log,
      );
    }

    // ── 3. Only process text messages ─────────────────────────────────────────
    if (event.type !== "message") {
      log.debug("non-message event — no parsing needed");
      return { eventId, eventType: event.type, status: "saved" };
    }

    const msgEvent = event as LineMessageEvent;
    const message  = msgEvent.message;

    if (message.type === "image") {
      return this.processImageMessage(
        msgEvent,
        message as LineImageMessage,
        rawMessageId,
        eventId,
        log,
      );
    }

    if (message.type !== "text") {
      log.debug("non-text message — skipping parse", { messageType: message.type });
      await this.recordUnsupportedType(rawMessageId, message);
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 3. Test-message shortcut (before any parser) ──────────────────────────
    // The guided provenance marker is removed BEFORE any parser runs, so every
    // existing command keeps its exact syntax and its exact error messages. An
    // ordinary message has no marker and comes through untouched.
    const { text, marker: guidedMarker } = extractGuidedMarker(
      (message as LineTextMessage).text,
    );
    const normalizedText = normalizeText(text);
    const replyToken     = msgEvent.replyToken;
    const sourceId       = getSourceId(msgEvent.source);
    const lineUserId     = getUserId(msgEvent.source);
    const draftItemCommand = findDraftItemCommand(text);

    if (text.trim().toLowerCase() === "test") {
      if (replyToken) await replyLineMessage(replyToken, "Bot รับข้อความได้แล้ว ✅");
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 3.0a. Guided plain-text close "จบรายการ" ─────────────────────────────
    if (isExactGuidedCloseTrigger(text)) {
      const guidedCloseKey = getPendingSessionKey(msgEvent.source);
      if (guidedCloseKey !== null) {
        const guidedCloseLookup = await new PendingSessionService(this.supabase).lookupActive(
          guidedCloseKey,
        );
        if (
          guidedCloseLookup.session
          && (guidedCloseLookup.session as StructuredPendingSession).entry_origin
            === "structured_menu"
        ) {
          return this.processGuidedTextClose(msgEvent, eventId, log);
        }
      }
    }

    // ── 3.0. Guided Menu exact trigger "เมนู" ────────────────────────────────
    if (isExactGuidedMenuTrigger(text)) {
      return this.processGuidedMenuOpen(msgEvent, eventId, log);
    }

    // ── 3.0b. Guided plain-text cancel "ยกเลิก" / "ออกจากเมนู" ────────────────
    // Typed equivalent of the cancel Flex button. Must be intercepted before
    // the structured pending-session append below — this control text must
    // never become a produce document line (see STRUCTURED_TEXT_CLOSE_REFUSED_REPLY
    // for the same guarding pattern on "จบรายการ").
    if (isExactGuidedCancelTrigger(text)) {
      const guidedCancelKey = getPendingSessionKey(msgEvent.source);
      if (guidedCancelKey !== null) {
        const guidedCancelLookup = await new PendingSessionService(this.supabase).lookupActive(
          guidedCancelKey,
        );
        if (
          guidedCancelLookup.session
          && (guidedCancelLookup.session as StructuredPendingSession).entry_origin
            === "structured_menu"
        ) {
          return this.processGuidedTextCancel(msgEvent, eventId, log);
        }
      }
    }

    // ── 3.0b. Guided round close "ปิดรอบ" (3D) ──────────────────────────────
    // Exact-match only. It closes nothing by itself: the command routes to the
    // existing settlement finalization, behind the existing lifecycle blockers.
    if (isGuidedRoundCloseCommand(text)) {
      return this.processGuidedRoundCloseCommand(msgEvent, eventId, log);
    }

    // ── 3.0c. Guided settlement submission "ส่งยอด" (3D.1) ───────────────────
    // Only claims messages that carry the guided settlement header or closing
    // line, so no existing command loses its text. The write itself is the
    // existing POST /api/settlement boundary.
    if (isGuidedSettlementCommandText(text)) {
      return this.processGuidedSettlementCommand(msgEvent, text, guidedMarker, eventId, log);
    }

    // ── 3.1. P2A Physical Inventory (allowlisted LINE groups only) ───────────
    // This must precede remaining-stock and Produce routing because the
    // Physical Inventory header intentionally contains overlapping fruit/stock
    // vocabulary. Outside the explicit group allowlist this is a no-op.
    const physicalInventoryResult = await this.tryProcessPhysicalInventory(
      msgEvent,
      text,
      message.id,
      rawMessageId,
      eventId,
      event.type,
      log,
    );
    if (physicalInventoryResult !== null) return physicalInventoryResult;

    // ── 3.2. White Sheet close command (high-level control; before session appenders)
    // Must take priority over pending produce append, manual-slip amounts, and
    // weigh/return item text so a full closing message is never misrouted.
    const closeParse = parseWhiteSheetCloseCommandFromMessage(text);
    if (closeParse.kind !== "not_command") {
      return this.processWhiteSheetClose(
        msgEvent,
        closeParse,
        guidedMarker,
        eventId,
        event.type,
        log,
      );
    }

    // ── 3.25. LINE Manual White Sheet entry session ───────────────────────────
    // Temporary session state for multi-message LINE entry; saves into
    // digital_white_sheet_cash_entries on close. Not coupled to produce,
    // slips, transfers, reconciliation, settlement, or work rounds. Text is
    // classified first (pure, no I/O); a DB lookup only happens for
    // candidate messages, and field-shaped text falls through unchanged
    // when this source has no open entry session.
    const noteParse = parseWhiteSheetNoteCommand(text);
    if (noteParse.kind !== "not_command") {
      const noteResult = await this.tryProcessWhiteSheetNoteCommand(
        msgEvent, noteParse, eventId, event.type, log, replyMessage,
      );
      if (noteResult !== null) return noteResult;
      // field-shaped text with no open session — not this feature's message.
    } else if (isWhiteSheetNoteFieldShaped(text)) {
      // Open-session fail-closed: never silent-fallthrough to PendingSessionService
      // for field-shaped text while a Manual White Sheet session is open.
      const noteSvc = new WhiteSheetNoteSessionService(this.supabase);
      let openSession: ManualWhiteSheetNoteSessionRow | null;
      try {
        openSession = await noteSvc.findOpenSession(sourceId);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error("white sheet note open-session lookup failed", { sourceId, error: errorMessage });
        if (replyToken) {
          try {
            await replyMessage(replyToken, WHITE_SHEET_NOTE_LOOKUP_ERROR_REPLY);
          } catch { /* ignore reply error */ }
        }
        return { eventId, eventType: event.type, status: "error", parsed: false, error: errorMessage };
      }
      if (openSession) {
        const firstLine = text.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? text.trim();
        const forcedInvalid: Exclude<WhiteSheetNoteParseResult, { kind: "not_command" }> = {
          kind: "field_invalid",
          message: `จำนวนเงินไม่ถูกต้องที่บรรทัด:\n${firstLine}`,
        };
        const noteResult = await this.tryProcessWhiteSheetNoteCommand(
          msgEvent, forcedInvalid, eventId, event.type, log, replyMessage,
        );
        if (noteResult !== null) return noteResult;
      }
    }

    // ── 3.3. Manual slip session commands ────────────────────────────────────
    // Regex has no ^ anchor — matches even with a sender-name prefix on the line.
    const manualOpenMatch = RE.MANUAL_SLIP_OPEN.exec(text);
    if (manualOpenMatch) {
      // Extract market label: text on the same line before ส่งสลิปมือ.
      const matchStart  = manualOpenMatch.index;
      const lineStart   = text.lastIndexOf("\n", matchStart - 1) + 1;
      const labelRaw    = text.slice(lineStart, matchStart).trim();
      const marketLabel = labelRaw || null;
      const marketKey   = labelRaw.toLowerCase().trim() || "default";
      return this.processManualSlipOpen(
        msgEvent, manualOpenMatch[1], marketLabel, marketKey, text, message.id, eventId, event.type, log,
      );
    }

    if (RE.MANUAL_SLIP_CLOSE.test(text.trim())) {
      return this.processManualSlipClose(msgEvent, message.id, eventId, event.type, log);
    }

    const manualEntryResult = await this.tryAppendManualSlipEntry(
      msgEvent, text, message.id, eventId, event.type, log,
    );
    if (manualEntryResult !== null) return manualEntryResult;

    // Read-only report command — must bypass pending produce-session append/close.
    const remainingCmd = parseRemainingFruitCommandFromMessage(text);
    if (remainingCmd) {
      return this.processRemainingFruitCommand(
        msgEvent,
        remainingCmd,
        eventId,
        event.type,
        log,
      );
    }

    // P1 Daily Sales — read-only, same bypass as the remaining-stock command.
    const salesCmd = parseSalesSummaryCommandFromMessage(text);
    if (salesCmd) {
      return this.processSalesSummaryCommand(msgEvent, salesCmd, eventId, event.type, log);
    }

    // Daily Close Preflight — read-only, same bypass as the two reports above.
    const preflightCmd = parsePreflightCommandFromMessage(text);
    if (preflightCmd) {
      return this.processPreflightCommand(msgEvent, preflightCmd, eventId, event.type, log);
    }

    // Purchase planning — read-only, same bypass as the three reports above.
    const purchasePlanningCmd = parsePurchasePlanningCommandFromMessage(text);
    if (purchasePlanningCmd) {
      return this.processPurchasePlanningCommand(
        msgEvent, purchasePlanningCmd, eventId, event.type, log,
      );
    }

    // ── 3.5. Slip session commands (checked before produce session logic) ─────
    if (isSlipCloseCommand(text)) {
      return this.processSlipClose(msgEvent, eventId, event.type, log);
    }

    const slipOpenHeader = parseSlipSessionHeader(text);
    if (slipOpenHeader !== null) {
      return this.processSlipOpen(msgEvent, slipOpenHeader, guidedMarker, eventId, event.type, log);
    }

    // ── 3.6. P2C Purchase Capture (fail-closed behind PURCHASE_CAPTURE_WEBHOOK_ENABLED) ──
    // Sits after every existing feature's ownership check so it can never steal a message
    // owned by Produce, Physical Inventory, Manual Slip, Settlement, or White Sheet; and
    // before produce pending-session lookup so its own reserved-grammar blocks are claimed.
    const purchaseCaptureResult = await this.tryProcessPurchaseCapture(
      msgEvent, text, message.id, rawMessageId, eventId, event.type, log,
    );
    if (purchaseCaptureResult !== null) return purchaseCaptureResult;

    // ── 4. Pending session flow ───────────────────────────────────────────────
    // Group/room sources are shared by every member — a produce event with no
    // userId cannot be attributed to a sender, so it must not be allowed to
    // fall back onto a shared/group-only key (see getPendingSessionKey).
    const pendingSessionKey = getPendingSessionKey(msgEvent.source);
    if (pendingSessionKey === null) {
      log.warn("produce event rejected — group/room source has no userId", {
        sourceType: msgEvent.source.type,
        sourceId,
      });
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }
    const sessionKey = pendingSessionKey;

    const pendingService = new PendingSessionService(this.supabase);
    const lookup = await pendingService.lookupActive(sessionKey);
    const pending = lookup.session;
    const expired = pending ? pendingService.isExpired(pending) : false;
    log.info("pending session lookup completed", {
      sessionKey,
      sessionFound: lookup.reason === "found" || lookup.reason === "terminalized",
      reason: lookup.reason,
      sessionStatus: pending
        ? (expired ? "stale_active" : "active")
        : lookup.reason === "terminalized" ? "terminalized" : null,
      expiresAt: pending ? pendingService.expiresAt(pending) : null,
      error: lookup.error,
    });

    if (lookup.reason === "db_error") {
      return {
        eventId,
        eventType: event.type,
        status: "error",
        parsed: false,
        error: lookup.error ?? "pending session lookup failed",
      };
    }

    if (pending) {
      // ── 4.0. Exact "ยกเลิกรายการ" — abandon the draft being filled in ───────
      //
      // FIRST statement inside the pending branch, deliberately. Nothing
      // between the lookup above and here touches the text, so this is the
      // earliest point that both reuses the authoritative draft this very
      // event would otherwise be appended to, and precedes append, item parse,
      // header parse, close detection and unknown-product classification. The
      // command therefore can never enter accumulated_text, become an item or
      // become a header.
      //
      // Matched against `text` (the marker-stripped raw), exactly as
      // isExactGuidedCloseTrigger is at §3.0a — not the normalized form.
      //
      // The snapshot passed here is the one already resolved above; the row is
      // never re-read first. Every ownership, lifecycle and concurrency
      // question is answered by the RPC under its row lock. An expired-but-
      // present row is still a row: the database decides, not this branch.
      if (isExactCancelActiveDraftCommand(text)) {
        const cancelled = await cancelActiveProduceDraft(this.supabase, {
          sessionKey,
          sessionGeneration: pending.session_generation,
          expectedUpdatedAt: pending.updated_at,
          lineTimestampMs: event.timestamp,
          sourceId,
          lineEventId: eventId,
          runtimeEnvironment: getRuntimeEnvironment(),
        });
        log.info("produce draft cancellation requested", {
          sessionKey,
          sessionGeneration: pending.session_generation,
          cancelled: cancelled.cancelled,
          reason: cancelled.reason,
          roundOutcome: cancelled.cancelled ? cancelled.roundOutcome ?? null : null,
        });
        if (replyToken) {
          // Three outcomes, three replies. The unavailable case is separated
          // out because "try again" is actively wrong advice when the RPC does
          // not exist on this database yet (app deployed ahead of its
          // migration) — the operator would retry forever. It is still a
          // refusal: neither non-success branch ever claims the draft was
          // cancelled.
          let reply: string;
          if (cancelled.cancelled) {
            reply = CANCEL_ACTIVE_DRAFT_SUCCESS_REPLY;
          } else if (cancelled.reason === CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REASON) {
            reply = CANCEL_ACTIVE_DRAFT_UNAVAILABLE_REPLY;
          } else {
            reply = CANCEL_ACTIVE_DRAFT_REFUSED_REPLY;
          }
          try {
            await this.replyMessage(replyToken, reply);
          } catch (replyError) {
            log.error("produce draft cancellation reply failed", {
              error: String(replyError),
            });
          }
        }
        return { eventId, eventType: event.type, status: "saved", parsed: true };
      }

      const subunitConfirm = parseSubunitConfirmCommandLine(text);
      if (subunitConfirm) {
        if (expired) {
          log.warn("expired produce confirmation refused", {
            sessionKey: pending.session_key,
            sessionGeneration: pending.session_generation,
          });
          if (replyToken) await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
          return { eventId, eventType: event.type, status: "saved", parsed: false };
        }
        const structured = pending as StructuredPendingSession;
        const parsed = structured.entry_origin != null
          ? parseWeighSession(
              pending.accumulated_text,
              structured.business_date ?? bangkokToday(),
              undefined,
              buildSeedFromStructuredMetadata(structured),
            )
          : parseWeighSession(pending.accumulated_text, bangkokToday());
        let roundId = pending.accountability_round_id ?? null;
        try {
          if ((pending as StructuredPendingSession).entry_origin == null) {
            const binding = await bindPlainTextRound(
              this.supabase,
              {
                sessionKey: pending.session_key,
                sessionGeneration: pending.session_generation,
                sourceId: pending.source_id,
                lineUserId: pending.line_user_id,
              },
              parsed,
            );
            if (binding.status === "refused") {
              if (replyToken) await this.replyMessage(replyToken, binding.detail);
              return { eventId, eventType: event.type, status: "saved", parsed: false };
            }
            if (binding.status === "bound") roundId = binding.accountabilityRoundId;
          }
          const result = await confirmProduceSubunitReview(
            this.supabase,
            {
              sessionKey: pending.session_key,
              sessionGeneration: pending.session_generation,
              accountabilityRoundId: roundId,
              businessDate: structured.entry_origin != null
                ? structured.business_date ?? null
                : parsed.date,
              marketLabel: structured.entry_origin != null
                ? structured.market_label ?? null
                : parsed.session_title,
              staffLabel: structured.entry_origin != null
                ? structured.staff_label ?? null
                : parsed.staff_name,
              lineUserId: pending.line_user_id,
            },
            parsed,
            subunitConfirm.itemNumber,
            eventId,
          );
          // Only a genuine approval may report success. not_presented (recorded
          // but never proven shown) and terminalized must never read as
          // "✅ ยืนยันแล้ว" — that would tell the operator a subunit was
          // confirmed when nothing authorized it.
          if (replyToken) await this.replyMessage(replyToken,
            isProduceReviewApproved(result)
              ? `✅ ยืนยันข้อ ${subunitConfirm.itemNumber} แล้ว\nกรุณาส่ง “จบรายการ” อีกครั้งเมื่อยืนยันครบทุกข้อ`
              : `⛔ ยืนยันข้อ ${subunitConfirm.itemNumber} ไม่ได้\nรายการนี้ไม่ใช่รายการย่อยที่ต้องยืนยัน หรือข้อมูลเปลี่ยนแล้ว`,
          );
        } catch (error) {
          log.error("subunit confirmation failed", {
            sessionKey: pending.session_key,
            error: error instanceof Error ? error.message : String(error),
          });
          if (replyToken) await this.replyMessage(replyToken, PRODUCE_ENTRY_GATE_UNAVAILABLE_REPLY);
        }
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      if (isExactRecoverLatestCommand(text)) {
        const recovered = await recoverLatestRejectedBundle(
          pendingService,
          pending,
          replyToken ?? null,
        );
        log.info("produce boundary recovery requested", {
          sessionKey,
          sessionGeneration: pending.session_generation,
          status: recovered.status,
          count: recovered.status === "recovered" ? recovered.count : 0,
        });
        if (replyToken) {
          await this.replyMessage(replyToken, recoverCommandReply(recovered));
        }
        return { eventId, eventType: event.type, status: "saved", parsed: true };
      }

      // ── Task 2: explicit replacement of an already-finalized session ─────
      //
      // Same shape as the two branches above: requires an existing, still-
      // empty pending draft (the operator's normal header open), matched here
      // ONLY against exact business identity — see replacement-draft.ts for
      // why an ambiguous or absent match refuses rather than guesses.
      if (isExactReplaceFinalizedSessionCommand(text)) {
        const started = await startFinalizedSessionReplacementDraft(
          this.supabase,
          pendingService,
          pending,
          event.timestamp,
        );
        log.info("produce finalized session replacement requested", {
          sessionKey,
          sessionGeneration: pending.session_generation,
          status: started.status,
          predecessorSessionId: started.status === "started" ? started.predecessorSessionId : null,
        });
        if (replyToken) {
          await this.replyMessage(replyToken, replacementDraftCommandReply(started));
        }
        return { eventId, eventType: event.type, status: "saved", parsed: true };
      }

      if (isIncompleteProduceCloser(text)) {
        log.info("incomplete Produce closer intercepted", { sessionKey, text });
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            incompleteCloserReply(pending.accumulated_text),
          );
        }
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      let markClose = hasSessionEnd(normalizedText);
      const expectedItemCount = markClose
        ? parseExpectedItemCount(normalizedText)
        : null;
      const incomingHeader = findProduceSessionHeader(normalizedText);

      // 0049: a structured session was opened by a typed command and its
      // metadata is immutable. A textual header must not rotate it, and must
      // not be appended, admitted or ingested — refuse before any of that runs.
      // Legacy rows have entry_origin NULL and are unaffected.
      if (
        incomingHeader
        && (pending as StructuredPendingSession).entry_origin != null
      ) {
        log.warn("text header refused for structured produce session", {
          sessionKey,
          sessionGeneration: pending.session_generation,
        });
        if (replyToken) await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      // 0050 H-1: plain-text close must not markClose a structured session.
      // Exact "จบรายการ" for entry_origin=structured_menu is handled above via
      // the guided requestClose contract; any other non-null origin still refuses.
      if (
        markClose
        && (pending as StructuredPendingSession).entry_origin != null
      ) {
        log.warn("text close refused for structured produce session", {
          sessionKey,
          sessionGeneration: pending.session_generation,
        });
        if (replyToken) {
          await this.replyMessage(replyToken, STRUCTURED_TEXT_CLOSE_REFUSED_REPLY);
        }
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      // A close-looking line is only a boundary when it belongs to this main
      // session. Refuse before append/bind/close so the generation and its
      // accumulated items remain byte-for-byte unchanged.
      const closerRefusal = markClose
        ? mainCloserRefusal(incomingHeader ? normalizedText : pending.accumulated_text, normalizedText)
        : null;
      if (closerRefusal) {
        log.warn("cross-type main Produce closer refused", {
          sessionKey,
          sessionGeneration: pending.session_generation,
          activeType: closerRefusal.activeType,
        });
        if (replyToken) await this.replyMessage(replyToken, closerRefusal.message);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      if (
        incomingHeader
        && !pending.terminalized
        && pending.close_event_timestamp_ms !== null
      ) {
        if (replyToken) await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      // P4A completion: the entry gate runs on the plain-text close BEFORE the
      // immutable close boundary is written. A refusal therefore leaves the
      // session in capture with its original header and business date, where
      // the corrected line is still an ordinary item message. The refused
      // closer remains event evidence but is not appended to the business
      // document. Only the ordinary append path is gated: a message that
      // carries a header AND a closer rotates to a new generation, and the
      // review it would record would belong to the generation it replaced.
      let closeGateRefusal: PlainTextCloseGateRefusal | null = null;
      // The exact ingest_revision the entry gate inspected. The close boundary
      // must be stamped against THIS document or not at all: on 2026-08-30 a
      // legitimate pre-close item committed between the gate and the append,
      // the boundary landed on a document the gate never saw, and the finalizer
      // later terminalized the session for a review that was never presented.
      let closeGatePinnedRevision: number | undefined;
      if (
        markClose
        && !incomingHeader
        && (pending as StructuredPendingSession).entry_origin == null
      ) {
        closeGateRefusal = await this.runPlainTextCloseGate(
          pending,
          text,
          eventId,
          log,
        );
        if (closeGateRefusal) markClose = false;
        else closeGatePinnedRevision = pending.ingest_revision ?? undefined;

        // The gate just passed on a session that ALREADY has a close boundary,
        // so this is the distinct later close that confirms a review the
        // finalizer parked. hold_pending_validation_review set next_attempt_at
        // to NULL; without this the confirmed session would sit held forever,
        // because no sweep can see a closed row with no attempt scheduled.
        if (!closeGateRefusal && pending.close_event_timestamp_ms !== null) {
          try {
            const resumed = await pendingService.resumeCloseFinalization(
              sessionKey,
              pending.session_generation,
            );
            log.info("produce finalization resumed after review confirmation", {
              sessionKey,
              sessionGeneration: pending.session_generation,
              resumed,
            });
          } catch (resumeError) {
            // The confirmation itself is already committed. A failed resume
            // costs a delay, not the confirmation — and never terminalizes.
            log.error("produce finalization resume failed", {
              sessionKey,
              error: String(resumeError),
            });
          }
        }
      }

      let updated;
      if (closeGateRefusal) {
        // A closer is control-plane input, not part of the Produce document.
        // Keeping a refused closer out of accumulated_text makes the review
        // digest stable across the two-close protocol. The event itself is
        // still durably captured by raw_messages and mark_plain_text_close_refused.
        // Transport activity still belongs to this event. The service update
        // is generation-scoped in the UPDATE predicate, so a close that raced
        // a replacement cannot touch the replacement row.
        updated = await pendingService.touchControlActivity(
          sessionKey,
          pending.session_generation,
          replyToken ?? null,
        );
        if (!updated) {
          log.warn("refused Produce close lost generation race", {
            sessionKey,
            staleSessionGeneration: pending.session_generation,
            lineEventId: eventId,
          });
          if (replyToken) await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
          return { eventId, eventType: event.type, status: "saved", parsed: false };
        }
      } else if (
        incomingHeader
        && (
          pending.terminalized
          || (
            pending.close_refused_at != null
            && pending.close_refused_session_generation === pending.session_generation
          )
          || requiresFreshPendingGeneration(pending.accumulated_text, incomingHeader)
        )
      ) {
        try {
          const opened = await pendingService.openPlainTextGeneration({
            sessionKey,
            sourceId,
            expectedSessionGeneration: pending.session_generation,
            text,
            replyToken,
            lineUserId: lineUserId!,
            lineEventId: eventId,
            lineTimestampMs: event.timestamp,
            markClose,
            expectedItemCount: expectedItemCount ?? undefined,
          });
          updated = opened.session;

          if (!opened.opened || !updated) {
            log.warn("pending session generation replacement lost concurrency race", {
              sessionKey,
              staleSessionGeneration: pending.session_generation,
              reason: opened.reason,
            });
            if (replyToken) {
              await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
            }
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }

          log.info("pending session generation replaced by new header", {
            sessionKey,
            staleSessionGeneration: pending.session_generation,
            replacementSessionGeneration: updated.session_generation,
            incomingHeader,
            markClose,
            reconciledCount: opened.reconciled_count ?? 0,
          });
        } catch (replaceError) {
          const errorMessage = replaceError instanceof Error
            ? replaceError.message
            : String(replaceError);
          log.error("pending session generation replacement failed", {
            sessionKey,
            staleSessionGeneration: pending.session_generation,
            error: errorMessage,
          });
          if (replyToken) {
            try {
              await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
            } catch (replyError) {
              log.error("pending session replacement fail-closed reply failed", {
                error: String(replyError),
              });
            }
          }
          return { eventId, eventType: event.type, status: "saved", parsed: false };
        }
        if (!markClose && replyToken) {
          const notice = await retainedBundleNotice(pendingService, sessionKey);
          if (notice) {
            await this.replyMessage(replyToken, notice);
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }
        }
      } else if (
        (pending as StructuredPendingSession).entry_origin == null
        && !incomingHeader
        && !markClose
        && hasItemLine(normalizedText)
        && pending.plain_text_opened_line_timestamp_ms != null
      ) {
        try {
          const reordered = await pendingService.appendOrDeferProduceItem({
            rawMessageId,
            sessionKey,
            sourceId,
            lineUserId: lineUserId!,
            lineEventId: eventId,
            lineTimestampMs: event.timestamp,
            text,
            replyToken: replyToken ?? null,
          });
          log.info("Produce reorder admission completed", {
            action: reordered.action,
            sourceId,
            lineUserId,
            lineEventId: eventId,
            lineTimestampMs: event.timestamp,
            sessionKey,
            sessionGeneration: reordered.session_generation ?? pending.session_generation,
            openerEventId: pending.plain_text_opened_line_event_id ?? null,
            openerTimestampMs: pending.plain_text_opened_line_timestamp_ms,
            closeEventId: pending.close_line_event_id,
            closeTimestampMs: pending.close_event_timestamp_ms,
          });
          if (
            reordered.action === "rejected_before_opener"
            || reordered.action === "rejected_after_close"
            || reordered.action === "rejected_orphan"
            || reordered.action === "deferred"
          ) {
            if (replyToken) {
              await this.replyMessage(
                replyToken,
                await rejectedBundleNotice(
                  pendingService,
                  sessionKey,
                  deferredRejectReason(reordered.action),
                ),
              );
            }
          } else if (draftItemCommand && reordered.session && replyToken) {
            const action = latestDraftItemAction(
              parseWeighSession(reordered.session.accumulated_text, bangkokToday()),
            );
            if (action) {
              await this.replyMessage(replyToken, buildDraftItemActionReply(action));
            }
          }
          return { eventId, eventType: event.type, status: "saved", parsed: false };
        } catch (reorderError) {
          const errorMessage = reorderError instanceof Error
            ? reorderError.message
            : String(reorderError);
          log.error("Produce reorder admission failed", {
            sessionKey,
            lineEventId: eventId,
            error: errorMessage,
          });
          return {
            eventId,
            eventType: event.type,
            status: "error",
            parsed: false,
            error: errorMessage,
          };
        }
      } else {
        try {
          updated = await pendingService.append(
            sessionKey, text, replyToken, eventId, event.timestamp, markClose,
            pending.session_generation, expectedItemCount ?? undefined,
            closeGatePinnedRevision,
          );
          const appendParse = parseWeighSession(updated.accumulated_text, bangkokToday());
          log.info("pending session append succeeded", {
            sessionKey,
            appendSuccess: true,
            markClose,
            parsedItemCount: appendParse.items.length,
            parseErrorCount: appendParse.parse_errors.length,
          });
          for (const parseError of appendParse.parse_errors) {
            log.warn("pending session parse error after append", {
              sessionKey,
              rawLine: parseError,
            });
          }
        } catch (appendError) {
          // The document grew between the entry gate and the close boundary.
          // No boundary was stamped and no content was lost, so this is a
          // retry, not a failure: the operator closes again and the gate then
          // validates the complete list.
          if (appendError instanceof PendingSessionStaleValidationSnapshotError) {
            log.warn("produce close refused — validation snapshot was stale", {
              sessionKey,
              sessionGeneration: pending.session_generation,
              expectedIngestRevision: appendError.expectedRevision,
              currentIngestRevision: appendError.currentRevision,
              lineEventId: eventId,
            });
            if (replyToken) {
              try {
                await this.replyMessage(replyToken, CLOSE_RACED_LATE_ITEM_REPLY);
              } catch (replyError) {
                log.error("stale close reply failed", { error: String(replyError) });
              }
            }
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }
          if (
            appendError instanceof PendingSessionGenerationConflictError
            || appendError instanceof PendingSessionClosedError
          ) {
            log.warn("pending session append rejected — generation conflict", {
              sessionKey,
              staleSessionGeneration: pending.session_generation,
              error: appendError.message,
            });
            if (replyToken) {
              try {
                await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
              } catch (replyError) {
                log.error("generation conflict reply failed", { error: String(replyError) });
              }
            }
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }
          if (appendError instanceof PendingSessionAfterCloseBoundaryError) {
            log.info("pending session item rejected after immutable close boundary", {
              sessionKey,
              sessionGeneration: pending.session_generation,
              lineTimestampMs: event.timestamp,
              closeEventTimestampMs: pending.close_event_timestamp_ms,
            });
            if (typeof rawMessageId === "string" && lineUserId) {
              try {
                await pendingService.recordBoundaryRejectedProduceItem({
                  rawMessageId,
                  sessionKey,
                  sourceId,
                  lineUserId,
                  lineEventId: eventId,
                  lineTimestampMs: event.timestamp,
                  text,
                  replyToken: replyToken ?? null,
                  status: "rejected_after_close",
                  sessionGeneration: pending.session_generation,
                  closeLineEventId: pending.close_line_event_id,
                  closeLineTimestampMs: pending.close_event_timestamp_ms,
                });
              } catch (recordError) {
                log.error("after-close rejected Produce evidence persist failed", {
                  sessionKey,
                  lineEventId: eventId,
                  error: recordError instanceof Error
                    ? recordError.message
                    : String(recordError),
                });
              }
            }
            if (replyToken) {
              try {
                await this.replyMessage(
                  replyToken,
                  await rejectedBundleNotice(pendingService, sessionKey, "after_close"),
                );
              } catch (replyError) {
                log.error("after-boundary rejection reply failed", {
                  error: String(replyError),
                });
              }
            }
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }
          const errorMessage = appendError instanceof Error
            ? appendError.message
            : String(appendError);
          log.error("pending session append failed", {
            sessionKey,
            appendSuccess: false,
            error: errorMessage,
          });
          return {
            eventId,
            eventType: event.type,
            status: "error",
            parsed: false,
            error: errorMessage,
          };
        }
      }

      if (!markClose) {
        if (closeGateRefusal) {
          // P1-B: a VALID close was received and refused. The session stays in
          // capture on purpose — that is the correction window — but the refusal
          // must be durable, or this generation waits forever with
          // close_requested_at NULL and nothing scheduled, which is exactly the
          // state Production pending 313eaa61 has been sitting in.
          //
          // Best-effort: the refusal reply below is what the operator acts on,
          // and a failed stamp must not swallow it.
          //
          // Both failure shapes are handled deliberately. A Supabase RPC
          // RESOLVES with `{ data, error }` — it does not throw on a PostgREST
          // error — so try/catch alone would report a failed stamp as a
          // success and leave the generation strandable with nothing in the
          // log to say so. The catch remains for transport-level throws.
          try {
            const { data, error } = await this.supabase.rpc(
              "mark_plain_text_close_refused",
              {
                p_session_key: sessionKey,
                p_session_generation: pending.session_generation,
                p_close_line_event_id: eventId,
                p_reason: "entry_gate_refusal",
              },
            );
            if (error) {
              log.error("plain-text close refusal stamp rejected", {
                sessionKey,
                sessionGeneration: pending.session_generation,
                error: error.message,
              });
            } else {
              const marked = (data as { marked?: boolean; reason?: string } | null) ?? null;
              if (marked?.marked !== true) {
                // A refusal the database declined to record — for example a
                // generation that rotated underneath us. Not an error, but it
                // must be visible, because the recovery sweep will not see it.
                log.warn("plain-text close refusal not stamped", {
                  sessionKey,
                  sessionGeneration: pending.session_generation,
                  reason: marked?.reason ?? "unknown",
                });
              }
            }
          } catch (markError) {
            log.error("plain-text close refusal stamp failed", {
              sessionKey,
              sessionGeneration: pending.session_generation,
              error: markError instanceof Error ? markError.message : String(markError),
            });
          }
          if (replyToken) {
            let delivered = false;
            try {
              // One reply carries every page, so delivery is all-or-nothing:
              // the operator either sees the whole presentation or none of it.
              const texts = [
                closeGateRefusal.refusalText,
                ...(closeGateRefusal.refusalPages ?? []),
              ];
              if (texts.length > 1) await this.replyMessages(replyToken, texts);
              else await this.replyMessage(replyToken, texts[0]);
              delivered = true;
            } catch (replyError) {
              log.error("produce entry gate refusal reply failed", {
                error: String(replyError),
              });
            }

            // Delivery proof is written ONLY here, after the reply actually
            // succeeded. Recording the review earlier proved nothing: this
            // reply is a separate network call that is caught and logged, so a
            // failed one must leave the review unconfirmable and force a
            // re-presentation rather than letting the next close approve
            // financial content nobody saw.
            //
            // eventId becomes the row's presenting identity, taking over from
            // whichever event recorded it. Without that, a duplicate delivery
            // of THIS close would look like a distinct later event and
            // self-confirm a review shown exactly once.
            if (delivered && closeGateRefusal.reviewPresentation) {
              const { digests, sessionGeneration } = closeGateRefusal.reviewPresentation;
              try {
                // One message, one all-or-nothing mark: the whole review plus
                // every risky-subunit row it rendered. #109 confirms those item
                // digests individually, so leaving them unmarked would make
                // "ยืนยันข้อ N" answer not_presented for something the operator
                // is looking at.
                const presented = await markProduceValidationReviewsPresented(
                  this.supabase,
                  {
                    sessionKey: sessionKey,
                    sessionGeneration,
                    accountabilityRoundId: null,
                    businessDate: null,
                    marketLabel: null,
                    staffLabel: null,
                    lineUserId: pending.line_user_id,
                  },
                  digests,
                  eventId,
                );
                if (presented.status !== "presented") {
                  // The operator saw it, but the database cannot prove it.
                  // Fail safe: it stays unconfirmable and is shown again.
                  log.warn("review presentation could not be proven", {
                    sessionKey,
                    sessionGeneration,
                    presented,
                  });
                }
              } catch (markError) {
                log.error("review presentation stamp failed", {
                  sessionKey,
                  sessionGeneration,
                  error: markError instanceof Error ? markError.message : String(markError),
                });
              }
            }
          }
          return { eventId, eventType: event.type, status: "saved", parsed: false };
        }
        const structured = pending as StructuredPendingSession;
        if (draftItemCommand && structured.entry_origin == null && replyToken) {
          const action = latestDraftItemAction(
            parseWeighSession(updated.accumulated_text, bangkokToday()),
          );
          if (action) {
            await this.replyMessage(replyToken, buildDraftItemActionReply(action));
            return { eventId, eventType: event.type, status: "saved", parsed: false };
          }
        }
        if (structured.entry_origin === "structured_menu" && replyToken) {
          const identity = buildGuidedMenuIdentity({
            lineUserId: getUserId(msgEvent.source),
            sourceType: msgEvent.source.type,
            sourceId: getSourceId(msgEvent.source),
            sessionKey: pendingSessionKey,
          });
          if (identity) {
            const ack = await this.guidedMenuHandler.renderCaptureAcknowledgement({
              identity,
              preferDraftItemAction: draftItemCommand !== null,
            });
            if (ack) {
              await this.replyApiMessages(
                replyToken,
                ack.messages as LineApiMessage[],
              );
              log.info("guided capture acknowledgement sent", {
                sessionKey,
                itemCount: ack.result.item_count,
              });
              return { eventId, eventType: event.type, status: "saved", parsed: false };
            }
          }
        }
        log.debug("message appended to pending session — waiting for session end", { sessionKey });
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      log.info("pending session end command received", {
        sessionKey,
        endCommandReceived: true,
        sessionGeneration: updated.session_generation,
        expectedItemCount,
        nextAttemptAt: updated.next_attempt_at,
        closeDeadlineAt: updated.close_deadline_at,
      });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, PRODUCE_CLOSE_PENDING_REPLY);
        } catch (replyError) {
          log.error("additional close acknowledgement failed", {
            error: String(replyError),
          });
        }
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    // ── 5. No active pending session ──────────────────────────────────────────

    // 5.0. "ยกเลิกรายการ" with nothing to cancel. Handled on this same produce
    // path — not behind a new early gate above the lookup — so it stays one
    // interception point with one resolver. ZERO database mutation: there is
    // no draft, so there is nothing to write, and the command must not fall
    // through to the legacy parse path either.
    if (isExactCancelActiveDraftCommand(text)) {
      log.info("produce draft cancellation requested with no active draft", { sessionKey });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, CANCEL_ACTIVE_DRAFT_NONE_REPLY);
        } catch (replyError) {
          log.error("produce draft cancellation reply failed", { error: String(replyError) });
        }
      }
      return { eventId, eventType: event.type, status: "saved", parsed: true };
    }

    if (isExactRecoverLatestCommand(text)) {
      log.info("produce boundary recovery requested with no open header", { sessionKey });
      if (replyToken) {
        await this.replyMessage(replyToken, recoverCommandReply({ status: "no_header" }));
      }
      return { eventId, eventType: event.type, status: "saved", parsed: true };
    }

    if (isExactReplaceFinalizedSessionCommand(text)) {
      log.info("produce finalized session replacement requested with no open header", { sessionKey });
      if (replyToken) {
        await this.replyMessage(replyToken, replacementDraftCommandReply({ status: "no_header" }));
      }
      return { eventId, eventType: event.type, status: "saved", parsed: true };
    }

    // Uses the same strict header predicate as rotation (findProduceSessionHeader)
    // so creation and rotation always agree on what counts as a valid header.
    const incomingSessionHeader = findProduceSessionHeader(normalizedText);
    if (incomingSessionHeader !== null) {
      const closerRefusal = hasSessionEnd(normalizedText)
        ? mainCloserRefusal(normalizedText, normalizedText)
        : null;
      if (closerRefusal) {
        log.warn("cross-type main Produce closer refused before session open", {
          sessionKey,
          activeType: closerRefusal.activeType,
        });
        if (replyToken) await this.replyMessage(replyToken, closerRefusal.message);
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      }

      if (RE.ADDITIONAL_HEADER.test(incomingSessionHeader)) {
        // Additional batches never take the legacy direct parser/persist path —
        // even a pasted complete block goes through pending generation →
        // deferred finalizer → authoritative RPC → notification outbox.
        return this.startAdditionalPendingSession(
          msgEvent, pendingService, sessionKey, sourceId, lineUserId,
          text, normalizedText, eventId, log,
        );
      }

      const complete = hasSessionEnd(normalizedText) || hasItemLine(normalizedText);

      // A pasted complete document takes the same route as a multi-message one.
      //
      // Closing the P4A bypass: the legacy direct path below writes
      // produce_sessions with no pending row, so bindPlainTextRound and the
      // entry gate never see it. On 2026-08-11 operators started pasting whole
      // documents and Production took 20 sessions with accountability_round_id
      // NULL, unchecked product names (กล้วหว้า/น้ำว้า) and unchecked units
      // (แพค/กล่อง) — all answered บันทึกแล้ว ✅.
      //
      // The seller-market header is exactly the condition that makes a document
      // bindable: without it the round contract has no seller and no market, so
      // the remaining legacy shapes (a pasted LINE export, "รายการชั่งเบิกไปตลาด")
      // would be `unbound` however they were routed, and keep the direct path
      // with its immediate validation evidence, dedup and reply.
      if (RE.SELLER_MARKET.test(incomingSessionHeader) && complete) {
        log.info("complete produce document detected — routing through pending generation", {
          sessionKey,
          hasCloser: hasSessionEnd(normalizedText),
        });
        return this.startAdditionalPendingSession(
          msgEvent, pendingService, sessionKey, sourceId, lineUserId,
          text, normalizedText, eventId, log,
        );
      }

      if (complete) {
        // Legacy single-message, no seller-market identity → parse directly.
        log.info("single complete message detected (has SESSION_END or items), parsing directly");
        return this.runParser(msgEvent, rawMessageId, eventId, event.type, log);
      }

      // Header-only → start accumulating (store raw text so parser sees TIME_PREFIX sender)
      log.info("session header detected — starting pending session", { sessionKey });
      try {
        const opened = await pendingService.openPlainTextGeneration({
          sessionKey,
          sourceId,
          lineUserId: lineUserId!,
          lineEventId: eventId,
          lineTimestampMs: event.timestamp,
          text,
          replyToken: replyToken ?? null,
          markClose: false,
        });
        if (!opened.opened) throw new Error(opened.reason);
        log.info("plain-text pending opener committed", {
          action: opened.reconciled_count ? "reconciled" : "opened",
          sessionKey,
          sessionGeneration: opened.session?.session_generation,
          openerEventId: eventId,
          openerTimestampMs: event.timestamp,
          reconciledCount: opened.reconciled_count ?? 0,
        });
      } catch (createErr) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr);
        log.error("pending session create failed", { sessionKey, error: msg });
        return {
          eventId,
          eventType: event.type,
          status: "error",
          parsed: false,
          error: msg,
        };
      }
      if (replyToken) {
        const notice = await retainedBundleNotice(pendingService, sessionKey);
        if (notice) await this.replyMessage(replyToken, notice);
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (hasSessionEnd(normalizedText)) {
      log.warn("SESSION_END received without active pending session", { sessionKey });
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    if (hasItemLine(normalizedText)) {
      try {
        const reordered = await pendingService.appendOrDeferProduceItem({
          rawMessageId,
          sessionKey,
          sourceId,
          lineUserId: lineUserId!,
          lineEventId: eventId,
          lineTimestampMs: event.timestamp,
          text,
          replyToken: replyToken ?? null,
        });
        log.info("Produce item persisted for bounded reorder", {
          action: reordered.action,
          sourceId,
          lineUserId,
          lineEventId: eventId,
          lineTimestampMs: event.timestamp,
          sessionKey,
          sessionGeneration: reordered.session_generation ?? null,
        });
        if (reordered.action !== "admitted"
            && reordered.action !== "reconciled" && replyToken) {
          await this.replyMessage(
            replyToken,
            await rejectedBundleNotice(
              pendingService,
              sessionKey,
              deferredRejectReason(reordered.action),
            ),
          );
        }
        return { eventId, eventType: event.type, status: "saved", parsed: false };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Produce item defer failed", { sessionKey, eventId, error: errorMessage });
        return {
          eventId,
          eventType: event.type,
          status: "error",
          parsed: false,
          error: errorMessage,
        };
      }
    }

    log.debug("no parser matched text message — left unprocessed");
    return { eventId, eventType: event.type, status: "saved", parsed: false };
  }

  private async tryProcessPhysicalInventory(
    event: LineMessageEvent,
    text: string,
    lineMessageId: string,
    rawMessageId: string,
    eventId: string,
    eventType: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult | null> {
    if (event.source.type !== "group") return null;

    const sourceId = getSourceId(event.source);
    if (!isPhysicalInventoryLineGroupAllowed(sourceId)) return null;

    const standaloneIntent = classifyPhysicalInventoryStandaloneIntent(text);
    const senderLineUserId = getUserId(event.source);
    if (!senderLineUserId) {
      if (standaloneIntent === "header") {
        log.warn("Physical Inventory header ignored — group sender is missing", {
          sourceId,
        });
        return { eventId, eventType, status: "saved", parsed: false };
      }
      return null;
    }

    let ownership;
    try {
      ownership = await this.dataEntrySessionOwnershipResolver.resolve({
        source: event.source,
        sourceId,
        senderLineUserId,
      });
    } catch (error) {
      log.error("interactive data-entry ownership lookup failed", {
        sourceId,
        senderLineUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fail closed for P2A while preserving the established legacy router.
      return null;
    }

    if (ownership.hasOverlap) {
      log.warn("interactive data-entry session overlap detected", {
        sourceId,
        senderLineUserId,
        legacyKinds: ownership.legacyKinds,
        physicalInventorySessionId: ownership.physicalInventorySession?.id,
        legacyProduceSessionId: ownership.legacyProduceSession?.id ?? null,
        legacyManualSlipSessionId: ownership.legacyManualSlipSession?.id ?? null,
      });
    }

    const incomingLegacyHeader =
      findProduceSessionHeader(normalizeText(text)) !== null
      || RE.MANUAL_SLIP_OPEN.test(text);
    if (
      incomingLegacyHeader
      && ownership.physicalInventorySession
      && !ownership.hasLegacySession
    ) {
      await this.markRawMessageProcessed(rawMessageId, log);
      if (event.replyToken) {
        await this.replyMessage(
          event.replyToken,
          "มีรายการสต๊อกผลไม้กำลังเปิดอยู่ กรุณาปิดรายการสต๊อกก่อนเริ่มรายการอื่น",
        );
      }
      log.info("legacy data-entry session open blocked by Physical Inventory owner", {
        sourceId,
        senderLineUserId,
        physicalInventorySessionId: ownership.physicalInventorySession.id,
      });
      return { eventId, eventType, status: "saved", parsed: false };
    }

    // Existing legacy ownership always wins, including defensive overlap.
    // Returning null preserves the established legacy router unchanged.
    if (ownership.hasLegacySession) return null;

    const service = this.physicalInventoryService;
    const replyToken = event.replyToken;

    if (standaloneIntent === "header") {
      const parsed = parsePhysicalInventoryDocument(text, { requireUnitPrice: true });
      try {
        const opened = await service.openSession({
          sourceType: "group",
          sourceId,
          senderLineUserId,
          openedLineEventId: eventId,
          lineTimestampMs: event.timestamp,
          rawText: text,
          lineMessageId,
          rawMessageId,
          businessDate: parsed.businessDate,
          parserVersion: isPricedPhysicalInventoryHeaderText(parsed.headerText)
            ? HOUSE_STOCK_PRICED_PARSER_VERSION
            : PHYSICAL_INVENTORY_PARSER_VERSION,
        });
        const closesInline = Boolean(parsed.closeText);
        if (closesInline && !service.closeOpenEvent) {
          throw new Error("inline Physical Inventory close is unavailable");
        }
        const activeSession = closesInline
          ? await service.closeOpenEvent!({
            sessionId: opened.session.id,
            expectedGeneration: opened.session.session_generation,
            openedLineEventId: eventId,
          })
          : opened.session;
        if (!closesInline) await this.markRawMessageProcessed(rawMessageId, log);

        if (replyToken && opened.opened && !opened.idempotent && !closesInline) {
          const businessDate = parsed.businessDate ?? opened.session.business_date;
          if (
            parsed.explicitEmpty
            && isPricedPhysicalInventoryHeaderText(parsed.headerText)
          ) {
            await this.replyMessage(replyToken, buildHouseStockExplicitEmptyAck(businessDate));
          } else {
            const displayDate = businessDate
              ? formatPhysicalInventoryBusinessDate(businessDate)
              : null;
            await this.replyMessage(
              replyToken,
              displayDate
                ? `เริ่มบันทึกสต๊อกผลไม้คงเหลือวันที่ ${displayDate} แล้ว`
                : "เริ่มรายการแล้ว แต่ไม่พบวันที่ที่ถูกต้อง กรุณาตรวจสอบวันที่ก่อนปิดรายการ",
            );
          }
        }

        if (closesInline) {
          this.scheduleBackgroundTask(async () => {
            await this.physicalInventoryFinalizer({
              sessionId: activeSession.id,
              expectedGeneration: activeSession.session_generation,
            });
          });
        }

        log.info("Physical Inventory session opened", {
          sourceId,
          senderLineUserId,
          sessionId: opened.session.id,
          sessionGeneration: opened.session.session_generation,
          opened: opened.opened,
          idempotent: opened.idempotent,
        });
        return { eventId, eventType, status: "saved", parsed: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Physical Inventory open failed", { sourceId, error: message });
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            "เริ่มรายการสต๊อกผลไม้ไม่สำเร็จ กรุณาลองอีกครั้ง",
          );
        }
        return {
          eventId,
          eventType,
          status: "error",
          parsed: false,
          error: message,
        };
      }
    }

    const session = ownership.physicalInventorySession;
    if (!session) return null;

    // Recognize items in the session's own parser mode only. Trying both
    // modes unconditionally let Produce-priced text (e.g. "80บาท") leak
    // into an unpriced session once no-space house-stock prices were
    // supported below — the two syntaxes are only distinguishable by which
    // parser the open session actually uses.
    const usesPricedParser = session.parser_version === HOUSE_STOCK_PRICED_PARSER_VERSION;
    const parseOptions = { requireUnitPrice: usesPricedParser };
    const close = matchesPhysicalInventoryCloseLine(text);
    const skipUnpricedSellingPriceText =
      !usesPricedParser && /บาท/u.test(text.normalize("NFC"));
    const emptyDeclaration = usesPricedParser && isExplicitEmptyHouseStockDeclaration(text);
    const item = !close && !skipUnpricedSellingPriceText
      && (emptyDeclaration || isRecognizedPhysicalInventoryItemBlock(text, parseOptions));

    if (!close && !item) {
      const attempt = skipUnpricedSellingPriceText
        ? null
        : parsePhysicalInventoryDocument(text, parseOptions);
      if (!attempt || attempt.items.length === 0) return null;

      // The text was clearly meant as an item line (it parsed into at
      // least one item-shaped observation) but failed validation. Report
      // it plainly instead of silently swallowing it or falling through to
      // the unrelated legacy Produce router — the session stays open and
      // the sender can resend a corrected line.
      await this.markRawMessageProcessed(rawMessageId, log);
      if (replyToken) {
        const failedSequence =
          attempt.items.find((it) => it.resolutionStatus === "REJECTED")?.sequence
          ?? attempt.items[0]?.sequence
          ?? null;
        try {
          await this.replyMessage(
            replyToken,
            buildPhysicalInventoryItemParseFailureReply(failedSequence),
          );
        } catch (e) {
          log.error("physical inventory item parse-failure reply failed", { error: String(e) });
        }
      }
      log.info("Physical Inventory item failed to parse — session remains open", {
        sourceId,
        senderLineUserId,
        sessionId: session.id,
      });
      return { eventId, eventType, status: "saved", parsed: false };
    }

    if (!close && service.listIngestTexts) {
      const prior = parsePhysicalInventoryDocument(
        (await service.listIngestTexts(session.id)).join("\n"),
        parseOptions,
      );
      const priorHasItems = prior.items.some(
        (it) =>
          it.resolutionStatus === "ACCEPTED_NORMALIZED"
          || it.resolutionStatus === "ACCEPTED_RAW",
      );
      const contradictory = emptyDeclaration
        ? priorHasItems
        : prior.explicitEmpty;
      if (contradictory) {
        await this.markRawMessageProcessed(rawMessageId, log);
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            emptyDeclaration ? HOUSE_STOCK_ITEM_THEN_EMPTY_REPLY : HOUSE_STOCK_EMPTY_THEN_ITEM_REPLY,
          );
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }
    }

    try {
      const admitted = await service.registerIngest({
        sessionId: session.id,
        expectedGeneration: session.session_generation,
        lineEventId: eventId,
        lineTimestampMs: event.timestamp,
        lineMessageId,
        rawMessageId,
        kind: close ? "close" : "item",
        rawText: text,
      });
      // Item evidence is fully handled once admitted. The close raw-message
      // marker is deliberately held until the terminal LINE push is accepted;
      // that gives the recovery worker a durable delivery checkpoint.
      if (!close) await this.markRawMessageProcessed(rawMessageId, log);

      if (emptyDeclaration && replyToken) {
        const businessDate = session.business_date;
        try {
          await this.replyMessage(replyToken, buildHouseStockExplicitEmptyAck(businessDate));
        } catch (e) {
          log.error("physical inventory explicit-empty ack failed", { error: String(e) });
        }
      }

      if (close) {
        this.scheduleBackgroundTask(async () => {
          await this.physicalInventoryFinalizer({
            sessionId: admitted.session.id,
            expectedGeneration: admitted.session.session_generation,
          });
        });
      }

      log.info("Physical Inventory event admitted", {
        sourceId,
        senderLineUserId,
        sessionId: admitted.session.id,
        sessionGeneration: admitted.session.session_generation,
        kind: close ? "close" : "item",
        accepted: admitted.accepted,
        inserted: admitted.inserted,
        reason: admitted.reason,
      });
      return { eventId, eventType, status: "saved", parsed: true };
    } catch (error) {
      if (
        error instanceof PhysicalInventoryAfterCloseBoundaryError
        || error instanceof PhysicalInventoryAfterCloseError
        || error instanceof PhysicalInventoryGenerationConflictError
      ) {
        await this.markRawMessageProcessed(rawMessageId, log);
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            error instanceof PhysicalInventoryAfterCloseBoundaryError
              ? "รายการนี้ส่งหลังคำสั่งจบ จึงไม่ถูกรวมในสต๊อกที่ปิดแล้ว"
              : "รายการสต๊อกนี้ปิดแล้ว กรุณาเริ่มรายการใหม่",
          );
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const message = error instanceof Error ? error.message : String(error);
      log.error("Physical Inventory admission failed", {
        sourceId,
        senderLineUserId,
        sessionId: session.id,
        error: message,
      });
      return {
        eventId,
        eventType,
        status: "error",
        parsed: false,
        error: message,
      };
    }
  }

  // ── P2C Purchase Capture — LINE command/webhook routing ──────────────────
  // Delegates entirely to tryHandlePurchaseCaptureMessage, which is fail-closed
  // behind BOTH PURCHASE_CAPTURE_WEBHOOK_ENABLED and the
  // PURCHASE_CAPTURE_LINE_GROUP_IDS source allowlist. A `null` outcome means
  // "not mine" and the caller keeps routing to every other feature unchanged.
  private async tryProcessPurchaseCapture(
    event:         LineMessageEvent,
    text:          string,
    lineMessageId: string,
    rawMessageId:  string,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult | null> {
    const replyToken = event.replyToken;
    try {
      const outcome = await tryHandlePurchaseCaptureMessage(this.supabase, {
        sourceType: event.source.type,
        sourceId: getSourceId(event.source),
        senderLineUserId: getUserId(event.source),
        lineEventId: eventId,
        lineTimestampMs: event.timestamp,
        lineMessageId,
        rawMessageId,
        text,
      });
      if (outcome === null) return null;

      if (replyToken && outcome.replyTexts.length > 0) {
        try {
          if (outcome.replyTexts.length === 1) {
            await this.replyMessage(replyToken, outcome.replyTexts[0]);
          } else {
            await this.replyMessages(replyToken, outcome.replyTexts);
          }
        } catch (replyError) {
          log.error("purchase capture reply failed", {
            error: replyError instanceof Error ? replyError.message : String(replyError),
          });
        }
      }

      return { eventId, eventType, status: "saved", parsed: outcome.parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("purchase capture routing failed", { error: message });
      return { eventId, eventType, status: "error", parsed: false, error: message };
    }
  }

  /**
   * A bounded, single re-read barrier: did a same-generation append advance
   * ingest_revision while the entry gate was validating the snapshot it was
   * handed? A true answer means the document grew under the gate, so any
   * item-number gap it computed may be a straggler artefact rather than a lost
   * line. No polling and no sleep — one lookup. A read failure, a rotated
   * generation, or a missing row all return false, so the gate falls through to
   * its ordinary verdict and never swallows a genuine block.
   */
  private async closeSnapshotMovedUnderGate(
    pending: PendingSession,
    log:     ChildLogger,
  ): Promise<boolean> {
    try {
      const current = await new PendingSessionService(this.supabase).lookup(pending.session_key);
      const row = current.session;
      if (!row || row.session_generation !== pending.session_generation) return false;
      return (row.ingest_revision ?? 0) > (pending.ingest_revision ?? 0);
    } catch (error) {
      log.warn("close-gate snapshot recheck failed", {
        sessionKey: pending.session_key,
        error:      error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  // ── Additional produce batch: open (append-only, no direct persist) ──────
  // Creates a fresh pending generation for an additional batch and, when the
  // message already carries its closer, marks the close so the Release B
  // deferred finalizer picks it up. No produce rows are written here.
  /**
   * P4A on the plain-text close, before the close boundary exists.
   *
   * Returns the operator-facing refusal, or null to let the close proceed. The
   * round is bound first — without it there is no withdrawal master and every
   * return would validate against nothing. A parse-level failure returns null
   * on purpose: the deferred finalizer already reports those in its own words,
   * and calling a malformed line an "unknown product" would be misleading.
   *
   * Confirmable reviews use two closes: the first records and shows the
   * exception set; the second acknowledges exactly that set. Price differences
   * are advisories and do not enter this protocol.
   */
  /**
   * A close-gate refusal, plus what the caller needs to prove delivery.
   *
   * `reviewPresentation` is present ONLY for a confirmable review that was
   * recorded but not yet shown. Recording it is a database write; showing it is
   * a LINE reply that can fail, so the caller marks delivery only after that
   * reply succeeds. A blocking error carries no presentation — nothing about it
   * is confirmable, so it must never be stamped as a delivered review.
   */
  private async runPlainTextCloseGate(
    pending:   PendingSession,
    closeText: string,
    eventId:   string,
    log:       ChildLogger,
  ): Promise<PlainTextCloseGateRefusal | null> {
    const document = `${pending.accumulated_text}\n${closeText}`;
    const parsed = parseWeighSession(document, bangkokToday());
    if (getWeighSessionFinalizationErrors(parsed).length > 0) return null;

    try {
      const binding = await bindPlainTextRound(
        this.supabase,
        {
          sessionKey:        pending.session_key,
          sessionGeneration: pending.session_generation,
          sourceId:          pending.source_id,
          lineUserId:        pending.line_user_id,
        },
        parsed,
      );
      if (binding.status === "refused") {
        log.warn("plain-text accountability round binding refused", {
          sessionKey: pending.session_key,
          reason:     binding.reason,
        });
        return { refusalText: binding.detail };
      }

      const gateRef = {
        sessionKey:            pending.session_key,
        sessionGeneration:     pending.session_generation,
        accountabilityRoundId:
          binding.status === "bound" ? binding.accountabilityRoundId : null,
        businessDate:  parsed.date,
        marketLabel:   parsed.session_title,
        staffLabel:    parsed.staff_name,
        lineUserId:    pending.line_user_id,
      };
      const decision = await runProduceCloseGate(
        this.supabase,
        gateRef,
        parsed,
        eventId,
      );
      if (decision.decision === "blocked") {
        // Before committing to a definitive item-number-gap rejection, make one
        // bounded check that the document the gate just validated is still the
        // current one. The gate does real async work (round binding, master
        // read, review lookups); a legitimate same-generation item can commit
        // during that window and only an item-number gap can be FABRICATED by
        // such a straggler (see closeGapBlockIsStragglerFabricable). If the
        // snapshot grew under the gate, the "missing" numbers are in flight, not
        // lost — answer with the same recoverable copy the close-boundary race
        // uses (#108) instead of a false missing-item block. No boundary is
        // stamped, nothing is confirmed, and a genuine gap re-blocks on the next
        // close once ingest_revision has settled.
        if (
          closeGapBlockIsStragglerFabricable(decision.result)
          && await this.closeSnapshotMovedUnderGate(pending, log)
        ) {
          log.warn("produce close gap suppressed — snapshot grew under the entry gate", {
            sessionKey:        pending.session_key,
            sessionGeneration: pending.session_generation,
            snapshotRevision:  pending.ingest_revision,
          });
          return { refusalText: CLOSE_RACED_LATE_ITEM_REPLY };
        }
        // Not confirmable: no presentation to prove.
        return { refusalText: buildBlockingValidationReply(decision.result) };
      }
      if (decision.decision === "review_presented") {
        // Render first, then authorize only what the rendering shows. The set
        // is paginated rather than capped, so a session with more exceptions
        // than fit in one message still has a finite path to confirmation.
        const { pages, complete } = buildPlainTextReviewPresentationPages(
          decision.result,
          closeText,
        );
        return {
          refusalText: pages[0].text,
          refusalPages: pages.slice(1).map((page) => page.text),
          reviewPresentation: {
            digests: deliveredPresentationDigests(
              gateRef, decision.result, pages, complete, parsed,
            ),
            sessionGeneration: pending.session_generation,
          },
        };
      }
      return null;
    } catch (error) {
      // Fail closed. Validating a return against a master we failed to load
      // would pass everything, which is worse than making the operator retry.
      log.error("plain-text produce entry gate failed", {
        sessionKey: pending.session_key,
        error:      error instanceof Error ? error.message : String(error),
      });
      return { refusalText: PRODUCE_ENTRY_GATE_UNAVAILABLE_REPLY };
    }
  }

  /**
   * Seed a pending generation from one complete produce message.
   *
   * Used for a pasted additional batch and, since P4A completion, for any
   * complete main document, so that every plain-text produce session reaches
   * Produce through the same close boundary and deferred finalizer.
   */
  private async startAdditionalPendingSession(
    event:          LineMessageEvent,
    pendingService: PendingSessionService,
    sessionKey:     string,
    sourceId:       string,
    lineUserId:     string | null,
    text:           string,
    normalizedText: string,
    eventId:        string,
    log:            ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken ?? null;
    const markClose = hasSessionEnd(normalizedText);
    const expectedItemCount = markClose ? parseExpectedItemCount(normalizedText) : null;

    try {
      const opened = await pendingService.openPlainTextGeneration({
        sessionKey,
        sourceId,
        text,
        replyToken,
        lineUserId: lineUserId!,
        lineEventId: eventId,
        lineTimestampMs: event.timestamp,
        markClose,
        expectedItemCount: expectedItemCount ?? undefined,
      });
      const replaced = opened.session;
      if (!opened.opened || !replaced) {
        throw new Error(`additional pending session open refused: ${opened.reason}`);
      }

      log.info("additional produce session opened as pending generation", {
        sessionKey,
        sessionGeneration: replaced.session_generation,
        markClose,
        expectedItemCount,
        reconciledCount: opened.reconciled_count ?? 0,
      });

      if (markClose && replyToken) {
        try {
          await this.replyMessage(replyToken, PRODUCE_CLOSE_PENDING_REPLY);
        } catch (replyError) {
          log.error("produce close acknowledgement failed", {
            error: String(replyError),
          });
        }
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("additional pending session open failed", {
        sessionKey,
        error: errorMessage,
      });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, STALE_PRODUCE_SESSION_REPLY);
        } catch (replyError) {
          log.error("additional open fail-closed reply failed", {
            error: String(replyError),
          });
        }
      }
      return {
        eventId,
        eventType: event.type,
        status: "error",
        parsed: false,
        error: errorMessage,
      };
    }
  }

  // ── Manual slip session: open ─────────────────────────────────────────────
  private async processManualSlipOpen(
    event:         LineMessageEvent,
    dateStr:       string,
    marketLabel:   string | null,
    marketKey:     string,
    fullText:      string,
    lineMessageId: string,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId    = getSourceId(event.source);
    const lineUserId  = getUserId(event.source);
    const replyToken  = event.replyToken;
    const labelDisplay = marketLabel ?? "ไม่ระบุ";

    // Parse Buddhist date from captured string e.g. "17/06/2569"
    const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/((?:25)?\d{2})$/);
    if (!parts) {
      log.warn("manual slip open: invalid date string", { dateStr });
      if (replyToken) {
        await this.replyMessage(replyToken, "รูปแบบวันที่ไม่ถูกต้อง เช่น ส่งสลิปมือ 17/06/2569");
      }
      return { eventId, eventType, status: "saved", parsed: false };
    }
    const businessDate = parseBuddhistDate(parts[1], parts[2], parts[3]);

    log.info("manual slip open command", { sourceId, businessDate, marketKey });

    try {
      const svc    = new ManualSlipSessionService(this.supabase);
      const result = await svc.openSession({ sourceId, businessDate, marketKey, marketLabel, lineUserId, lineMessageId });

      if (!result.opened) {
        if (result.reason === "other_market_open") {
          // Another market's session is still open — block with clear message.
          const existingLabel = result.session?.market_label ?? result.session?.market_key ?? "ไม่ทราบ";
          log.info("manual slip open: blocked by other open session", { sourceId, existingLabel });
          if (replyToken) {
            await this.replyMessage(
              replyToken,
              `ยังมีสลิปมือของ ${existingLabel} ที่ยังไม่จบ กรุณาพิมพ์ จบสลิปมือ ก่อนเปิดตลาดใหม่`,
            );
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // reason === "same_market_exists"
        const session = result.session!;
        log.info("manual slip open: session already exists", { sourceId, businessDate, marketKey, status: session.status });

        if (session.status !== "open") {
          // Closed session — can't reopen.
          if (replyToken) {
            await this.replyMessage(
              replyToken,
              `มีสลิปมือสำหรับวันที่ ${dateStr} ของ ${labelDisplay} อยู่แล้ว (ปิดแล้ว)`,
            );
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // Existing open session — if this message carries amounts/close, reuse it.
        const { amounts, hasClose } = this.extractBatchLines(fullText);
        if (amounts.length === 0 && !hasClose) {
          if (replyToken) {
            await this.replyMessage(
              replyToken,
              `มีสลิปมือสำหรับวันที่ ${dateStr} ของ ${labelDisplay} อยู่แล้ว`,
            );
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        log.info("manual slip open: reusing existing open session", { sessionId: session.id });
        await this.processSessionBatch(
          svc, session.id, dateStr, amounts, hasClose,
          sourceId, businessDate, lineMessageId, lineUserId, replyToken, false, log,
        );
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // New session successfully opened.
      const { amounts, hasClose } = this.extractBatchLines(fullText);
      if (amounts.length > 0 || hasClose) {
        await this.processSessionBatch(
          svc, result.session!.id as string, dateStr, amounts, hasClose,
          sourceId, businessDate, lineMessageId, lineUserId, replyToken, true, log,
        );
      } else {
        if (replyToken) {
          await this.replyMessage(
            replyToken,
            `เปิดสลิปมือ ${dateStr} แล้ว\nส่งจำนวนเงินได้เลย เช่น\n1. 100 บาท\n2. 300 บาท\nพิมพ์ จบสลิปมือ เมื่อส่งครบ`,
          );
        }
      }
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("manual slip open failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "เปิดสลิปมือไม่สำเร็จ กรุณาลองอีกครั้ง");
        } catch { /* ignore reply error */ }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // Lines in fullText after the open-command line, parsed for amounts + close flag.
  private extractBatchLines(fullText: string): {
    amounts:  Array<{ rawLine: string; amount: number }>;
    hasClose: boolean;
  } {
    const lines   = fullText.split("\n");
    const openIdx = lines.findIndex(l => RE.MANUAL_SLIP_OPEN.test(l));
    const after   = openIdx >= 0 ? lines.slice(openIdx + 1) : [];
    return {
      amounts:  parseManualSlipAmounts(after.join("\n")),
      hasClose: after.some(l => RE.MANUAL_SLIP_CLOSE.test(l.trim())),
    };
  }

  // Append amounts + close if requested, then send the reply.
  // isNew: include "เปิดสลิปมือ…" prefix in the partial-amounts reply.
  private async processSessionBatch(
    svc:           ManualSlipSessionService,
    sessionId:     string,
    dateStr:       string,
    amounts:       Array<{ rawLine: string; amount: number }>,
    hasClose:      boolean,
    sourceId:      string,
    businessDate:  string,
    lineMessageId: string,
    lineUserId:    string | null,
    replyToken:    string | undefined,
    isNew:         boolean,
    log:           ChildLogger,
  ): Promise<void> {
    if (amounts.length > 0) {
      await svc.appendEntries({ sessionId, entries: amounts, lineMessageId, lineUserId });
    }
    if (hasClose) {
      const { total } = await svc.closeSession({ sessionId, lineUserId, lineMessageId });
      if (replyToken) {
        await this.replyMessage(
          replyToken,
          `จบสลิปมือ ${dateStr} แล้ว\nรับ ${amounts.length} รายการ รวม ${total.toLocaleString("th-TH")} บาท`,
        );
      }
      log.info("manual slip batch completed", { sessionId, total });
      tryFinalizeSettlement(this.supabase, sourceId, businessDate).catch(
        (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
      );
    } else if (amounts.length > 0) {
      const runTotal = amounts.reduce((s, a) => s + a.amount, 0);
      if (replyToken) {
        const prefix = isNew ? `เปิดสลิปมือ ${dateStr} แล้ว\n` : "";
        await this.replyMessage(
          replyToken,
          `${prefix}รับ ${amounts.length} รายการ รวม ${runTotal.toLocaleString("th-TH")} บาท\nพิมพ์ จบสลิปมือ เมื่อส่งครบ`,
        );
      }
    }
  }

  // ── White Sheet closing command ───────────────────────────────────────────
  private async processWhiteSheetClose(
    event: LineMessageEvent,
    parseResult: Exclude<
      ReturnType<typeof parseWhiteSheetCloseCommandFromMessage>,
      { kind: "not_command" }
    >,
    /** Signed guided provenance marker, stripped from the message text. */
    guidedMarker: string | null,
    eventId: string,
    eventType: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const sourceId = getSourceId(event.source);

    if (parseResult.kind === "invalid") {
      log.info("white sheet close command invalid", { sourceId });
      if (replyToken) await this.replyMessage(replyToken, parseResult.message);
      return { eventId, eventType, status: "saved", parsed: false };
    }

    log.info("white sheet close command", {
      sourceId,
      market: parseResult.command.marketLabelNormalized,
      businessDate: parseResult.command.businessDate,
    });

    // 3C: a guided operator's sheet must land on the round they opened. With no
    // guided round the verdict is not_guided and the legacy path is unchanged.
    const identity = buildGuidedMenuIdentity({
      lineUserId: getUserId(event.source),
      sourceType: event.source.type,
      sourceId,
      sessionKey: getPendingSessionKey(event.source),
    });
    let guidedContext = null;
    if (identity) {
      const guard = await guardGuidedWhiteSheetSubmission({
        journey: this.guidedJourney,
        identity,
        command: parseResult.command,
        marker: guidedMarker,
      });
      if (guard.verdict === "refused") {
        log.info("white sheet close refused — journey mismatch", { sourceId });
        if (replyToken) await this.replyMessage(replyToken, guard.message);
        return { eventId, eventType, status: "saved", parsed: false };
      }
      if (guard.verdict === "allowed") guidedContext = guard.context;
    }

    try {
      const outcome = await processWhiteSheetCloseCommand(this.supabase, {
        sourceId,
        command: parseResult.command,
        accountabilityRoundId: guidedContext?.accountabilityRoundId,
      });
      // 3C → 3D handoff, only when the sheet actually persisted.
      const handoff =
        guidedContext && outcome.persisted
          ? buildSlipHandoffMessages(guidedContext)
          : null;
      const messages = handoff
        ? [...outcome.replyMessages, ...handoff].slice(0, LINE_REPLY_MESSAGE_MAX)
        : outcome.replyMessages;
      if (replyToken) await this.replyMessages(replyToken, messages);
      return { eventId, eventType, status: "saved", parsed: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("white sheet close command failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(
            replyToken,
            "บันทึกปิดยอดไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หรือติดต่อผู้ดูแลระบบ",
          );
        } catch { /* ignore reply error */ }
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── Remaining fruit summary command ───────────────────────────────────────
  private async processRemainingFruitCommand(
    event:         LineMessageEvent,
    command:       ReturnType<typeof parseRemainingFruitCommandFromMessage> & object,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken   = event.replyToken;
    const businessDate = command.businessDate ?? bangkokToday();

    log.info("remaining fruit command", {
      businessDate,
      marketFilter: command.marketFilter,
    });

    try {
      const rows = await fetchRemainingFruitRows(
        this.supabase,
        businessDate,
        command.marketFilter,
      );
      const messages = buildRemainingFruitMessagesFromRows(businessDate, rows, {
        marketFilter: command.marketFilter,
        includeOverall: !command.marketFilter,
      });
      if (replyToken) await this.replyMessages(replyToken, messages);
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("remaining fruit command failed", { error: errorMessage });
      if (replyToken) {
        await this.replyMessage(replyToken, "ไม่สามารถสร้างสรุปคงเหลือได้ กรุณาลองใหม่");
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── P1 Daily Sales summary command ────────────────────────────────────────
  private async processSalesSummaryCommand(
    event:     LineMessageEvent,
    command:   ReturnType<typeof parseSalesSummaryCommandFromMessage> & object,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    // With no date the command reports the day that just closed — the same
    // business date the scheduled 08:10 report uses, so the two never disagree.
    const businessDate = command.businessDate ?? previousBangkokBusinessDate();

    log.info("sales summary command", { businessDate });

    try {
      const report = await loadSalesReport(this.supabase, businessDate);
      const messages = buildSalesSummaryMessages(report);
      if (replyToken) await this.replyMessages(replyToken, messages);
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("sales summary command failed", { error: errorMessage });
      if (replyToken) {
        await this.replyMessage(replyToken, "ไม่สามารถสร้างสรุปยอดขายได้ กรุณาลองใหม่");
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── Daily Close Preflight command ─────────────────────────────────────────
  private async processPreflightCommand(
    event:     LineMessageEvent,
    command:   ReturnType<typeof parsePreflightCommandFromMessage> & object,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    // Same default as the two scheduled reports: the day that just closed.
    const businessDate = command.businessDate ?? previousBangkokBusinessDate();

    log.info("daily close preflight command", { businessDate });

    try {
      const result = await runDailyClosePreflight(this.supabase, businessDate);
      const messages = buildPreflightMessages(result);
      if (replyToken) await this.replyMessages(replyToken, messages);
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("daily close preflight command failed", { error: errorMessage });
      if (replyToken) {
        await this.replyMessage(replyToken, "ไม่สามารถตรวจความพร้อมได้ กรุณาลองใหม่");
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── Purchase planning summary command ─────────────────────────────────────
  private async processPurchasePlanningCommand(
    event:     LineMessageEvent,
    command:   ReturnType<typeof parsePurchasePlanningCommandFromMessage> & object,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    // Same default as Sales and the Preflight: the day that just closed. A
    // day still in progress has returns that have not been weighed back yet,
    // which would read as a false sell-out.
    const businessDate = command.businessDate ?? previousBangkokBusinessDate();

    log.info("purchase planning command", { businessDate });

    try {
      const report = await loadPurchasePlanningReport(this.supabase, businessDate);
      const messages = buildPurchasePlanningMessages(report);
      if (replyToken) await this.replyMessages(replyToken, messages);
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("purchase planning command failed", { error: errorMessage });
      if (replyToken) {
        await this.replyMessage(replyToken, "ไม่สามารถสร้างสรุปสำหรับวางแผนซื้อของได้ กรุณาลองใหม่");
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }
  }

  // ── Manual slip session: close ────────────────────────────────────────────
  private async processManualSlipClose(
    event:         LineMessageEvent,
    lineMessageId: string,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;

    log.info("manual slip close command", { sourceId });

    try {
      const svc    = new ManualSlipSessionService(this.supabase);
      const session = await svc.findOpenSession(sourceId);

      if (!session) {
        log.info("manual slip close: no open session", { sourceId });
        if (replyToken) {
          await this.replyMessage(replyToken, "ไม่มีสลิปมือที่เปิดอยู่");
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const { total, alreadyClosed } = await svc.closeSession({
        sessionId: session.id, lineUserId, lineMessageId,
      });

      if (alreadyClosed) {
        if (replyToken) await this.replyMessage(replyToken, "สลิปมือปิดไปแล้ว");
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const dateStr   = session.business_date;
      const labelPart = session.market_label ? ` (${session.market_label})` : "";
      if (replyToken) {
        await this.replyMessage(
          replyToken,
          `จบสลิปมือ ${dateStr}${labelPart} แล้ว\nยอดรวมสลิปมือ: ${total.toLocaleString("th-TH")} บาท`,
        );
      }
      log.info("manual slip session closed", { sessionId: session.id, total });
      tryFinalizeSettlement(this.supabase, sourceId, session.business_date).catch(
        (err) => log.warn("tryFinalizeSettlement failed", { reason: err instanceof Error ? err.message : String(err) }),
      );
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("manual slip close failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "ปิดสลิปมือไม่สำเร็จ กรุณาลองอีกครั้ง");
        } catch { /* ignore reply error */ }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── Manual slip session: append amount entries ────────────────────────────
  // Returns null if no open session (caller falls through to existing handlers).
  private async tryAppendManualSlipEntry(
    event:         LineMessageEvent,
    text:          string,
    lineMessageId: string,
    eventId:       string,
    eventType:     string,
    log:           ChildLogger,
  ): Promise<WebhookProcessResult | null> {
    const amounts = parseManualSlipAmounts(text);
    if (amounts.length === 0) return null;

    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;

    const svc     = new ManualSlipSessionService(this.supabase);
    const session = await svc.findOpenSession(sourceId);
    if (!session) return null; // no open session — fall through

    try {
      await svc.appendEntries({ sessionId: session.id, entries: amounts, lineMessageId, lineUserId });
      log.info("manual slip entries appended", {
        sessionId: session.id,
        count: amounts.length,
        lineMessageId,
      });

      if (replyToken) {
        const total = amounts.reduce((s, a) => s + a.amount, 0);
        await this.replyMessage(
          replyToken,
          `รับ ${amounts.length} รายการ รวม ${total.toLocaleString("th-TH")} บาท`,
        );
      }
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("manual slip entry append failed", { error: errorMessage });
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── LINE Manual White Sheet entry session ──────────────────────────────────
  // Temporary session state for multi-message LINE entry of White Sheet
  // figures; on close, the entered values are saved atomically into
  // digital_white_sheet_cash_entries by the close_manual_white_sheet_note_session
  // RPC (migration 0059). Returns null only for field-shaped text with no
  // open session, so the caller falls through to existing routing unchanged.
  private async tryProcessWhiteSheetNoteCommand(
    event:      LineMessageEvent,
    parseResult: Exclude<WhiteSheetNoteParseResult, { kind: "not_command" }>,
    eventId:    string,
    eventType:  string,
    log:        ChildLogger,
    replyMessage: ReplyLineMessage,
  ): Promise<WebhookProcessResult | null> {
    const sourceId   = getSourceId(event.source);
    const lineUserId = getUserId(event.source);
    const replyToken = event.replyToken;
    const svc        = new WhiteSheetNoteSessionService(this.supabase);

    if (parseResult.kind === "open_invalid") {
      if (replyToken) await replyMessage(replyToken, parseResult.message);
      return { eventId, eventType, status: "saved", parsed: false };
    }

    if (parseResult.kind === "open") {
      const { marketLabel, marketLabelNormalized, businessDate } = parseResult.command;
      try {
        const result = await svc.openSession({
          sourceId, marketLabel, marketLabelNormalized, businessDate,
          lineUserId, lineEventId: eventId,
        });
        if (replyToken) {
          if (result.opened) {
            await replyMessage(
              replyToken,
              `เปิดใบขาวมือแล้ว\nตลาด: ${marketLabel}\nวันที่: ${isoDateToBuddhistDisplay(businessDate)}\nส่งค่าใช้จ่ายทีละรายการได้เลย เช่น\nค่าแรง 500\nพิมพ์ จบใบขาวมือ เมื่อส่งครบ`,
            );
          } else if (
            result.session.market_label_normalized === marketLabelNormalized
            && result.session.business_date === businessDate
          ) {
            // Same market/date already open — resume, never claim closed/saved.
            await replyMessage(replyToken, buildWhiteSheetNoteResumeSummary(result.session));
          } else {
            await replyMessage(
              replyToken,
              `ยังมีใบขาวมือของ ${result.session.market_label} วันที่ ${isoDateToBuddhistDisplay(result.session.business_date)} ที่ยังไม่จบ\nกรุณาพิมพ์ จบใบขาวมือ หรือ ยกเลิกใบขาวมือ ก่อนเปิดใบใหม่`,
            );
          }
        }
        log.info("white sheet note open", { sourceId, opened: result.opened });
        return { eventId, eventType, status: "saved", parsed: false };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error("white sheet note open failed", { error: errorMessage });
        return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
      }
    }

    // field / close / cancel — all require an existing open session. A
    // lookup failure here must never fall through into produce/manual-slip/
    // other routing — surface it as an error result and stop.
    let openSession: ManualWhiteSheetNoteSessionRow | null;
    try {
      openSession = await svc.findOpenSession(sourceId);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("white sheet note open-session lookup failed", { sourceId, error: errorMessage });
      if (replyToken) {
        try {
          await replyMessage(replyToken, WHITE_SHEET_NOTE_LOOKUP_ERROR_REPLY);
        } catch { /* ignore reply error */ }
      }
      return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
    }

    if (!openSession) {
      if (parseResult.kind === "field") return null; // fall through unchanged

      // จบใบขาวมือ / ยกเลิกใบขาวมือ with nothing open — look up the latest
      // terminal session for an accurate reply instead of always claiming
      // "no open session" when it was in fact already closed/cancelled.
      try {
        const latest = await svc.findLatestSessionForSource(sourceId);
        if (replyToken) await replyMessage(replyToken, buildWhiteSheetNoteTerminalReply(latest));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error("white sheet note latest-session lookup failed", { sourceId, error: errorMessage });
        return { eventId, eventType, status: "error", parsed: false, error: errorMessage };
      }
      return { eventId, eventType, status: "saved", parsed: false };
    }

    try {
      if (parseResult.kind === "field_invalid") {
        if (replyToken) await replyMessage(replyToken, parseResult.message);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      if (parseResult.kind === "field") {
        const result = await svc.applyFields(openSession, parseResult.fields);
        if (!result.ok) {
          // A racing close/cancel already terminated this session — never
          // report false success for the field write.
          const latest = await svc.findLatestSessionForSource(sourceId);
          if (replyToken) await replyMessage(replyToken, buildWhiteSheetNoteTerminalReply(latest));
          log.info("white sheet note field update conflict", {
            sourceId,
            fields: parseResult.fields.map((f) => f.key),
          });
          return { eventId, eventType, status: "saved", parsed: false };
        }
        if (replyToken) {
          await replyMessage(replyToken, buildWhiteSheetNoteFieldSaveReply(parseResult.fields));
        }
        log.info("white sheet note fields applied", {
          sourceId,
          fields: parseResult.fields.map((f) => f.key),
          sessionId: result.session.id,
        });
        return { eventId, eventType, status: "saved", parsed: false };
      }

      if (parseResult.kind === "close") {
        // Fast-path UX check only — the RPC re-validates against the row it
        // locks and is the authoritative source of truth for "empty".
        if (!svc.hasAnyValue(openSession)) {
          if (replyToken) await replyMessage(replyToken, WHITE_SHEET_NOTE_CLOSE_EMPTY_REPLY);
          return { eventId, eventType, status: "saved", parsed: false };
        }

        const result = await svc.closeSession(openSession, { lineUserId, lineEventId: eventId });
        switch (result.outcome) {
          case "closed":
            if (replyToken) {
              await replyMessage(
                replyToken,
                buildWhiteSheetNoteCanonicalSummary(
                  result.session.market_label,
                  result.session.business_date,
                  result.cashEntry,
                ),
              );
            }
            log.info("white sheet note closed", { sourceId, sessionId: result.session.id });
            break;
          case "already_closed":
            if (replyToken) await replyMessage(replyToken, WHITE_SHEET_NOTE_ALREADY_CLOSED_REPLY);
            break;
          case "already_cancelled":
            if (replyToken) await replyMessage(replyToken, WHITE_SHEET_NOTE_ALREADY_CANCELLED_REPLY);
            break;
          case "empty":
            if (replyToken) await replyMessage(replyToken, WHITE_SHEET_NOTE_CLOSE_EMPTY_REPLY);
            break;
          case "finalized":
            log.info("white sheet note close rejected — canonical row finalized", { sourceId });
            if (replyToken) await replyMessage(replyToken, WHITE_SHEET_NOTE_FINALIZED_REPLY);
            break;
          case "not_found":
            if (replyToken) await replyMessage(replyToken, WHITE_SHEET_NOTE_NO_OPEN_SESSION_REPLY);
            break;
        }
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // parseResult.kind === "cancel"
      const cancelResult = await svc.cancelSession(openSession, { lineUserId, lineEventId: eventId });
      if (!cancelResult.ok) {
        // Raced against a close/another cancel — report what actually won.
        const latest = await svc.findLatestSessionForSource(sourceId);
        if (replyToken) await replyMessage(replyToken, buildWhiteSheetNoteTerminalReply(latest));
        return { eventId, eventType, status: "saved", parsed: false };
      }
      if (replyToken) await replyMessage(replyToken, "ยกเลิกใบขาวมือแล้ว");
      log.info("white sheet note cancelled", { sourceId, sessionId: cancelResult.session.id });
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("white sheet note command failed", { error: errorMessage, kind: parseResult.kind });
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // Image evidence is processed independently from the text-session parser.
  // Multiple images from the same source within SLIP_BATCH_QUIET_SECONDS are
  // grouped into a batch; only the first image triggers a reply.
  private async processImageMessage(
    event: LineMessageEvent,
    message: LineImageMessage,
    rawMessageId: string,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId = getSourceId(event.source);
    const senderId = getUserId(event.source);

    let activeSession: Awaited<ReturnType<SlipSessionIngestor["findActiveSession"]>>;
    try {
      activeSession = await this.slipSessionService.findActiveSession(sourceId);
    } catch (error) {
      log.error("slip session lookup failed — ignoring image", {
        sourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        eventId,
        eventType: event.type,
        status: "saved",
        parsed: false,
      };
    }

    if (!activeSession) {
      log.info("image ignored: no active slip session", { sourceId });
      return {
        eventId,
        eventType: event.type,
        status: "saved",
        parsed: false,
      };
    }

    try {
      const result = await this.evidenceIngestor.ingest({
        rawMessageId,
        lineMessageId: message.id,
        sourceId,
        sourceType: event.source.type,
        lineUserId: senderId,
        eventTimestamp: event.timestamp,
      });

      if (result.status === "RECEIVED" && result.evidenceId) {
        const evidenceId = result.evidenceId;

        let shouldReply = false;
        // Only schedule OCR after evidence is successfully attached to a batch.
        // If attachEvidence throws, the evidence row exists but has no batch_id;
        // running OCR on it would produce a floating result with no parent.
        let scheduleOcr = false;

        try {
          await this.batchService.attachEvidence(activeSession.batchId, evidenceId);
          shouldReply = activeSession.imageCount === 0; // first image in this session
          scheduleOcr = true; // attach succeeded — safe to process
          log.info("image attached to active slip session", {
            batchId:      activeSession.batchId,
            imageCount:   activeSession.imageCount + 1,
            isFirstImage: shouldReply,
          });
        } catch (attachError) {
          const errMsg = attachError instanceof Error ? attachError.message : String(attachError);
          const isBatchFinalized = errMsg.includes("not in collecting/closing status");

          if (isBatchFinalized) {
            // Finalizer claimed the batch before this image arrived.
            // The evidence row exists (traceable) but is not part of the batch.
            // Do NOT schedule OCR; reply with an explicit rejection.
            log.info("image rejected: batch already processing/finalized", {
              batchId:         activeSession.batchId,
              evidenceId,
              rejectionReason: "batch_already_processing",
            });
            if (event.replyToken) {
              try {
                await this.replyMessage(event.replyToken, BATCH_FINALIZED_LATE_IMAGE_REPLY);
              } catch (replyErr) {
                log.error("batch-finalized rejection reply failed", {
                  error: replyErr instanceof Error ? replyErr.message : String(replyErr),
                });
              }
            }
            return {
              eventId,
              eventType: event.type,
              status: "saved",
              parsed: false,
            };
          }

          // Other attach failure (network, unexpected DB error): fall back to
          // plain ack so the sender knows the image was received.
          log.error("slip evidence attach failed — sending plain ack", {
            error: errMsg,
          });
          shouldReply = true;
          // scheduleOcr stays false — do NOT process an unattached evidence
        }

        if (shouldReply && event.replyToken) {
          try {
            await this.replyMessage(event.replyToken, BATCH_FIRST_IMAGE_REPLY);
          } catch (error) {
            log.error("slip evidence reply failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (scheduleOcr) {
          this.scheduleBackgroundTask(
            () => this.checkProcessor.processEvidence(evidenceId),
          );
        }
      } else {
        // Ingest failed — reply with error so sender knows to retry.
        if (event.replyToken) {
          try {
            await this.replyMessage(event.replyToken, EVIDENCE_FAILED_REPLY);
          } catch (error) {
            log.error("slip evidence reply failed", {
              evidenceStatus: result.status,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return {
        eventId,
        eventType: event.type,
        status: "saved",
        parsed: false,
        error: result.status === "RECEIVED" ? undefined : result.status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("slip evidence ingestion failed", { error: errorMessage });

      if (event.replyToken) {
        try {
          await this.replyMessage(event.replyToken, EVIDENCE_FAILED_REPLY);
        } catch (replyError) {
          log.error("slip evidence failure reply failed", {
            error: replyError instanceof Error ? replyError.message : String(replyError),
          });
        }
      }

      return {
        eventId,
        eventType: event.type,
        status: "saved",
        parsed: false,
        error: errorMessage,
      };
    }
  }

  // ── Slip session: open ────────────────────────────────────────────────────
  private async processSlipOpen(
    event:     LineMessageEvent,
    header:    SlipSessionHeader,
    /** Signed guided provenance marker, stripped from the message text. */
    guidedMarker: string | null,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId  = getSourceId(event.source);
    const senderId  = getUserId(event.source);
    const replyToken = event.replyToken;

    log.info("slip session open command received", {
      sourceId,
      sellerName: header.sellerName,
      marketName: header.marketName,
      slipDate:   header.slipDate,
    });

    // Guided binding is checked BEFORE the open, so an edited or copied header
    // never creates a slip_batches row that images would then attach to. With no
    // guided round owning the market/date, the legacy open runs unchanged.
    const guidedIdentity = buildGuidedMenuIdentity({
      lineUserId: senderId,
      sourceType: event.source.type,
      sourceId,
      sessionKey: getPendingSessionKey(event.source),
    });
    let accountabilityRoundId: string | null = null;
    if (guidedIdentity) {
      const guard = await guardGuidedSlipOpen({
        journey:  this.guidedJourney,
        catalog:  this.guidedCatalog,
        identity: guidedIdentity,
        header,
        marker: guidedMarker,
      });
      if (guard.verdict === "refused") {
        log.info("slip open refused — guided round mismatch", { sourceId });
        if (replyToken) await this.replyMessage(replyToken, guard.message);
        return { eventId, eventType, status: "saved", parsed: false };
      }
      if (guard.verdict === "allowed") {
        accountabilityRoundId = guard.context.accountabilityRoundId ?? null;
      }
    }

    try {
      const result = await this.slipSessionService.openSession(
        sourceId, event.source.type, senderId, header, accountabilityRoundId,
      );

      if (!result.opened) {
        log.info("slip open: session already open", { existingBatchId: result.existingBatchId });
        if (replyToken) await this.replyMessage(replyToken, SESSION_ALREADY_OPEN_REPLY);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      const dateStr = header.slipDate ?? "ไม่ระบุวันที่";
      const confirmText = [
        "เปิดชุดสลิปเงินโอนแล้ว",
        `${header.sellerName} — ${header.marketName} — ${dateStr}`,
        "",
        "ส่งรูปสลิปต่อได้เลย",
        `พิมพ์ "จบสลิป" เมื่อส่งครบ`,
      ].join("\n");

      if (replyToken) await this.replyMessage(replyToken, confirmText);

      log.info("slip session opened", { batchId: result.batchId });
      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("slip session open failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "เปิดชุดสลิปไม่สำเร็จ กรุณาลองอีกครั้ง");
        } catch (replyErr) {
          log.error("slip open error reply failed", {
            error: replyErr instanceof Error ? replyErr.message : String(replyErr),
          });
        }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── Slip session: close ───────────────────────────────────────────────────
  //
  // Transitions the batch to 'closing' and immediately replies with an ack.
  // The actual summary is sent by the cron finalizer once the quiet period
  // has elapsed and all OCR checks have reached a terminal state.
  private async processSlipClose(
    event:     LineMessageEvent,
    eventId:   string,
    eventType: string,
    log:       ChildLogger,
  ): Promise<WebhookProcessResult> {
    const sourceId   = getSourceId(event.source);
    const replyToken = event.replyToken;

    log.info("slip close command received", { sourceId });

    try {
      // findActiveSession returns collecting OR closing batches.
      const active = await this.slipSessionService.findActiveSession(sourceId);

      if (!active) {
        log.info("slip close: no active batch found", { sourceId });
        if (replyToken) await this.replyMessage(replyToken, NO_ACTIVE_BATCH_REPLY);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      // Atomic claim: collecting → closing.
      // If the batch is already closing, the WHERE status='collecting' predicate
      // fails and claimed is null — we reply with the already-closing message.
      const { data: claimed, error: claimError } = await this.supabase
        .from("slip_batches")
        .update({ status: "closing", closing_at: new Date().toISOString() })
        .eq("id", active.batchId)
        .eq("status", "collecting")
        .select("id")
        .single();

      if (claimError || !claimed) {
        // Batch is already closing (a previous "จบสลิป" was accepted).
        log.info("slip close: batch already closing", { batchId: active.batchId });
        if (replyToken) await this.replyMessage(replyToken, ALREADY_CLOSING_REPLY);
        return { eventId, eventType, status: "saved", parsed: false };
      }

      log.info("slip batch transitioned to closing", {
        batchId:    active.batchId,
        imageCount: active.imageCount,
      });

      // Immediate ack — summary will arrive via the cron finalizer.
      if (replyToken) await this.replyMessage(replyToken, SLIP_CLOSE_ACKNOWLEDGED_REPLY);

      return { eventId, eventType, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("slip session close failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(replyToken, "เกิดข้อผิดพลาดในการสรุปสลิป กรุณาลองอีกครั้ง");
        } catch (replyErr) {
          log.error("slip close error reply failed", {
            error: replyErr instanceof Error ? replyErr.message : String(replyErr),
          });
        }
      }
      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── Single-message parser flow (backward compat) ──────────────────────────
  private async runParser(
    msgEvent:     LineMessageEvent,
    rawMessageId: string,
    eventId:      string,
    eventType:    string,
    log:          ChildLogger,
  ): Promise<WebhookProcessResult> {
    const parser     = parserRegistry.findParser(msgEvent);
    const replyToken = msgEvent.replyToken;
    let weighSessionData: WeighSession | null = null;
    let rawTextForDedup:  string | null       = null;

    if (!parser) {
      log.debug("no parser matched");
      return { eventId, eventType, status: "saved", parsed: false };
    }

    log.info("running parser", { parser: parser.name, version: parser.version });

    try {
      const result = await parser.parse(msgEvent);

      // Fix 2 + 3: weigh-session specific guards before any DB writes
      if (parser.name === "weigh-session" && result.data) {
        const ws = result.data as unknown as WeighSession;

        const validationErrors = getWeighSessionFinalizationErrors(ws);
        if (validationErrors.length > 0) {
          log.warn("produce session validation failed — aborting before persistence", {
            errors: validationErrors,
          });
          await this.recordProduceValidationError(rawMessageId, validationErrors, log);
          if (replyToken) {
            try {
              await this.replyMessage(replyToken, buildWeighSessionValidationReply(ws));
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // Fix 2: empty items guard
        if (ws.items.length === 0) {
          log.warn("parsed session has no items — aborting");
          await this.recordProduceValidationError(
            rawMessageId,
            ["parsed session has no items"],
            log,
          );
          if (replyToken) {
            try {
              await replyLineMessage(replyToken, "อ่านรายการไม่สำเร็จ กรุณาตรวจสอบรูปแบบข้อความ");
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        // Fix 3: dedup check. Old failures may have reserved a hash before any
        // produce_items were inserted; release those ghost reservations.
        const rawText   = (msgEvent.message as import("@/lib/line/types").LineTextMessage).text;
        const dedup     = new SessionDedupService(this.supabase);
        // This path has no pending generation of its own, so it can never own a
        // reservation and can never release one. That is the point: duplicate
        // lookup spans V0/V1/V2, and a V1 match here is typically a historical
        // session recorded under an alias spelling of the same market whose item
        // hashes cannot be re-derived from the canonical resend. Deleting it
        // would destroy the only proof that produce already landed.
        const match = await dedup.findDuplicate(ws, null);
        let isDuplicate = match !== null;
        if (
          match?.releasableByCurrentAttempt
          && !(await dedup.hasPersistedItems(ws))
        ) {
          await dedup.release(ws, match.reservedByGeneration);
          isDuplicate = false;
        }
        if (isDuplicate) {
          log.info("duplicate reservation matched", {
            fingerprintGeneration: match?.fingerprintGeneration,
            historical: match?.reservedByGeneration === null,
          });
          log.info("duplicate session — skipping insert");
          // The produce IS recorded, under the message that first carried it.
          // Marking this one processed keeps "unprocessed complete produce
          // message" meaning exactly one thing — produce that never landed —
          // which is what the daily report relies on.
          await this.markRawMessageProcessed(rawMessageId, log);
          if (replyToken) {
            try {
              await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว");
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }

        weighSessionData = ws;
        rawTextForDedup  = rawText;
      }

      // Fix 4: persist first, then mark processed
      await result.persist(this.supabase, rawMessageId);

      if (parser.name === "weigh-session" && weighSessionData) {
        const dedup = new SessionDedupService(this.supabase);
        const duplicateAfterPersist = await dedup.record(weighSessionData, rawTextForDedup ?? undefined);
        if (duplicateAfterPersist) {
          log.info("duplicate session recorded concurrently after persist");
          await this.markRawMessageProcessed(rawMessageId, log);
          if (replyToken) {
            try {
              await replyLineMessage(replyToken, "รายการนี้เคยบันทึกแล้ว");
            } catch (e) {
              log.error("reply failed", { error: String(e) });
            }
          }
          return { eventId, eventType, status: "saved", parsed: false };
        }
      }

      await this.supabase
        .from("raw_messages")
        .update({ is_processed: true })
        .eq("id", rawMessageId);

      log.info("parse succeeded", { parser: parser.name });

      if (parser.name === "weigh-session" && result.data) {
        const ws = result.data as unknown as WeighSession;
        await new DailySummaryService(this.supabase).recalculate(
          ws.date ?? bangkokToday(),
          ws.staff_name,
          ws.session_title ?? null,
        );
      }

      if (replyToken && result.data) {
        const summaryText = parser.name === "weigh-session"
          ? buildWeighSessionSummary(result.data as unknown as WeighSession)
          : null;

        if (summaryText) {
          try {
            await replyLineMessage(replyToken, summaryText);
          } catch (e) {
            log.error("reply failed", { error: String(e) });
          }
        }
      }

      return { eventId, eventType, status: "saved", parsed: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("parser crashed", { parser: parser.name, error: errorMessage });

      await this.supabase.from("parse_errors").insert({
        raw_message_id: rawMessageId,
        parser_name:    parser.name,
        parser_version: parser.version,
        error_type:     "parser_crash",
        error_message:  errorMessage,
        error_detail:   err instanceof Error ? { stack: err.stack } : null,
      });

      if (replyToken) {
        try {
          await replyLineMessage(replyToken, "ยังอ่านรายการนี้ไม่ได้ครับ กรุณาตรวจรูปแบบข้อความอีกครั้ง");
        } catch (e) {
          log.error("reply failed", { error: String(e) });
        }
      }

      return { eventId, eventType, status: "saved", parsed: false, error: errorMessage };
    }
  }

  // ── Guided Menu Slice 2 ───────────────────────────────────────────────────
  private async processGuidedTextClose(
    event: LineMessageEvent,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const identity = buildGuidedMenuIdentity({
      lineUserId: getUserId(event.source),
      sourceType: event.source.type,
      sourceId: getSourceId(event.source),
      sessionKey: getPendingSessionKey(event.source),
    });

    if (!identity) {
      log.info("guided text close refused — missing identity binding");
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    const outcome = await this.guidedMenuHandler.handleTextCloseRequest({
      identity,
      lineEventId: eventId,
      lineTimestampMs: event.timestamp,
    });
    if (replyToken) {
      await this.replyApiMessages(
        replyToken,
        outcome.messages as LineApiMessage[],
      );
    }
    log.info("guided text close handled", { screen: outcome.screen });
    return { eventId, eventType: event.type, status: "saved", parsed: false };
  }

  private async processGuidedTextCancel(
    event: LineMessageEvent,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const identity = buildGuidedMenuIdentity({
      lineUserId: getUserId(event.source),
      sourceType: event.source.type,
      sourceId: getSourceId(event.source),
      sessionKey: getPendingSessionKey(event.source),
    });

    if (!identity) {
      log.info("guided text cancel refused — missing identity binding");
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    const outcome = await this.guidedMenuHandler.handleTextCancelRequest({ identity });
    if (replyToken) {
      await this.replyApiMessages(
        replyToken,
        outcome.messages as LineApiMessage[],
      );
    }
    log.info("guided text cancel handled", { screen: outcome.screen });
    return { eventId, eventType: event.type, status: "saved", parsed: false };
  }

  private async processGuidedMenuOpen(
    event: LineMessageEvent,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const identity = buildGuidedMenuIdentity({
      lineUserId: getUserId(event.source),
      sourceType: event.source.type,
      sourceId: getSourceId(event.source),
      sessionKey: getPendingSessionKey(event.source),
    });

    if (!identity) {
      log.info("guided menu open refused — missing identity binding");
      if (replyToken) {
        await this.replyApiMessages(replyToken, [
          buildInvalidMenuMessage() as LineApiMessage,
        ]);
      }
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    const outcome = await this.guidedMenuHandler.openMenu({ identity });
    if (replyToken) {
      await this.replyApiMessages(
        replyToken,
        outcome.messages as LineApiMessage[],
      );
    }
    log.info("guided menu opened", { screen: outcome.screen });
    return { eventId, eventType: event.type, status: "saved", parsed: false };
  }

  /**
   * Slice 3D — "ปิดรอบ".
   *
   * Closes nothing on its own: every blocker is an existing lifecycle state,
   * and the close itself is tryFinalizeSettlement, which stays authoritative
   * and idempotent on retry. The receipt is delivered in the reply the
   * operator is already waiting on, so the finalizer's own push is suppressed
   * rather than sending the same receipt twice.
   */
  private async processGuidedRoundCloseCommand(
    event: LineMessageEvent,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const identity = buildGuidedMenuIdentity({
      lineUserId: getUserId(event.source),
      sourceType: event.source.type,
      sourceId: getSourceId(event.source),
      sessionKey: getPendingSessionKey(event.source),
    });
    if (!identity) {
      log.info("guided round close refused — missing identity binding");
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    try {
      const outcome = await processGuidedRoundClose({
        journey: this.guidedJourney,
        rounds: this.guidedRounds,
        identity,
        closeLineEventId: eventId,
      });
      if (replyToken) {
        await this.replyMessages(
          replyToken,
          outcome.messages.slice(0, LINE_REPLY_MESSAGE_MAX),
        );
      }
      log.info("guided round close handled", { closed: outcome.closed });
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("guided round close failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(
            replyToken,
            "ตรวจยอดปิดรอบไม่สำเร็จ ระบบยังไม่ได้ปิดรอบ กรุณาลองใหม่อีกครั้ง",
          );
        } catch { /* ignore reply error */ }
      }
      return {
        eventId,
        eventType: event.type,
        status: "error",
        parsed: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Slice 3D.1 — "ส่งยอด".
   *
   * The adapter verifies the round binding and then calls the existing
   * settlement boundary; every refusal happens before any write. Nothing about
   * settlement accounting or reconciliation is decided here.
   */
  private async processGuidedSettlementCommand(
    event: LineMessageEvent,
    text: string,
    /** Signed guided provenance marker, stripped from the message text. */
    guidedMarker: string | null,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const replyToken = event.replyToken;
    const identity = buildGuidedMenuIdentity({
      lineUserId: getUserId(event.source),
      sourceType: event.source.type,
      sourceId: getSourceId(event.source),
      sessionKey: getPendingSessionKey(event.source),
    });
    if (!identity) {
      log.info("guided settlement refused — missing identity binding");
      return { eventId, eventType: event.type, status: "saved", parsed: false };
    }

    try {
      const outcome = await processGuidedSettlementSubmission({
        supabase: this.supabase,
        journey: this.guidedJourney,
        rounds: this.guidedRounds,
        identity,
        text,
        marker: guidedMarker,
      });
      if (replyToken && outcome.messages.length > 0) {
        await this.replyMessages(
          replyToken,
          outcome.messages.slice(0, LINE_REPLY_MESSAGE_MAX),
        );
      }
      log.info("guided settlement handled", { saved: outcome.saved });
      return {
        eventId,
        eventType: event.type,
        status: "saved",
        parsed: outcome.saved,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("guided settlement failed", { error: errorMessage });
      if (replyToken) {
        try {
          await this.replyMessage(
            replyToken,
            "บันทึกยอดส่งไม่สำเร็จ ระบบยังไม่ได้บันทึกยอดส่งของรอบนี้ กรุณาลองใหม่อีกครั้ง",
          );
        } catch { /* ignore reply error */ }
      }
      return {
        eventId,
        eventType: event.type,
        status: "error",
        parsed: false,
        error: errorMessage,
      };
    }
  }

  private async processGuidedMenuPostback(
    event: LinePostbackEvent,
    eventId: string,
    log: ChildLogger,
  ): Promise<WebhookProcessResult> {
    const data = event.postback?.data ?? "";
    const replyToken = event.replyToken;

    // Unrelated postbacks: persist raw event only; leave available to other routers.
    if (!isGuidedMenuPostbackCandidate(data)) {
      log.debug("non-guided-menu postback — ignored after raw persist");
      return { eventId, eventType: event.type, status: "saved" };
    }

    // Malformed gpm1-looking data fails closed (still after normal raw persist).
    if (!isGuidedMenuPostbackData(data)) {
      log.info("malformed guided-menu postback — invalid reply");
      if (replyToken) {
        await this.replyApiMessages(replyToken, [
          buildInvalidMenuMessage() as LineApiMessage,
        ]);
      }
      return { eventId, eventType: event.type, status: "saved" };
    }

    const identity = buildGuidedMenuIdentity({
      lineUserId: getUserId(event.source),
      sourceType: event.source.type,
      sourceId: getSourceId(event.source),
      sessionKey: getPendingSessionKey(event.source),
    });

    if (!identity) {
      log.info("guided menu postback refused — missing identity binding");
      if (replyToken) {
        await this.replyApiMessages(replyToken, [
          buildInvalidMenuMessage() as LineApiMessage,
        ]);
      }
      return { eventId, eventType: event.type, status: "saved" };
    }

    const outcome = await this.guidedMenuHandler.handlePostback({
      wireToken: data,
      lineEventId: eventId,
      identity,
      lineTimestampMs: event.timestamp,
    });

    if (replyToken) {
      await this.replyApiMessages(
        replyToken,
        outcome.messages as LineApiMessage[],
      );
    }
    log.info("guided menu postback handled", {
      screen: outcome.screen,
      confirmPlaceholder: outcome.confirmPlaceholder ?? false,
    });
    return { eventId, eventType: event.type, status: "saved" };
  }

  // ── DB helpers ────────────────────────────────────────────────────────────
  private async drainOrderedSource(
    sourceId: string,
    destination: string,
    resultByEventId: Map<string, WebhookProcessResult>,
  ): Promise<void> {
    while (true) {
      const claim = await this.claimOrderedEvent(sourceId);
      if (!claim) return;

      let result: WebhookProcessResult;
      const replies: Parameters<ReplyLineMessage>[] = [];
      try {
        const event = await this.loadQueuedEvent(claim.raw_message_id);
        result = event
          ? await this.processOne(
            event,
            destination,
            0,
            1,
            claim.raw_message_id,
            async (...reply) => { replies.push(reply); },
          )
          : {
            eventId: claim.line_event_id,
            eventType: "message",
            status: "error",
            error: "queued raw event was not found",
          };
      } catch (error) {
        result = {
          eventId: claim.line_event_id,
          eventType: "message",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      const completed = await this.completeOrderedEvent(
        claim.raw_message_id,
        claim.claim_token,
        result.status === "error" || Boolean(result.error) ? "failed" : "processed",
        result.error,
      );
      if (!completed) {
        if (!resultByEventId.has(result.eventId)) {
          resultByEventId.set(result.eventId, {
            eventId: result.eventId,
            eventType: result.eventType,
            status: "duplicate",
            claimConflict: true,
          });
        }
        continue;
      }
      for (const reply of replies) await this.replyMessage(...reply);
      resultByEventId.set(result.eventId, result);
    }
  }

  private async claimOrderedEvent(sourceId: string): Promise<QueueClaim | null> {
    const { data, error } = await this.supabase.rpc("claim_line_webhook_event", {
      p_source_id: sourceId,
    });
    if (error) throw new Error(`ordered webhook claim failed: ${error.message}`);
    return (data as QueueClaim | null) ?? null;
  }

  private async loadQueuedEvent(rawMessageId: string): Promise<LineEvent | null> {
    const { data, error } = await this.supabase
      .from("raw_messages")
      .select("payload")
      .eq("id", rawMessageId)
      .maybeSingle();
    if (error) throw new Error(`queued raw event lookup failed: ${error.message}`);
    return data ? data.payload as unknown as LineEvent : null;
  }

  private async completeOrderedEvent(
    rawMessageId: string,
    claimToken: string,
    status: "processed" | "failed",
    errorMessage?: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("complete_line_webhook_event", {
      p_raw_message_id: rawMessageId,
      p_claim_token: claimToken,
      p_status: status,
      p_error_message: errorMessage ?? null,
    });
    if (error) throw new Error(`ordered webhook completion failed: ${error.message}`);
    return data === true;
  }

  private isOrderingSchemaCacheError(error: unknown): boolean {
    const message = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    return code === "PGRST202"
      || /schema cache/i.test(message)
      || /could not find the function[\s\S]*schema cache/i.test(message);
  }

  private isMissingOrderingInfrastructure(error: unknown): boolean {
    const message = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : String(error);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    // Schema-cache misses are transient — never treat them as "infra missing".
    if (this.isOrderingSchemaCacheError(error)) return false;
    const namesOrderingRpc =
      message.includes("receive_line_webhook_event")
      || message.includes("claim_line_webhook_event")
      || message.includes("complete_line_webhook_event")
      || message.includes("line_webhook_event_queue");
    return code === "42883"
      || code === "42P01"
      || message.includes("42883")
      || message.includes("42P01")
      || (namesOrderingRpc && /does not exist/i.test(message))
      // Unit-test doubles throw `unexpected rpc: <name>` when the queue RPCs
      // are intentionally absent — that is genuine missing infra for doubles.
      || (/unexpected(?: .*?)?rpc/i.test(message) && namesOrderingRpc);
  }

  private isWhiteSheetOrderingEvent(event: LineEvent): boolean {
    if (event.type !== "message" || event.message.type !== "text") return false;
    const text = event.message.text;
    // Field-shaped text must stay on the ordered path even if classification
    // regresses to not_command (the Production UAT failure mode).
    return parseWhiteSheetNoteCommand(text).kind !== "not_command"
      || isWhiteSheetNoteFieldShaped(text);
  }

  private async saveRawMessage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: any,
    destination: string
  ): Promise<string | null | "error" | OrderedEventReceipt> {
    const source  = event.source  ?? {};
    const message = event.message as LineMessage | undefined;

    if (this.isWhiteSheetOrderingEvent(event) && this.orderedQueueAvailable !== false) {
      let data: unknown;
      let error: { code?: string; message: string } | null = null;
      try {
        ({ data, error } = await this.supabase.rpc("receive_line_webhook_event", {
          p_line_event_id: event.webhookEventId,
          p_destination: destination,
          p_event_type: event.type,
          p_source_type: source.type ?? "user",
          p_source_id: getSourceId(source),
          p_user_id: getUserId(source),
          p_message_id: message?.id ?? null,
          p_message_type: message?.type ?? null,
          p_raw_text: message && "text" in message ? (message as { text: string }).text : null,
          p_payload: event,
        }));
      } catch (caught) {
        error = {
          message: caught instanceof Error ? caught.message : String(caught),
          code: typeof caught === "object" && caught !== null && "code" in caught
            ? String((caught as { code: unknown }).code)
            : undefined,
        };
        if (this.isMissingOrderingInfrastructure(caught)) {
          this.orderedQueueAvailable = false;
        } else if (!this.isOrderingSchemaCacheError(caught)) {
          throw caught;
        }
      }
      if (!error) {
        this.orderedQueueAvailable = true;
        const receipt = data as { raw_message_id: string; duplicate: boolean };
        return {
          rawMessageId: receipt.raw_message_id,
          sourceId: getSourceId(source),
          duplicate: receipt.duplicate,
        };
      }
      if (this.isMissingOrderingInfrastructure(error)) {
        // Pre-0060 databases / unit doubles only — permanently fall back.
        this.orderedQueueAvailable = false;
      } else {
        // Schema-cache and other receive failures must surface. Do not poison
        // orderedQueueAvailable and do not silently take the direct insert path
        // when ordering infrastructure exists (Second UAT: empty queue).
        logger.error("ordered webhook receive failed for White Sheet event", {
          code: error.code,
          message: error.message,
          eventId: event.webhookEventId,
          schemaCache: this.isOrderingSchemaCacheError(error),
        });
        return "error";
      }
    }

    const { data, error } = await this.supabase
      .from("raw_messages")
      .insert({
        line_event_id: event.webhookEventId,
        destination,
        event_type:   event.type,
        source_type:  source.type ?? "user",
        source_id:    getSourceId(source),
        user_id:      getUserId(source),
        message_id:   message?.id   ?? null,
        message_type: (message?.type ?? null) as LineMessageType | null,
        raw_text:     message && "text" in message ? (message as { text: string }).text : null,
        payload:      event,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") return null;
      logger.error("failed to insert raw_message", {
        code:    error.code,
        message: error.message,
        eventId: event.webhookEventId,
      });
      return "error";
    }

    return data.id;
  }

  private async markRawMessageProcessed(rawMessageId: string, log: ChildLogger): Promise<void> {
    const { error } = await this.supabase
      .from("raw_messages")
      .update({ is_processed: true })
      .eq("id", rawMessageId);
    // Leaving it unprocessed is the safe direction: the report then treats the
    // message as unaccounted for and blocks, rather than assuming it landed.
    if (error) log.warn("failed to mark raw message processed", { error: error.message });
  }

  /**
   * Durable evidence that a weighing message was understood but rejected.
   *
   * Without this the path is silent: the parser handles the message, validation
   * fails, the webhook replies to the sender and returns — no produce_session,
   * no pending_session, nothing in parse_errors. A daily report can then never
   * know produce was lost. The existing validation_error type carries it, so no
   * migration is needed.
   *
   * Best-effort by design: a failure to record must not change the reply the
   * sender already gets, and the LINE flow is unchanged either way. Retries of
   * the same webhook event can write more than one row for a raw message;
   * readers count distinct raw_message_id, so a retry cannot inflate anything.
   *
   * Losing this write does NOT lose the blocker. The raw message stays
   * is_processed = false with no produce_session behind it, and P1 reports an
   * unprocessed complete produce message as evidence in its own right (see
   * auditLostProduceMessages). This row is the readable explanation, not the
   * only proof.
   */
  private async recordProduceValidationError(
    rawMessageId: string,
    errors: string[],
    log: ChildLogger,
  ): Promise<void> {
    try {
      const { error } = await this.supabase.from("parse_errors").insert({
        raw_message_id: rawMessageId,
        parser_name:    "weigh-session",
        parser_version: "1.1.0",
        error_type:     "validation_error",
        error_message:  `weigh session validation failed: ${errors.join("; ")}`,
        error_detail:   { validationErrors: errors },
      });
      if (error) {
        log.error("failed to record produce validation error", { error: error.message });
      }
    } catch (err) {
      // Recording evidence must never cost the sender their reply.
      log.error("failed to record produce validation error", { error: String(err) });
    }
  }

  private async recordUnsupportedType(rawMessageId: string, message: LineMessage): Promise<void> {
    await this.supabase.from("parse_errors").insert({
      raw_message_id: rawMessageId,
      parser_name:    "registry",
      parser_version: "1.0.0",
      error_type:     "unsupported_type",
      error_message:  `No parser registered for message type: ${message.type}`,
      error_detail:   { messageType: message.type },
    });
  }
}
