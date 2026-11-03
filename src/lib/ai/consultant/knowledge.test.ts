import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONSULTANT_ACTION_GUIDES,
  CONSULTANT_KNOWLEDGE,
  CONSULTANT_KNOWLEDGE_VERSION,
  findKnowledge,
  getKnowledge,
  type ConsultantKnowledgeTopicId,
  type KnowledgeEntry,
} from "./knowledge";
import type { ConsultantActionId } from "./types";
import { extractBotSummaryQuestion } from "@/lib/ai/line-command";
import type { LineTextMessage } from "@/lib/line/types";
import {
  findDraftItemCommand,
  latestDraftItemAction,
  parseDraftItemCommandLine,
  parseSubunitConfirmCommandLine,
} from "@/lib/parsers/weigh-session/draft-item-command";
import {
  MAIN_SESSION_EXPECTED_CLOSER,
  mainCloserCompatibility,
  mainCloserRefusal,
  mainSessionTypeFromText,
} from "@/lib/parsers/weigh-session/main-closer";
import {
  getWeighSessionFinalizationErrors,
  parseWeighSession,
} from "@/lib/parsers/weigh-session/parser";
import { RE } from "@/lib/parsers/weigh-session/regex";
import type { BaseTransactionType } from "@/lib/parsers/weigh-session/types";
import { parseManualSlipAmounts } from "@/lib/parsers/manual-slip-amount";
import { isExactCancelActiveDraftCommand } from "@/lib/produce/cancel-active-draft";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import { isApprovedProductName } from "@/lib/produce/product-vocabulary";
import { isExactReplaceFinalizedSessionCommand } from "@/lib/produce/replacement-draft";
import { isExactRecoverLatestCommand } from "@/lib/line/pending-produce-recovery";
import { GUIDED_MENU_COPY, GUIDED_MENU_TRIGGER } from "@/lib/line/guided-menu/ux-types";
import { parseWhiteSheetCloseCommand } from "@/lib/line/white-sheet-close-command";
import { parseWhiteSheetNoteCommand } from "@/lib/line/white-sheet-note-command";
import { isSlipCloseCommand, parseSlipSessionHeader } from "@/lib/slips/slip-session-service";
import { isWhiteSheetApproval, whiteSheetReadCommand } from "@/lib/white-sheet-reader/mode";

const REPO_ROOT = process.cwd();

function readSource(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8").normalize("NFC");
}

// The guided-menu modules import webhook-service (and through it the whole
// LINE stack), so they are not imported here. Their exact-match triggers are
// checked against the constants they compare with, and the settlement form is
// checked with the regex literals read straight from the source file.
function regexLiteralFrom(path: string, name: string): RegExp {
  const match = readSource(path).match(new RegExp(`const ${name} = /(.+)/([a-z]*);`));
  if (!match) throw new Error(`regex ${name} not found in ${path}`);
  return new RegExp(match[1], match[2]);
}

const SETTLEMENT_SOURCE = "src/lib/line/guided-menu/settlement-command.ts";
const SETTLEMENT_HEADER_RE = regexLiteralFrom(SETTLEMENT_SOURCE, "HEADER_RE");
const SETTLEMENT_FIELD_RE = regexLiteralFrom(SETTLEMENT_SOURCE, "FIELD_LINE_RE");
const SETTLEMENT_CLOSE_LINE = "จบส่งยอด";

const isGuidedMenuTrigger = (text: string) => text.trim() === GUIDED_MENU_TRIGGER;
const isRoundCloseCommand = (text: string) => text.trim() === GUIDED_MENU_COPY.roundCloseCommand;

/** Same shape rule parseGuidedSettlementCommand applies: header, 4 amounts, close. */
function settlementFormShape(text: string): "ok" | "invalid" {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const labels = new Set<string>();
  let header = 0;
  let close = 0;
  for (const line of lines) {
    if (SETTLEMENT_HEADER_RE.test(line)) header += 1;
    else if (line === SETTLEMENT_CLOSE_LINE) close += 1;
    else {
      const field = SETTLEMENT_FIELD_RE.exec(line);
      if (!field) return "invalid";
      labels.add(field[1]);
    }
  }
  const complete = ["ยอดโอน", "เงินสด", "ค่าใช้จ่าย", "ค่าแรง"].every((label) => labels.has(label));
  return header === 1 && close === 1 && complete ? "ok" : "invalid";
}

function entry(id: ConsultantKnowledgeTopicId): KnowledgeEntry {
  const found = getKnowledge(id);
  if (!found) throw new Error(`missing knowledge entry ${id}`);
  return found;
}

// ── Recognizers: the REAL code decides whether an example is understood ─────

const BOT_DESTINATION = "Ubot-destination";

function botSummaryMessage(text: string): LineTextMessage {
  return { type: "text", id: "m1", text } as LineTextMessage;
}

const DOC_BASE_FOR_ITEMS = "กี้-พาซิโอ้ เบิก 8/10/2569";
const DOC_CLOSER: Record<BaseTransactionType, string> = {
  "เบิก": "จบรายการเบิก",
  "คืน": "จบรายการชั่งคืน",
  "คืนเสีย": "จบรายการคืนเสีย",
};

/**
 * What the system does with one message the worker types. `null` means no
 * recognizer in the repo understands it, i.e. the knowledge taught something
 * the bot would treat as ordinary chat.
 */
function recognize(text: string): string | null {
  if (isExactCancelActiveDraftCommand(text)) return "cancel_draft";
  if (isExactReplaceFinalizedSessionCommand(text)) return "replace_finalized";
  if (isExactRecoverLatestCommand(text)) return "recover_latest";
  if (isGuidedMenuTrigger(text)) return "guided_menu";
  if (isRoundCloseCommand(text)) return "round_close";
  if (isWhiteSheetApproval(text)) return "white_sheet_approval";
  if (isSlipCloseCommand(text)) return "slip_close";
  if (RE.MANUAL_SLIP_CLOSE.test(text.trim())) return "manual_slip_close";

  const itemCommand = findDraftItemCommand(text);
  if (itemCommand) return `draft_item_${itemCommand.kind}`;
  if (parseSubunitConfirmCommandLine(text)) return "subunit_confirm";

  const whiteSheetCommand = whiteSheetReadCommand(botSummaryMessage(text), BOT_DESTINATION);
  if (whiteSheetCommand) return `white_sheet_read_${whiteSheetCommand}`;

  const close = parseWhiteSheetCloseCommand(text);
  if (close.kind === "ok") return "white_sheet_close_form";
  if (settlementFormShape(text) === "ok") return "settlement_form";
  const note = parseWhiteSheetNoteCommand(text);
  if (note.kind === "open" || note.kind === "field" || note.kind === "close" || note.kind === "cancel") {
    return `white_sheet_note_${note.kind}`;
  }

  if (parseSlipSessionHeader(text)) return "slip_open";
  if (RE.MANUAL_SLIP_OPEN.test(text)) return "manual_slip_open";
  const amountLines = text.split("\n").filter((line) => line.trim());
  if (amountLines.length > 0 && parseManualSlipAmounts(text).length === amountLines.length) {
    return "manual_slip_amounts";
  }

  // A single-line main or additional closer.
  const trimmed = text.trim();
  if (!trimmed.includes("\n") && RE.SESSION_END.test(trimmed)) {
    for (const type of ["เบิก", "คืน", "คืนเสีย"] as const) {
      if (trimmed === MAIN_SESSION_EXPECTED_CLOSER[type]) return `closer_${type}`;
    }
    if (RE.ADDITIONAL_END.test(trimmed)) return "closer_additional";
    return mainCloserCompatibility("เบิก", trimmed)?.compatible ? "closer_generic" : null;
  }

  // A header (+ items) opens a document.
  const parsed = parseWeighSession(text);
  const headerOnly = text.split("\n").length === 1;
  if (headerOnly && (RE.SELLER_MARKET.test(trimmed) || RE.ADDITIONAL_HEADER.test(trimmed))) {
    return "header_only";
  }
  if (parsed.items.length > 0 && RE.SESSION_START.test(text)) {
    const additional = parsed.session_kind === "additional";
    const type = additional ? parsed.declared_transaction_type : mainSessionTypeFromText(text);
    if (!type) return null;
    const closer = additional
      ? `จบรายการ${type === "คืน" ? "ชั่งคืน" : type}เพิ่ม`
      : DOC_CLOSER[type];
    const closed = parseWeighSession(`${text}\n${closer}`);
    if (
      closed.parse_errors.length === 0
      && getWeighSessionFinalizationErrors(closed).length === 0
    ) {
      return `${additional ? "doc_additional" : "doc"}_${type}`;
    }
    return null;
  }

  // Item lines on their own: they must read as ordinary items of a draft.
  if (!RE.SESSION_START.test(text)) {
    const draft = parseWeighSession(`${DOC_BASE_FOR_ITEMS}\n${text}\n${DOC_CLOSER["เบิก"]}`);
    if (draft.items.length > 0 && draft.parse_errors.length === 0) return "item_lines";
  }
  return null;
}

/** The recognizer labels each topic's examples are allowed to resolve to. */
const EXPECTED_LABELS: Record<ConsultantKnowledgeTopicId, readonly string[]> = {
  produce_withdrawal: ["doc_เบิก", "closer_เบิก"],
  produce_additional_batch: ["doc_additional_เบิก", "closer_additional"],
  produce_return: ["doc_คืน", "closer_คืน"],
  produce_damaged_return: ["doc_คืนเสีย", "closer_คืนเสีย"],
  item_correction: ["draft_item_correct", "item_lines"],
  item_deletion: ["draft_item_remove"],
  wrong_product_name: ["draft_item_correct", "item_lines"],
  close_submission: ["closer_เบิก", "closer_คืน", "closer_คืนเสีย", "closer_generic"],
  after_close_confirmation: ["subunit_confirm", "closer_เบิก"],
  cancel_open_draft: ["cancel_draft"],
  correct_finalized_document: ["header_only", "replace_finalized"],
  recover_unsaved_messages: ["recover_latest"],
  guided_menu: ["guided_menu"],
  slip_transfer: ["slip_open", "slip_close"],
  slip_manual: ["manual_slip_open", "manual_slip_amounts", "manual_slip_close"],
  settlement_close: ["settlement_form", "round_close"],
  white_sheet_entry: ["white_sheet_close_form"],
  white_sheet_manual: [
    "white_sheet_note_open",
    "white_sheet_note_field",
    "white_sheet_note_close",
    "white_sheet_note_cancel",
  ],
  white_sheet_vision_preview: [
    "white_sheet_read_start",
    "white_sheet_approval",
    "white_sheet_read_end",
    "white_sheet_read_cancel",
  ],
  common_replies: [],
  failed_round_recovery: [],
};

describe("knowledge catalogue shape", () => {
  it("has a dated version", () => {
    expect(CONSULTANT_KNOWLEDGE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("covers every required topic exactly once", () => {
    const ids = CONSULTANT_KNOWLEDGE.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort() as string[]).toEqual(Object.keys(EXPECTED_LABELS).sort());
  });

  it("gives every entry 2-6 short Thai lines, keywords, sources and caveats", () => {
    for (const item of CONSULTANT_KNOWLEDGE) {
      const lines = item.answerThai.split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThanOrEqual(6);
      for (const line of lines) {
        expect(line.trim().length).toBeGreaterThan(0);
        expect(line.length).toBeLessThanOrEqual(120);
      }
      expect(item.answerThai).toContain("ครับ");
      expect(item.titleThai.length).toBeGreaterThan(0);
      expect(item.keywords.length).toBeGreaterThan(0);
      expect(item.sourceRefs.length).toBeGreaterThan(0);
      expect(item.caveats.length).toBeGreaterThan(0);
    }
  });

  it("keeps ids equal to the lookup key", () => {
    for (const item of CONSULTANT_KNOWLEDGE) expect(getKnowledge(item.id)).toBe(item);
    expect(getKnowledge("no_such_topic")).toBeUndefined();
  });
});

describe("every example is understood by the real system", () => {
  for (const item of CONSULTANT_KNOWLEDGE) {
    it(`${item.id}: examples resolve to the expected command`, () => {
      const allowed = EXPECTED_LABELS[item.id];
      if (allowed.length === 0) expect(item.examples).toEqual([]);
      for (const example of item.examples) {
        const label = recognize(example);
        expect({ example, label }).not.toEqual({ example, label: null });
        expect({ example, allowed: allowed.includes(label as string) })
          .toEqual({ example, allowed: true });
      }
    });
  }

  it("topics that teach a command carry at least one example", () => {
    for (const id of [
      "produce_withdrawal", "produce_return", "produce_damaged_return",
      "item_correction", "item_deletion", "close_submission", "cancel_open_draft",
      "correct_finalized_document", "recover_unsaved_messages", "slip_transfer",
      "slip_manual", "white_sheet_entry", "white_sheet_manual",
      "white_sheet_vision_preview",
    ] as const) {
      expect(entry(id).examples.length).toBeGreaterThan(0);
    }
  });

  it("opens each document with the type its topic teaches", () => {
    const typeOf = (id: ConsultantKnowledgeTopicId) =>
      mainSessionTypeFromText(entry(id).examples[0]);
    expect(typeOf("produce_withdrawal")).toBe("เบิก");
    expect(typeOf("produce_return")).toBe("คืน");
    expect(typeOf("produce_damaged_return")).toBe("คืนเสีย");
  });

  it("uses the closer that matches each document header", () => {
    for (const [id, type] of [
      ["produce_withdrawal", "เบิก"],
      ["produce_return", "คืน"],
      ["produce_damaged_return", "คืนเสีย"],
    ] as const) {
      const [doc, closer] = entry(id).examples;
      expect(mainCloserRefusal(doc, closer)).toBeNull();
      expect(closer).toBe(MAIN_SESSION_EXPECTED_CLOSER[type]);
    }
  });

  it("refuses a closer of the wrong type, as the close_submission answer says", () => {
    const [withdrawal] = entry("produce_withdrawal").examples;
    expect(mainCloserRefusal(withdrawal, "จบรายการชั่งคืน")).not.toBeNull();
    expect(mainCloserRefusal(withdrawal, "จบรายการคืนเสีย")).not.toBeNull();
  });
});

describe("worked examples behave the way the answers describe", () => {
  const [withdrawalDoc] = entry("produce_withdrawal").examples;

  it("reads the withdrawal example with seller, market, date and two items", () => {
    const parsed = parseWeighSession(`${withdrawalDoc}\nจบรายการเบิก`);
    expect(parsed.staff_name).toBe("กี้");
    expect(parsed.session_title).toBe("พาซิโอ้");
    expect(parsed.date).toBe("2026-10-08");
    expect(parsed.items.map((item) => item.transaction_type)).toEqual(["เบิก", "เบิก"]);
    expect(parsed.items.map((item) => item.item_number)).toEqual([1, 2]);
    expect(parsed.parse_errors).toEqual([]);
  });

  it("reads the return and damaged-return examples as their own types", () => {
    const returned = parseWeighSession(`${entry("produce_return").examples[0]}\nจบรายการชั่งคืน`);
    const damaged = parseWeighSession(`${entry("produce_damaged_return").examples[0]}\nจบรายการคืนเสีย`);
    expect(returned.items.every((item) => item.transaction_type === "คืน")).toBe(true);
    expect(damaged.items.every((item) => item.transaction_type === "คืนเสีย")).toBe(true);
  });

  it("reads the additional-batch example as an append-only batch", () => {
    const parsed = parseWeighSession(`${entry("produce_additional_batch").examples[0]}\nจบรายการเบิกเพิ่ม`);
    expect(parsed.session_kind).toBe("additional");
    expect(parsed.declared_transaction_type).toBe("เบิก");
    expect(parsed.items).toHaveLength(1);
  });

  it("uses product names the dictionary already approves, so no worker is flagged", () => {
    for (const id of ["produce_withdrawal", "produce_return", "produce_damaged_return", "produce_additional_batch"] as const) {
      const parsed = parseWeighSession(entry(id).examples[0]);
      expect(parsed.items.length).toBeGreaterThan(0);
      for (const item of parsed.items) {
        expect({ id, name: item.product_name, ok: isApprovedProductName(item.product_name) })
          .toEqual({ id, name: item.product_name, ok: true });
      }
    }
  });

  it("accepts the return and damaged-return examples against the withdrawal with no warning", () => {
    const withdrawal = parseWeighSession(`${withdrawalDoc}\nจบรายการเบิก`);
    for (const id of ["produce_return", "produce_damaged_return"] as const) {
      const document = parseWeighSession(`${entry(id).examples[0]}\nจบรายการ`);
      const result = validateProduceEntry({
        parsed: document,
        roundRows: withdrawal.items.map((item) => ({
          product_name: item.product_name,
          unit: item.unit,
          quantity: item.quantity,
          price_per_unit: item.price_per_unit,
          transaction_type: item.transaction_type,
        })),
        roundBound: true,
      });
      expect({ id, status: result.status }).toEqual({ id, status: "clean" });
      expect(result.advisories).toEqual([]);
      expect(result.reconciliation).toEqual([]);
    }
  });

  it("แก้ข้อ then the new item replaces only that item", () => {
    const [command, replacement] = entry("item_correction").examples;
    const before = parseWeighSession(`${withdrawalDoc}\nจบรายการเบิก`);
    const after = parseWeighSession([withdrawalDoc, command, replacement, "จบรายการเบิก"].join("\n"));

    expect(after.parse_errors).toEqual([]);
    expect(after.items).toHaveLength(before.items.length);
    expect(after.items[0]).toMatchObject({
      product_name: before.items[0].product_name,
      quantity: before.items[0].quantity,
    });
    expect(after.items[1]).toMatchObject({
      item_number: 2,
      product_name: "กล้วยหอม",
      price_per_unit: 35,
      quantity: 12,
      unit: "หวี",
    });
    expect(latestDraftItemAction(after)).toMatchObject({ kind: "correct", item_number: 2, status: "applied" });
  });

  it("แก้ข้อ alone waits for the replacement and keeps every item", () => {
    const [command] = entry("item_correction").examples;
    const waiting = parseWeighSession([withdrawalDoc, command].join("\n"));
    expect(latestDraftItemAction(waiting)).toMatchObject({ status: "awaiting_replacement", item_number: 2 });
    expect(waiting.items).toHaveLength(2);
  });

  it("fixes a wrong product name without keeping the old spelling", () => {
    const wrong = [
      "กี้-พาซิโอ้ เบิก 8/10/2569",
      "1. มังคุดด 45 บาท",
      "10 โล",
    ].join("\n");
    const [command, replacement] = entry("wrong_product_name").examples;
    const parsed = parseWeighSession([wrong, command, replacement, "จบรายการเบิก"].join("\n"));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].product_name).toBe("มังคุด");
  });

  it("ลบข้อ removes exactly that item and the others stay", () => {
    const [command] = entry("item_deletion").examples;
    const threeItems = [
      withdrawalDoc,
      "3. แตงโม 20 บาท",
      "5 ลูก",
    ].join("\n");
    const parsed = parseWeighSession([threeItems, command, "จบรายการเบิก"].join("\n"));
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items.map((item) => item.product_name)).toEqual(["มังคุด", "กล้วยหอม"]);
    expect(latestDraftItemAction(parsed)).toMatchObject({ kind: "remove", item_number: 3, status: "applied" });
  });

  it("ลบข้อ for a missing number changes nothing and says so", () => {
    const parsed = parseWeighSession([withdrawalDoc, "ลบข้อ 9", "จบรายการเบิก"].join("\n"));
    expect(parsed.items).toHaveLength(2);
    expect(latestDraftItemAction(parsed)).toMatchObject({ status: "target_not_found" });
  });

  it("accepts a number plus selector letter exactly as the system prints it", () => {
    expect(parseDraftItemCommandLine("แก้ข้อ 52B")).toEqual({ kind: "correct", itemNumber: 52, occurrence: 2 });
    expect(parseDraftItemCommandLine("ลบข้อ 4")).toEqual({ kind: "remove", itemNumber: 4 });
  });

  it("cancel is an exact command: lookalikes mean something else", () => {
    expect(isExactCancelActiveDraftCommand("ยกเลิกรายการ")).toBe(true);
    expect(isExactCancelActiveDraftCommand("  ยกเลิกรายการ ")).toBe(true);
    expect(isExactCancelActiveDraftCommand("ยกเลิก")).toBe(false);
    expect(isExactCancelActiveDraftCommand("ยกเลิกรายการนี้")).toBe(false);
    // The menu words only close the menu; they are not the cancel command.
    expect(readSource("src/lib/line/guided-menu/ux-handler.ts"))
      .toContain('trimmed === "ยกเลิก" || trimmed === "ออกจากเมนู"');
  });

  it("the replacement command only matches the exact phrase", () => {
    expect(isExactReplaceFinalizedSessionCommand("แก้ไขรายการที่ปิดแล้ว")).toBe(true);
    expect(isExactReplaceFinalizedSessionCommand("แก้ไขรายการ")).toBe(false);
  });

  it("white sheet forms need the money fields the answer lists", () => {
    const [form] = entry("white_sheet_entry").examples;
    const withoutCash = form.split("\n").filter((line) => !line.startsWith("เงินสด")).join("\n");
    const withoutSales = form.split("\n").filter((line) => !line.startsWith("ยอดขาย")).join("\n");
    expect(parseWhiteSheetCloseCommand(form).kind).toBe("ok");
    expect(parseWhiteSheetCloseCommand(withoutCash).kind).toBe("invalid");
    expect(parseWhiteSheetCloseCommand(withoutSales).kind).toBe("invalid");
  });

  it("the settlement form needs all four lines, as the answer says", () => {
    const [form] = entry("settlement_close").examples;
    expect(settlementFormShape(form)).toBe("ok");
    const withoutLabor = form.split("\n").filter((line) => !line.startsWith("ค่าแรง")).join("\n");
    expect(settlementFormShape(withoutLabor)).toBe("invalid");
  });

  it("every accepted slip close word is listed in the slip caveat", () => {
    const caveat = entry("slip_transfer").caveats.join("\n");
    for (const word of ["จบสลิป", "สรุปสลิป", "ปิดชุดสลิป", "จบชุดสลิป"]) {
      expect(isSlipCloseCommand(word)).toBe(true);
      expect(caveat).toContain(word);
    }
  });

  it("the slip header example names seller, market and date", () => {
    const header = parseSlipSessionHeader(entry("slip_transfer").examples[0]);
    expect(header).toMatchObject({ sellerName: "กี้", marketName: "พาซิโอ้", slipDate: "8/10/2569" });
  });

  it("the vision preview words come from @Botsummary and nothing else", () => {
    const start = entry("white_sheet_vision_preview").examples[0];
    expect(extractBotSummaryQuestion(botSummaryMessage(start), BOT_DESTINATION)).toBe("อ่านใบขาว");
    expect(whiteSheetReadCommand(botSummaryMessage("อ่านใบขาว"), BOT_DESTINATION)).toBeNull();
  });
});

describe("sourceRefs prove the behavior", () => {
  const everyRef = [
    ...CONSULTANT_KNOWLEDGE.flatMap((item) => item.sourceRefs.map((ref) => ({ owner: item.id, ref }))),
    ...Object.entries(CONSULTANT_ACTION_GUIDES).flatMap(([owner, guide]) =>
      guide.sourceRefs.map((ref) => ({ owner, ref }))),
  ];

  it("lists at least one reference for every action guide", () => {
    for (const guide of Object.values(CONSULTANT_ACTION_GUIDES)) {
      expect(guide.sourceRefs.length).toBeGreaterThan(0);
    }
  });

  it("points only at files that exist", () => {
    for (const { owner, ref } of everyRef) {
      const path = ref.split("#")[0];
      expect({ owner, ref, exists: existsSync(join(REPO_ROOT, path)) })
        .toEqual({ owner, ref, exists: true });
    }
  });

  it("names a symbol or text that really occurs in the referenced file", () => {
    for (const { owner, ref } of everyRef) {
      const [path, symbol] = ref.split("#");
      if (!symbol) continue;
      const source = readFileSync(join(REPO_ROOT, path), "utf8").normalize("NFC");
      expect({ owner, ref, found: source.includes(symbol.normalize("NFC")) })
        .toEqual({ owner, ref, found: true });
    }
  });
});

describe("worker-facing text stays plain", () => {
  // Terms that must never reach a frontline worker.
  const FORBIDDEN = [
    "failed_closed", "terminalized", "partial_capture", "session", "pending",
    "finalize", "finalization", "null", "undefined", "webhook", "generation",
    "accountability", "outbox", "fingerprint", "digest", "rpc", "payload",
    "idempotent", "runtime", "database", "supabase", "error", "status",
  ];
  const workerText = [
    ...CONSULTANT_KNOWLEDGE.map((item) => ({ where: `${item.id}.answerThai`, text: item.answerThai })),
    ...CONSULTANT_KNOWLEDGE.flatMap((item) =>
      item.caveats.map((text, index) => ({ where: `${item.id}.caveats[${index}]`, text }))),
    ...CONSULTANT_KNOWLEDGE.map((item) => ({ where: `${item.id}.titleThai`, text: item.titleThai })),
    ...Object.entries(CONSULTANT_ACTION_GUIDES).flatMap(([id, guide]) => [
      { where: `${id}.titleThai`, text: guide.titleThai },
      { where: `${id}.howToThai`, text: guide.howToThai },
    ]),
  ];

  it("contains none of the forbidden internal terms", () => {
    for (const { where, text } of workerText) {
      const lower = text.toLowerCase();
      for (const term of FORBIDDEN) {
        expect({ where, term, present: lower.includes(term) }).toEqual({ where, term, present: false });
      }
    }
  });

  it("contains no English words other than the bot's own name", () => {
    for (const { where, text } of workerText) {
      const withoutName = text.replace(/@Botsummary/giu, "");
      expect({ where, latin: withoutName.match(/[A-Za-z]{2,}/u)?.[0] ?? null })
        .toEqual({ where, latin: null });
    }
  });

  it("answers in Thai", () => {
    for (const item of CONSULTANT_KNOWLEDGE) {
      expect(/[฀-๿]/u.test(item.answerThai)).toBe(true);
    }
  });
});

describe("findKnowledge routes worker questions", () => {
  const cases: Array<[string, ConsultantKnowledgeTopicId]> = [
    ["เบิกของต้องพิมพ์ยังไง", "produce_withdrawal"],
    ["ชั่งคืนต้องทำยังไง", "produce_return"],
    ["ถ้าพิมพ์ชื่อผักผิดต้องแก้ยังไง", "wrong_product_name"],
    ["ส่งสลิปยังไง", "slip_transfer"],
    ["ใบขาวใช้ยังไง", "white_sheet_entry"],
    ["จบรายการแล้วต้องทำอะไรต่อ", "after_close_confirmation"],
    ["คืนเสียพิมพ์ยังไง", "produce_damaged_return"],
    ["ลบข้อทำยังไง", "item_deletion"],
    ["แก้ข้อทำยังไง", "item_correction"],
    ["จบรายการต้องพิมพ์ยังไง", "close_submission"],
    ["เปิดรายการผิดตลาด ยกเลิกยังไง", "cancel_open_draft"],
    ["บันทึกไปแล้วอยากแก้ทำยังไง", "correct_finalized_document"],
    ["กู้รายการล่าสุดคืออะไร", "recover_unsaved_messages"],
    ["สลิปมือพิมพ์ยังไง", "slip_manual"],
    ["ส่งยอดต้องทำยังไง", "settlement_close"],
    ["ใบขาวมือส่งยังไง", "white_sheet_manual"],
    ["ให้บอทอ่านรูปใบขาวได้ไหม", "white_sheet_vision_preview"],
    ["เบิกเพิ่มพิมพ์ยังไง", "produce_additional_batch"],
    ["กดเมนูแล้วไม่ขึ้น", "guided_menu"],
    ["รายการหาย ไม่ขึ้นบันทึกแล้ว", "failed_round_recovery"],
    ["บอทตอบว่าไม่พบรอบเบิกแปลว่าอะไร", "common_replies"],
  ];

  for (const [question, expected] of cases) {
    it(`"${question}" -> ${expected}`, () => {
      const results = findKnowledge(question);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(expected);
    });
  }

  it("ignores spaces and Unicode form", () => {
    expect(findKnowledge("ชั่ง คืน ต้อง ทำ ยังไง")[0]?.id).toBe("produce_return");
    expect(findKnowledge("ชั่งคืน".normalize("NFD"))[0]?.id).toBe("produce_return");
  });

  it("returns at most three matches, strongest first, and is deterministic", () => {
    const first = findKnowledge("ใบขาวมือ ใบขาว อ่านใบขาว สลิป เบิก คืน");
    expect(first.length).toBeLessThanOrEqual(3);
    expect(findKnowledge("ใบขาวมือ ใบขาว อ่านใบขาว สลิป เบิก คืน").map((item) => item.id))
      .toEqual(first.map((item) => item.id));
  });

  it("returns nothing for an unrelated or empty question", () => {
    expect(findKnowledge("")).toEqual([]);
    expect(findKnowledge("   ")).toEqual([]);
    expect(findKnowledge("วันนี้อากาศดีไหม")).toEqual([]);
  });
});

describe("action guides", () => {
  const ACTION_IDS: ConsultantActionId[] = [
    "correct_item_in_open_draft",
    "remove_item_in_open_draft",
    "send_close_again",
    "confirm_review",
    "wait_for_finalization",
    "contact_admin_recovery",
    "nothing_needed",
    "start_new_document",
  ];

  it("has a guide for every ConsultantActionId and nothing extra", () => {
    expect(Object.keys(CONSULTANT_ACTION_GUIDES).sort()).toEqual([...ACTION_IDS].sort());
    for (const id of ACTION_IDS) {
      const guide = CONSULTANT_ACTION_GUIDES[id];
      expect(guide.titleThai.length).toBeGreaterThan(0);
      expect(guide.howToThai.length).toBeGreaterThan(0);
      expect(/[฀-๿]/u.test(guide.howToThai)).toBe(true);
    }
  });

  it("only quotes commands the system recognizes", () => {
    const quoted = (text: string) => [...text.matchAll(/“([^”]+)”/gu)].map((match) => match[1]);
    const KNOWN_COMMAND = (command: string): boolean =>
      recognize(command) !== null
      // Fragments the guide uses as a command prefix; the number follows.
      || ["แก้ข้อ", "ลบข้อ", "ยืนยันข้อ"].includes(command);
    const NOT_COMMANDS = new Set(["บันทึกแล้ว", "ดูสถานะ"]);
    for (const [id, guide] of Object.entries(CONSULTANT_ACTION_GUIDES)) {
      for (const command of quoted(guide.howToThai)) {
        if (NOT_COMMANDS.has(command)) continue;
        expect({ id, command, known: KNOWN_COMMAND(command) }).toEqual({ id, command, known: true });
      }
    }
  });

  it("is honest that recovery after a closed-without-saving round is an admin job", () => {
    const guide = CONSULTANT_ACTION_GUIDES.contact_admin_recovery;
    expect(guide.howToThai).toContain("ผู้ดูแล");
    expect(guide.howToThai).toContain("ไม่มีคำสั่งให้พนักงานกู้เอง");
  });
});
