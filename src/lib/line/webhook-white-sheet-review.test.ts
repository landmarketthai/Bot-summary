import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { LineMessageEvent } from "./types";
import { PREVIEW_TTL_MS, resolveWhiteSheetSession, SESSION_MAX_AGE_MS } from "@/lib/white-sheet-reader/mode";
import {
  applyWhiteSheetCorrection, APPROVAL_RETRY_REPLY, CORRECTION_CAPTURE_FAILED_REPLY, CORRECTION_RETRY_REPLY, MISSING_REVIEW_BASE_REPLY,
  PREVIEW_APPROVED_REPLY, PREVIEW_END_REFUSED_REPLY, PREVIEW_END_REPLY, PREVIEW_PENDING_REVIEW_REPLY,
  PREVIEW_RESTART_REPLY, PREVIEW_START_REPLY, renderWhiteSheetPreview, type WhiteSheetBaseRead,
} from "@/lib/white-sheet-reader/reader";
import { CorrectionInvalidError, CorrectionUnavailableError, type CorrectionPatch } from "@/lib/white-sheet-reader/correction";
import { readAndRecordSheet, reviewApproval, reviewCorrectionTurn } from "@/lib/white-sheet-reader/review-flow";
import { loadAcceptedApprovals, recordTurn } from "@/lib/white-sheet-reader/review-turns";
import { parseWhiteSheetPreview, type WhiteSheetPreview } from "@/lib/white-sheet-reader/schema";
import { ReviewDatabase } from "@/lib/white-sheet-reader/test-review-database";
import { WebhookService } from "./webhook-service";

afterEach(() => setSystemTime());

function event(id: string, text?: string, userId = "U1", timestamp = Date.now() - 1000, groupId = "G1"): LineMessageEvent {
  return { type: "message", webhookEventId: `event-${id}`, timestamp,
    deliveryContext: { isRedelivery: false }, source: { type: "group", groupId, userId },
    mode: "active", replyToken: `reply-${id}`, message: text === undefined
      ? { id, type: "image", quoteToken: id, contentProvider: { type: "line" } }
      : { id, type: "text", quoteToken: id, text } };
}
const START = "@Botsummary อ่านใบขาว";
const REAL_CORRECTION = "ตลาดพาสิโอ้ผัก\nวันที่ 6 ตุลาคม 2569\nขวัญ+จ๋า\nค่าใช้จ่าย ให้เจ้ 400 ของไหว้ 25 เทปกาว 40 น้ำแข็ง 200";

// The real Production reading: sales/transfer/cash read, everything else unclear.
const VISION: WhiteSheetPreview = {
  documentType: "white_sheet", market: null, dateRaw: null, dateIso: null, sellerNames: [],
  salesAmountBaht: 7170, transferAmountBaht: 865, cashSentAmountBaht: 1640, laborAmountBaht: null,
  remainingCashAmountBaht: null,
  expenses: [
    { labelRaw: null, amountBaht: 400, confidence: 0.6 }, { labelRaw: null, amountBaht: 25, confidence: 0.6 },
    { labelRaw: null, amountBaht: 40, confidence: 0.6 }, { labelRaw: null, amountBaht: null, confidence: 0.3 },
  ],
  lowConfidenceFields: ["market", "dateRaw", "dateIso", "sellerNames", "expenses[0].labelRaw", "expenses[1].labelRaw",
    "expenses[2].labelRaw", "expenses[3].labelRaw", "expenses[3].amountBaht"],
  overallConfidence: 0.95, notes: ["ตลาดอ่านไม่ชัด"],
};
// What a second Vision run could read differently. It must never reach a correction.
const DRIFTED: WhiteSheetPreview = { ...VISION, salesAmountBaht: 9999, transferAmountBaht: 1, cashSentAmountBaht: 2, market: "ตลาดอื่น", lowConfidenceFields: [] };

const none = { action: "none" as const };
const patchOf = (fields: Partial<CorrectionPatch> = {}): CorrectionPatch => ({
  market: { ...none, value: null }, date: { ...none, raw: null, day: null, month: null, year: null },
  sellerNames: { ...none, value: [] },
  salesAmountBaht: { ...none, value: null }, transferAmountBaht: { ...none, value: null },
  cashSentAmountBaht: { ...none, value: null }, laborAmountBaht: { ...none, value: null },
  remainingCashAmountBaht: { ...none, value: null }, expenses: { mode: "none", items: [] }, ...fields,
});
const realPatch = patchOf({
  market: { action: "set", value: "พาสิโอ้ผัก" },
  date: { action: "set", raw: "6 ตุลาคม 2569", day: 6, month: 10, year: 2569 },
  sellerNames: { action: "set", value: ["ขวัญ", "จ๋า"] },
  expenses: { mode: "replace_all", items: [
    { position: null, label: "ให้เจ้", amount: 400 }, { position: null, label: "ของไหว้", amount: 25 },
    { position: null, label: "เทปกาว", amount: 40 }, { position: null, label: "น้ำแข็ง", amount: 200 }] },
});
const labor = (value: number) => patchOf({ laborAmountBaht: { action: "set", value } });

type PatchFor = (text: string, call: number) => Promise<CorrectionPatch>;
function setup(options: { readerEnabled?: boolean; patchFor?: PatchFor } = {}) {
  const db = new ReviewDatabase();
  const replies: string[] = [], asked: string[] = [];
  const reads: string[] = [], applied: { base: WhiteSheetPreview; text: string }[] = [];
  const parseCalls = new Map<string, number>();
  let slipLookups = 0;
  const patchFor: PatchFor = options.patchFor ?? (async (text) => (text === REAL_CORRECTION ? realPatch : labor(300)));
  const dependencies = {
    botSummaryAnalystEnabled: true, botSummaryAnalystSourceAllowed: () => true,
    whiteSheetReaderEnabled: options.readerEnabled ?? true,
    botSummaryAnalystAnswerer: async (question: string) => { asked.push(question); return "ยอดขายวันนี้"; },
    // The first read returns VISION; any later read would return DRIFTED.
    whiteSheetBaseReader: async (id: string): Promise<WhiteSheetBaseRead> => {
      reads.push(id);
      const snapshot = parseWhiteSheetPreview(reads.length === 1 ? VISION : DRIFTED);
      return { outcome: "applied", snapshot, replies: renderWhiteSheetPreview(snapshot, "review") };
    },
    whiteSheetCorrectionApplier: (base: WhiteSheetPreview, text: string) => {
      applied.push({ base, text });
      return applyWhiteSheetCorrection(base, text, async (message) => {
        const call = (parseCalls.get(message) ?? 0) + 1; parseCalls.set(message, call);
        return patchFor(message, call);
      });
    },
    replyMessage: async (_token: string, text: string) => { replies.push(text); },
    slipSessionService: {
      findActiveSession: async () => { slipLookups++; return null; },
      openSession: async () => { throw new Error("must not open"); },
    },
    guidedJourneyService: { resolve: async () => ({ stage: "idle", reason: "no_session" }) } as never,
    settlementSheetImageHandler: { handleImage: async () => { throw new Error("must not save settlement draft"); } } as never,
    evidenceIngestor: { ingest: async () => { throw new Error("must not save slip evidence"); } },
  };
  const service = new WebhookService(db.client(), dependencies);
  return { db, dependencies, service, replies, asked, reads, applied, parseCalls, slipLookups: () => slipLookups,
    send: (...events: LineMessageEvent[]) => service.processEvents(events, "Ubot"),
    /** Re-run the queue worker over an already processed event (queue retry / lease reclaim). */
    reprocess: async (rawMessageId: string) => {
      const row = db.rows("line_webhook_event_queue").find((queued) => queued.raw_message_id === rawMessageId)!;
      row.status = "pending";
      await service.recoverPendingOrderedEvents();
    },
    rawIdOf: (messageId: string) => db.rows("raw_messages").find((row) => row.message_id === messageId)!.id as string,
  };
}
const snapshotOf = (s: ReturnType<typeof setup>, messageId: string) =>
  s.db.turns().find((row) => row.raw_message_id === s.rawIdOf(messageId))?.snapshot as WhiteSheetPreview;

describe("White Sheet review: one Vision read, stored base", () => {
  it("opens, reads once and stores the exact validated base that was rendered", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"));
    expect(s.replies).toEqual([PREVIEW_START_REPLY, renderWhiteSheetPreview(parseWhiteSheetPreview(VISION), "review").join("\n")]);
    expect(s.reads).toEqual(["img1"]);
    const [base] = s.db.turns();
    expect(base).toMatchObject({ kind: "base", outcome: "applied", raw_message_id: s.rawIdOf("img1"),
      sheet_image_raw_id: s.rawIdOf("img1"), parent_raw_message_id: null, destination: "Ubot", source_id: "G1", user_id: "U1" });
    expect(base.snapshot).toEqual(parseWhiteSheetPreview(VISION));
    expect(s.asked).toEqual([]); expect(s.slipLookups()).toBe(0); expect(s.db.onlyReviewLedgerWrites()).toBe(true);
  });
  it("a correction never re-runs Vision: a market-only correction cannot change sales, transfer, cash or expenses", async () => {
    const s = setup({ patchFor: async () => patchOf({ market: { action: "set", value: "พาสิโอ้ผัก" } }) });
    await s.send(event("cmd", START), event("img1"), event("fix", "ตลาดพาสิโอ้ผัก"));
    expect(s.reads).toEqual(["img1"]); // DRIFTED was never read
    const merged = snapshotOf(s, "fix");
    const base = parseWhiteSheetPreview(VISION);
    expect(merged.market).toBe("พาซิโอ้ผัก");
    expect([merged.salesAmountBaht, merged.transferAmountBaht, merged.cashSentAmountBaht]).toEqual([7170, 865, 1640]);
    expect(merged.expenses).toEqual(base.expenses);
    expect(merged.dateRaw).toBe(base.dateRaw); expect(merged.sellerNames).toEqual(base.sellerNames);
    expect(merged.lowConfidenceFields).toEqual(base.lowConfidenceFields.filter((path) => path !== "market"));
    expect(s.replies.at(-1)).toContain("ยอดขาย: 7,170 บาท");
  });
  it("a labor-only correction cannot change any untouched Vision field", async () => {
    const s = setup({ patchFor: async () => labor(300) });
    await s.send(event("cmd", START), event("img1"), event("fix", "ค่าแรงจริง 300"));
    const merged = snapshotOf(s, "fix"), base = parseWhiteSheetPreview(VISION);
    expect(merged.laborAmountBaht).toBe(300);
    expect({ ...merged, laborAmountBaht: base.laborAmountBaht, notes: [] }).toEqual({ ...base, notes: [] });
    expect(s.reads).toEqual(["img1"]);
  });
  it("turns the real Production correction into the full corrected preview", async () => {
    const s = setup({ patchFor: async () => realPatch });
    await s.send(event("cmd", START), event("img1"), event("fix", REAL_CORRECTION));
    expect(s.replies.at(-1)).toBe([
      "แก้ผลอ่านใบขาวแล้ว (รอตรวจ)",
      "ตลาด: พาซิโอ้ผัก\nวันที่: 6 ต.ค. 2569\nคนขาย: ขวัญ + จ๋า",
      "ยอดขาย: 7,170 บาท\nเงินโอน: 865 บาท\nส่งเงินสด: 1,640 บาท\nค่าแรง: ไม่พบ\nเหลือเงินสด: ไม่พบ",
      "ค่าใช้จ่าย:\n1. ให้เจ้ — 400 บาท\n2. ของไหว้ — 25 บาท\n3. เทปกาว — 40 บาท\n4. น้ำแข็ง — 200 บาท",
      "ตรวจอีกครั้ง ถ้าถูกแล้วพิมพ์ \"ผ่าน\" ครับ",
      "ข้อมูลนี้ยังไม่ได้บันทึกลงระบบ เป็นเพียงผลอ่านจากภาพครับ",
    ].join("\n\n"));
  });
  it("the second correction starts from the snapshot the first one produced", async () => {
    const s = setup({ patchFor: async (text) => (text === "a" ? labor(300) : patchOf({ transferAmountBaht: { action: "set", value: 900 } })) });
    await s.send(event("cmd", START), event("img1"), event("a", "a"), event("b", "b"));
    expect(s.applied[1].base).toEqual(snapshotOf(s, "a"));
    expect(s.applied[1].base.laborAmountBaht).toBe(300);
    const final = snapshotOf(s, "b");
    expect([final.laborAmountBaht, final.transferAmountBaht]).toEqual([300, 900]);
    const [base, first, second] = s.db.turns();
    expect(first.parent_raw_message_id).toBe(base.raw_message_id);
    expect(second.parent_raw_message_id).toBe(first.raw_message_id);
  });
  it("works across separate Vercel instances: state comes only from the stored rows and webhook history", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("a", "a"));
    await new WebhookService(s.db.client(), s.dependencies).processEvents([event("b", "b")], "Ubot");
    expect(s.applied.map((call) => call.text)).toEqual(["a", "b"]);
    expect(s.reads).toEqual(["img1"]);
  });
});

describe("White Sheet review: each correction is evaluated exactly once", () => {
  it("a failed correction stays failed forever and never applies after a later correction", async () => {
    const s = setup({ patchFor: async (text, call) => (text === "bad" ? (call === 1 ? patchOf() : labor(999)) : patchOf({ transferAmountBaht: { action: "set", value: 900 } })) });
    await s.send(event("cmd", START), event("img1"), event("bad", "bad"));
    expect(s.replies.at(-1)).toBe(CORRECTION_CAPTURE_FAILED_REPLY);
    expect(s.db.turns().find((row) => row.raw_message_id === s.rawIdOf("bad"))).toMatchObject({ outcome: "failed", snapshot: null });
    await s.send(event("good", "good"));
    await s.reprocess(s.rawIdOf("bad")); // queue retry / lease reclaim of the failed message
    await s.send(event("later", "later"));
    expect(s.parseCalls.get("bad")).toBe(1); // the model never saw it a second time
    expect(s.replies.filter((reply) => reply === CORRECTION_CAPTURE_FAILED_REPLY)).toHaveLength(2); // original + replayed outcome
    for (const turn of s.db.turns()) expect((turn.snapshot as WhiteSheetPreview | null)?.laborAmountBaht ?? null).toBeNull();
    expect(snapshotOf(s, "later").transferAmountBaht).toBe(900);
    expect(s.db.turns().filter((row) => row.outcome === "applied" && row.kind === "turn")).toHaveLength(2);
  });
  it("a provider outage stays unavailable forever and is never silently applied later", async () => {
    const s = setup({ patchFor: async (text, call) => {
      if (text === "down" && call === 1) throw new CorrectionUnavailableError("outage");
      return text === "down" ? labor(999) : patchOf({ transferAmountBaht: { action: "set", value: 900 } });
    } });
    await s.send(event("cmd", START), event("img1"), event("down", "down"));
    expect(s.replies.at(-1)).toBe(CORRECTION_RETRY_REPLY);
    expect(s.db.turns().find((row) => row.raw_message_id === s.rawIdOf("down"))).toMatchObject({ outcome: "unavailable", snapshot: null });
    await s.send(event("next", "next"));
    await s.reprocess(s.rawIdOf("down"));
    await s.send(event("again", "again"));
    expect(s.parseCalls.get("down")).toBe(1);
    expect(s.replies.filter((reply) => reply === CORRECTION_RETRY_REPLY)).toHaveLength(2);
    for (const turn of s.db.turns()) expect((turn.snapshot as WhiteSheetPreview | null)?.laborAmountBaht ?? null).toBeNull();
  });
  it("an invalid model answer is a recorded failure, never a legacy parser fallthrough", async () => {
    const s = setup({ patchFor: async () => { throw new CorrectionInvalidError("bad output"); } });
    await s.send(event("cmd", START), event("img1"), event("fix", REAL_CORRECTION));
    expect(s.replies.at(-1)).toBe(CORRECTION_CAPTURE_FAILED_REPLY);
    expect(s.slipLookups()).toBe(0); expect(s.db.onlyReviewLedgerWrites()).toBe(true);
    await s.send(event("ok", "ผ่าน")); // the sheet is still under review
    expect(s.replies.at(-1)).toBe(PREVIEW_APPROVED_REPLY);
  });
  it("redelivery of a correction or of the image calls neither Vision nor the correction model again", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("fix", "fix"));
    const readsBefore = s.reads.length, parsesBefore = s.parseCalls.get("fix");
    await s.reprocess(s.rawIdOf("fix"));
    await s.reprocess(s.rawIdOf("img1"));
    expect(s.reads.length).toBe(readsBefore); expect(s.parseCalls.get("fix")).toBe(parsesBefore);
    expect(s.db.turns()).toHaveLength(2);
  });
  it("a replayed applied correction re-renders the stored snapshot, not a recomputation", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("fix", "fix"));
    const first = s.replies.at(-1);
    await s.reprocess(s.rawIdOf("fix"));
    expect(s.replies.at(-1)).toBe(first);
  });
  it("recording the same raw_message_id twice is idempotent", async () => {
    const db = new ReviewDatabase(); const client = db.client();
    const scope = { destination: "Ubot", sourceId: "G1", userId: "U1", sheetImageRawId: "raw-img" };
    const snapshot = parseWhiteSheetPreview(VISION);
    const base = { rawMessageId: "raw-img", kind: "base" as const, outcome: "applied" as const, snapshot };
    expect(await recordTurn(client, scope, base)).toBe("recorded");
    expect(await recordTurn(client, scope, { ...base, outcome: "failed", snapshot: undefined })).toBe("duplicate");
    expect(db.turns()).toHaveLength(1); expect(db.turns()[0].outcome).toBe("applied");
  });
  it("two ordered corrections can never branch from the same snapshot", async () => {
    const db = new ReviewDatabase(); const client = db.client();
    const scope = { destination: "Ubot", sourceId: "G1", userId: "U1" };
    const snapshot = parseWhiteSheetPreview(VISION);
    await readAndRecordSheet(client, scope, "raw-img", "img", { readBase: async () => ({ outcome: "applied", snapshot, replies: ["base"] }) });
    const patches: Record<string, CorrectionPatch> = { A: labor(300), B: patchOf({ transferAmountBaht: { action: "set", value: 900 } }) };
    // Turn A is evaluated while turn B (read from the same base) completes first, as a lease-expired worker would.
    const apply = (turn: string): typeof applyWhiteSheetCorrection => async (base, text) => {
      if (turn === "A") await reviewCorrectionTurn(client, scope, "raw-img", "raw-B", "B", { applyCorrection: apply("B") });
      return applyWhiteSheetCorrection(base, text, async () => patches[turn]);
    };
    const replyA = await reviewCorrectionTurn(client, scope, "raw-img", "raw-A", "A", { applyCorrection: apply("A") });
    expect(replyA).toEqual([CORRECTION_RETRY_REPLY]);
    const applied = db.turns().filter((row) => row.outcome === "applied" && row.kind === "turn");
    expect(applied.map((row) => row.raw_message_id)).toEqual(["raw-B"]);
    expect(db.turns().find((row) => row.raw_message_id === "raw-A")).toMatchObject({ outcome: "unavailable", snapshot: null });
    // The chain stays linear: a following correction builds on B, never on a lost A.
    const seen: WhiteSheetPreview[] = [];
    await reviewCorrectionTurn(client, scope, "raw-img", "raw-C", "C", { applyCorrection: async (base) => {
      seen.push(base); return { outcome: "failed", replies: [CORRECTION_CAPTURE_FAILED_REPLY] };
    } });
    expect(seen[0].transferAmountBaht).toBe(900); expect(seen[0].laborAmountBaht).toBeNull();
  });
  it("the ordered worker hands one event per source to one worker at a time", async () => {
    // Evidence for the concurrency claim: the claim query refuses a later event while an earlier one is open.
    const sql = (await import("node:fs")).readFileSync("supabase/migrations/20260930090000_line_webhook_stale_queue_review.sql", "utf8");
    expect(sql).toMatch(/NOT EXISTS[\s\S]*earlier\.status IN \('pending', 'processing'\)/u);
    expect(sql).toMatch(/FOR UPDATE OF q SKIP LOCKED/u);
  });
});

describe("White Sheet review: stored state is untrusted and never revives a session", () => {
  it("a malformed stored snapshot fails closed with the restart message and no model call", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"));
    s.db.turns()[0].snapshot = { documentType: "white_sheet", salesAmountBaht: "lots" };
    await s.send(event("fix", "fix"));
    expect(s.replies.at(-1)).toBe(MISSING_REVIEW_BASE_REPLY);
    expect(s.applied).toEqual([]); expect(s.reads).toEqual(["img1"]); expect(s.slipLookups()).toBe(0);
    expect(s.db.turns()).toHaveLength(1); // nothing recorded for the refused message
  });
  it("a missing base (Vision never succeeded) never re-runs Vision", async () => {
    const s = setup();
    s.dependencies.whiteSheetBaseReader = async () => ({ outcome: "unavailable", replies: ["retry"] });
    await new WebhookService(s.db.client(), s.dependencies).processEvents([event("cmd", START), event("img1"), event("fix", "fix")], "Ubot");
    expect(s.db.turns()[0]).toMatchObject({ kind: "base", outcome: "unavailable", snapshot: null });
    expect(s.replies.at(-1)).toBe(MISSING_REVIEW_BASE_REPLY);
    expect(s.applied).toEqual([]);
  });
  it("a failed base (not a white sheet) is not a base for corrections", async () => {
    const s = setup();
    s.dependencies.whiteSheetBaseReader = async () => ({ outcome: "failed", replies: ["unknown"] });
    await new WebhookService(s.db.client(), s.dependencies).processEvents([event("cmd", START), event("img1"), event("fix", "fix")], "Ubot");
    expect(s.replies.at(-1)).toBe(MISSING_REVIEW_BASE_REPLY);
  });
  it("a base that cannot be stored is not shown and later corrections cannot start from it", async () => {
    const s = setup(); s.db.failTurnInserts = true;
    await s.send(event("cmd", START), event("img1"));
    expect(s.replies.at(-1)?.startsWith("ตอนนี้อ่านใบขาวจากรูปนี้ไม่สำเร็จครับ")).toBe(true);
    expect(s.db.turns()).toEqual([]);
  });
  it("leftover rows cannot revive an expired session or a session that never existed", async () => {
    const s = setup(); const t0 = Date.parse("2026-10-07T03:00:00Z");
    const at = (minutes: number) => { setSystemTime(new Date(t0 + minutes * 60_000)); return Date.now() - 1000; };
    await s.send(event("cmd", START, "U1", at(0)));
    await s.send(event("img1", undefined, "U1", at(1)));
    await s.send(event("fix", "fix", "U1", at(2)));
    expect(s.db.turns()).toHaveLength(2);
    await s.send(event("late", "late", "U1", at(2 + PREVIEW_TTL_MS / 60_000 + 1)));
    expect(s.applied.map((call) => call.text)).toEqual(["fix"]); // the stored rows did not make "late" a correction
    expect(s.db.turns()).toHaveLength(2);
    // A new session cannot see the previous sheet's rows.
    const later = 2 + 2 * (PREVIEW_TTL_MS / 60_000) + 2;
    await s.send(event("cmd2", START, "U1", at(later)));
    await s.send(event("img2", undefined, "U1", at(later + 1)));
    await s.send(event("fix2", "fix2", "U1", at(later + 2)));
    expect(s.applied.at(-1)!.base).toEqual(parseWhiteSheetPreview(DRIFTED)); // img2's own base, not img1's chain
  });
  it("old rows are pruned opportunistically when a new base is written, and never required for correctness", async () => {
    const s = setup();
    s.db.turns().push({ raw_message_id: "ancient", destination: "Ubot", source_id: "G1", user_id: "U1",
      sheet_image_raw_id: "ancient", kind: "base", outcome: "failed", snapshot: null, turn_seq: 0,
      created_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString() });
    await s.send(event("cmd", START), event("img1"));
    expect(s.db.turns().map((row) => row.raw_message_id)).toEqual([s.rawIdOf("img1")]);
  });
});

describe("White Sheet review: session rules are unchanged", () => {
  it("approval writes nothing official, keeps the session open and reads the next image automatically", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("fix", "fix"));
    const before = s.db.writes.length;
    await s.send(event("ok", " ผ่าน "));
    expect(s.replies.at(-1)).toBe(PREVIEW_APPROVED_REPLY);
    // Only webhook bookkeeping plus the transient accepted-approval row: nothing official.
    expect(s.db.writes.slice(before).every((table) => table === "raw_messages" || table === "white_sheet_review_turns")).toBe(true);
    expect(s.db.turns().map((row) => [row.kind, row.outcome])).toEqual([["base", "applied"], ["turn", "applied"], ["approval", "applied"]]);
    expect(s.db.turns()[2].snapshot).toEqual(s.db.turns()[1].snapshot); // the exact snapshot that was approved
    await s.send(event("img2"), event("fix2", "fix2"));
    expect(s.reads).toEqual(["img1", "img2"]);
    expect(s.applied.at(-1)!.base).toEqual(parseWhiteSheetPreview(DRIFTED)); // the second sheet starts from its own base
    expect(s.db.onlyReviewLedgerWrites()).toBe(true); expect(s.slipLookups()).toBe(0);
  });
  it("refuses a second image while a sheet is under review", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("img2"));
    expect(s.reads).toEqual(["img1"]); expect(s.replies.at(-1)).toBe(PREVIEW_PENDING_REVIEW_REPLY);
    expect(s.slipLookups()).toBe(0);
    await s.send(event("ok", "ผ่าน"), event("img3"));
    expect(s.reads).toEqual(["img1", "img3"]);
  });
  it("does not capture another user's messages in the same group", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("other-fix", "ค่าแรงจริง 300", "U2"), event("other-ok", "ผ่าน", "U2"));
    expect(s.applied).toEqual([]); expect(s.replies).not.toContain(PREVIEW_APPROVED_REPLY);
    await s.send(event("other-img", undefined, "U2"));
    expect(s.reads).toEqual(["img1"]); expect(s.slipLookups()).toBe(1);
  });
  it("does not capture the same user in another group", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"));
    await s.send(event("g2-fix", "ค่าแรงจริง 300", "U1", Date.now() - 500, "G2"), event("g2-ok", "ผ่าน", "U1", Date.now() - 400, "G2"),
      event("g2-img", undefined, "U1", Date.now() - 300, "G2"));
    expect(s.applied).toEqual([]); expect(s.replies).not.toContain(PREVIEW_APPROVED_REPLY);
    expect(s.reads).toEqual(["img1"]); expect(s.slipLookups()).toBe(1);
  });
  it("outside a review, ผ่าน and ordinary text keep their existing routes", async () => {
    const s = setup();
    await s.send(event("plain", "ผ่าน"), event("chat", "ค่าแรงจริง 300"));
    expect(s.applied).toEqual([]); expect(s.replies).not.toContain(PREVIEW_APPROVED_REPLY);
    await s.send(event("cmd", START), event("ok-too-early", "ผ่าน"));
    expect(s.replies).not.toContain(PREVIEW_APPROVED_REPLY);
  });
  it("a session slides while the user keeps acting and expires TTL after the last action", async () => {
    const s = setup(); const t0 = Date.parse("2026-10-07T03:00:00Z");
    const at = (minutes: number) => { setSystemTime(new Date(t0 + minutes * 60_000)); return Date.now() - 1000; };
    await s.send(event("cmd", START, "U1", at(0)));
    await s.send(event("img1", undefined, "U1", at(6)));
    await s.send(event("fix", "fix", "U1", at(12)));
    await s.send(event("ok", "ผ่าน", "U1", at(18)));
    await s.send(event("img2", undefined, "U1", at(24)));
    expect(s.reads).toEqual(["img1", "img2"]); expect(s.applied).toHaveLength(1);
    await s.send(event("late", "late", "U1", at(24 + PREVIEW_TTL_MS / 60_000 + 1)));
    expect(s.applied).toHaveLength(1);
    await s.send(event("late-img", undefined, "U1", at(24 + 2 * (PREVIEW_TTL_MS / 60_000) + 2)));
    expect(s.reads).toEqual(["img1", "img2"]); expect(s.slipLookups()).toBe(1);
  });
  it("จบใบขาว closes an approved session; while a sheet is under review it is refused", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("ok", "ผ่าน"), event("end", "@Botsummary จบใบขาว"), event("img2"));
    expect(s.replies).toContain(PREVIEW_END_REPLY);
    expect(s.reads).toEqual(["img1"]); expect(s.slipLookups()).toBe(1);
    const t = setup();
    await t.send(event("cmd", START), event("img1"), event("end", "@Botsummary จบใบขาว"), event("fix", "fix"));
    expect(t.replies).toContain(PREVIEW_END_REFUSED_REPLY); expect(t.applied).toHaveLength(1);
  });
  it("ยกเลิกอ่านใบขาว cancels immediately; the start command restarts a stuck review", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("cancel", "@Botsummary ยกเลิกอ่านใบขาว"), event("img2"), event("fix", "fix"));
    expect(s.reads).toEqual(["img1"]); expect(s.slipLookups()).toBe(1); expect(s.applied).toEqual([]);
    const t = setup();
    await t.send(event("cmd", START), event("img1"), event("again", START), event("img2"));
    expect(t.replies).toContain(PREVIEW_RESTART_REPLY); expect(t.reads).toEqual(["img1", "img2"]);
  });
  it("with the reader flag off nothing about the review is intercepted; analyst Q&A keeps working", async () => {
    const s = setup({ readerEnabled: false });
    await s.send(event("cmd", START), event("img1"), event("fix", "fix"), event("end", "@Botsummary จบใบขาว"));
    expect(s.reads).toEqual([]); expect(s.applied).toEqual([]); expect(s.asked).toEqual(["จบใบขาว"]);
    expect(s.db.turns()).toEqual([]);
    const t = setup();
    await t.send(event("cmd", START), event("img1"), event("qa", "@Botsummary ยอดขายวันนี้"));
    expect(t.asked).toEqual(["ยอดขายวันนี้"]); expect(t.applied).toEqual([]);
  });
  it("fails closed, never into a legacy parser, when review ownership or storage is unavailable", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"));
    const broken = new WebhookService(s.db.client(), { ...s.dependencies,
      whiteSheetSessionResolver: async () => { throw new Error("context unavailable"); } });
    await broken.processEvents([event("fix", REAL_CORRECTION)], "Ubot");
    expect(s.replies.at(-1)).toBe(CORRECTION_RETRY_REPLY); expect(s.applied).toEqual([]);
    s.db.failTurnInserts = true;
    await s.send(event("fix2", "fix2"));
    expect(s.replies.at(-1)).toBe(CORRECTION_RETRY_REPLY); // applied result could not be stored: not shown
    expect(s.slipLookups()).toBe(0); expect(s.db.onlyReviewLedgerWrites()).toBe(true);
  });
  it("a crashing correction applier replies safely and never reaches a legacy parser", async () => {
    const s = setup(); s.dependencies.whiteSheetCorrectionApplier = async () => { throw new Error("boom"); };
    await new WebhookService(s.db.client(), s.dependencies).processEvents(
      [event("cmd", START), event("img1"), event("fix", REAL_CORRECTION)], "Ubot");
    expect(s.replies.at(-1)).toBe(CORRECTION_RETRY_REPLY); expect(s.slipLookups()).toBe(0);
    expect(s.db.onlyReviewLedgerWrites()).toBe(true);
  });
});

// ── claim-order semantics ────────────────────────────────────────────────────────────────

describe("White Sheet session replay uses the claim order (LINE timestamp, then receive_order)", () => {
  const T = Date.now() - 60_000;
  /** Seed one ledger row + queue row with an explicit receive_order and LINE timestamp. */
  function seed(db: ReviewDatabase, id: string, order: number, ts: number, text?: string) {
    const payload = event(id, text, "U1", ts);
    db.rows("raw_messages").push({ id: `raw-${id}`, line_event_id: `event-${id}`, destination: "Ubot", source_type: "group",
      source_id: "G1", user_id: "U1", message_id: id, message_type: text === undefined ? "image" : "text", raw_text: text ?? null,
      payload, is_processed: true, created_at: new Date(ts + 500).toISOString() });
    db.rows("line_webhook_event_queue").push({ raw_message_id: `raw-${id}`, source_id: "G1", receive_order: order,
      received_at: new Date(ts + 500).toISOString(), status: "processed" });
  }
  const accept = (db: ReviewDatabase, id: string, sheet: string) => db.turns().push({
    raw_message_id: `raw-${id}`, destination: "Ubot", source_id: "G1", user_id: "U1", sheet_image_raw_id: `raw-${sheet}`,
    parent_raw_message_id: `raw-${sheet}`, kind: "approval", outcome: "applied", snapshot: parseWhiteSheetPreview(VISION), turn_seq: 9 });
  const resolve = (db: ReviewDatabase, id: string) => {
    const row = db.rows("raw_messages").find((r) => r.id === `raw-${id}`)!;
    return resolveWhiteSheetSession(db.client(), row.payload as LineMessageEvent, `raw-${id}`, "Ubot");
  };

  it("correction receive_order 10 / later LINE time vs approval receive_order 11 / earlier LINE time", async () => {
    const db = new ReviewDatabase();
    seed(db, "cmd", 1, T, START); seed(db, "img", 2, T + 1000, undefined);
    seed(db, "fix", 10, T + 5000, "fix");           // received first, stamped later
    seed(db, "ok", 11, T + 3000, "ผ่าน");            // received second, stamped earlier
    accept(db, "ok", "img");
    // The approval is claimed first (earlier LINE time) and sees a sheet under review...
    expect(await resolve(db, "ok")).toEqual({ state: "reviewing", sheet: { imageRawId: "raw-img" } });
    // ...so the correction, processed after it, sees an already-approved sheet and is NOT a correction.
    expect(await resolve(db, "fix")).toEqual({ state: "approved_waiting_next_image", sheet: null });
  });
  it("the mirror case: an earlier-stamped correction received after the approval is applied before it", async () => {
    const db = new ReviewDatabase();
    seed(db, "cmd", 1, T, START); seed(db, "img", 2, T + 1000, undefined);
    seed(db, "ok", 10, T + 5000, "ผ่าน");            // received first, stamped later
    seed(db, "fix", 11, T + 3000, "fix");           // received second, stamped earlier
    accept(db, "ok", "img");
    expect((await resolve(db, "fix")).state).toBe("reviewing");
    expect((await resolve(db, "ok")).state).toBe("reviewing");
  });
  it("finds a start command that was received later but stamped earlier than the current event", async () => {
    const db = new ReviewDatabase();
    seed(db, "img", 5, T + 2000, undefined);        // received first
    seed(db, "cmd", 6, T + 1000, START);            // received later, but LINE says it came first
    expect((await resolve(db, "img")).state).toBe("awaiting_image");
    const none = new ReviewDatabase();
    seed(none, "cmd", 6, T + 3000, START); seed(none, "img", 5, T + 2000, undefined);
    expect((await resolve(none, "img")).state).toBe("none"); // a start stamped AFTER the image does not precede it
  });
  it("equal LINE timestamps fall back to receive_order", async () => {
    const db = new ReviewDatabase();
    seed(db, "cmd", 1, T, START); seed(db, "img", 3, T + 1000, undefined); seed(db, "fix", 2, T + 1000, "fix");
    expect((await resolve(db, "fix")).state).toBe("awaiting_image"); // fix (order 2) precedes img (order 3)
    expect((await resolve(db, "img")).state).toBe("awaiting_image");
  });
  it("the service processes a payload in claim order: the earlier-stamped approval wins, the later correction is not applied after it", async () => {
    const s = setup(); const t0 = Date.now() - 30_000;
    await s.send(event("cmd", START, "U1", t0), event("img1", undefined, "U1", t0 + 1000),
      event("fix", "fix", "U1", t0 + 5000), event("ok", "ผ่าน", "U1", t0 + 3000));
    expect(s.applied).toEqual([]); // the correction came after the accepted approval in queue processing order
    expect(s.db.turns().map((row) => [row.kind, row.outcome])).toEqual([["base", "applied"], ["approval", "applied"]]);
    expect(s.replies).toContain(PREVIEW_APPROVED_REPLY);
    expect(s.db.turns().some((row) => row.raw_message_id === s.rawIdOf("fix"))).toBe(false);
  });
  it("the service applies an earlier-stamped correction before a later-stamped approval, even if received after it", async () => {
    const s = setup(); const t0 = Date.now() - 30_000;
    await s.send(event("cmd", START, "U1", t0), event("img1", undefined, "U1", t0 + 1000),
      event("ok", "ผ่าน", "U1", t0 + 5000), event("fix", "fix", "U1", t0 + 3000));
    expect(s.applied.map((call) => call.text)).toEqual(["fix"]);
    const [base, first, approval] = s.db.turns();
    expect([base.kind, first.kind, approval.kind]).toEqual(["base", "turn", "approval"]);
    expect(approval.snapshot).toEqual(first.snapshot); // approved the corrected snapshot, built from base -> fix
    expect(approval.parent_raw_message_id).toBe(first.raw_message_id);
  });
});

// ── approval needs a valid applied snapshot ─────────────────────────────────────────────
describe("ผ่าน is accepted only for a sheet with a valid persisted applied snapshot", () => {
  const withBase = (outcome: "failed" | "unavailable") => {
    const s = setup();
    s.dependencies.whiteSheetBaseReader = async (): Promise<WhiteSheetBaseRead> => ({ outcome, replies: [`base ${outcome}`] });
    return { ...s, service: new WebhookService(s.db.client(), s.dependencies) };
  };
  it.each(["failed", "unavailable"] as const)("a Vision-%s sheet cannot be approved and the next image does not advance", async (outcome) => {
    const s = withBase(outcome);
    await s.service.processEvents([event("cmd", START), event("img1"), event("ok", "ผ่าน")], "Ubot");
    expect(s.replies.at(-1)).toBe(MISSING_REVIEW_BASE_REPLY); expect(s.replies).not.toContain(PREVIEW_APPROVED_REPLY);
    expect(s.db.turns().find((row) => row.kind === "approval")).toMatchObject({ outcome: "failed", snapshot: null });
    await s.service.processEvents([event("img2")], "Ubot");
    expect(s.replies.at(-1)).toBe(PREVIEW_PENDING_REVIEW_REPLY); // still the stuck sheet: image refused
    expect(s.slipLookups()).toBe(0);
    await new WebhookService(s.db.client(), s.dependencies).processEvents([event("ok2", "ผ่าน")], "Ubot"); // another instance
    expect(s.replies.at(-1)).toBe(MISSING_REVIEW_BASE_REPLY);
    expect(s.db.turns().filter((row) => row.kind === "approval" && row.outcome === "applied")).toEqual([]);
    expect(s.db.onlyReviewLedgerWrites()).toBe(true);
  });
  it("a corrupt stored base refuses the approval and leaves the session reviewing", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"));
    s.db.turns()[0].snapshot = { documentType: "white_sheet", salesAmountBaht: "lots" };
    await s.send(event("ok", "ผ่าน"));
    expect(s.replies.at(-1)).toBe(MISSING_REVIEW_BASE_REPLY);
    await s.send(event("img2"));
    expect(s.replies.at(-1)).toBe(PREVIEW_PENDING_REVIEW_REPLY); expect(s.reads).toEqual(["img1"]);
  });
  it("a sheet whose base was never stored cannot be approved", async () => {
    const s = setup(); s.db.failTurnInserts = true;
    await s.send(event("cmd", START), event("img1"));
    s.db.failTurnInserts = false;
    await s.send(event("ok", "ผ่าน"));
    expect(s.replies.at(-1)).toBe(MISSING_REVIEW_BASE_REPLY);
    expect(s.db.turns().find((row) => row.kind === "approval")?.outcome).toBe("failed");
  });
  it("a valid applied base is accepted exactly once and then the next image is read", async () => {
    const s = setup();
    await s.send(event("cmd", START), event("img1"), event("ok", "ผ่าน"));
    expect(s.replies.at(-1)).toBe(PREVIEW_APPROVED_REPLY);
    expect(s.db.turns().filter((row) => row.kind === "approval")).toHaveLength(1);
    await s.send(event("ok-again", "ผ่าน")); // the session is awaiting the next image: not a review, not claimed
    expect(s.db.turns().filter((row) => row.kind === "approval")).toHaveLength(1);
    await s.send(event("img2"));
    expect(s.reads).toEqual(["img1", "img2"]);
  });
  it("redelivery of an accepted or a refused approval is deterministic and calls no model", async () => {
    const accepted = setup();
    await accepted.send(event("cmd", START), event("img1"), event("ok", "ผ่าน"));
    const rows = accepted.db.turns().length, reads = accepted.reads.length;
    await accepted.reprocess(accepted.rawIdOf("ok"));
    expect(accepted.replies.slice(-2)).toEqual([PREVIEW_APPROVED_REPLY, PREVIEW_APPROVED_REPLY]);
    expect(accepted.db.turns()).toHaveLength(rows); expect(accepted.reads.length).toBe(reads); expect(accepted.applied).toEqual([]);

    const refused = withBase("failed");
    await refused.service.processEvents([event("cmd", START), event("img1"), event("ok", "ผ่าน")], "Ubot");
    const refusedRows = refused.db.turns().length;
    await refused.reprocess(refused.rawIdOf("ok"));
    expect(refused.replies.slice(-2)).toEqual([MISSING_REVIEW_BASE_REPLY, MISSING_REVIEW_BASE_REPLY]);
    expect(refused.db.turns()).toHaveLength(refusedRows); expect(refused.applied).toEqual([]);
  });
  it("two accepted approvals can never exist for one sheet", async () => {
    const db = new ReviewDatabase(); const client = db.client();
    const scope = { destination: "Ubot", sourceId: "G1", userId: "U1" };
    const snapshot = parseWhiteSheetPreview(VISION);
    await readAndRecordSheet(client, scope, "raw-img", "img", { readBase: async () => ({ outcome: "applied", snapshot, replies: ["base"] }) });
    expect(await reviewApproval(client, scope, "raw-img", "raw-ok1")).toEqual([PREVIEW_APPROVED_REPLY]);
    expect(await reviewApproval(client, scope, "raw-img", "raw-ok2")).toEqual([APPROVAL_RETRY_REPLY]);
    expect(db.turns().filter((row) => row.kind === "approval").map((row) => [row.raw_message_id, row.outcome]))
      .toEqual([["raw-ok1", "applied"], ["raw-ok2", "unavailable"]]);
  });
});

// ── a base is shown only if exactly that base is stored ─────────────────────────────────
describe("a fresh base preview is shown only if its exact base is persisted", () => {
  const scope = { destination: "Ubot", sourceId: "G1", userId: "U1" };
  const fresh = parseWhiteSheetPreview(VISION);
  const readBase = async (): Promise<WhiteSheetBaseRead> => ({ outcome: "applied", snapshot: fresh, replies: ["FRESH PREVIEW"] });
  it("an unexplained unique conflict is not displayed and returns the restart reply", async () => {
    const db = new ReviewDatabase(); db.conflictOnBase = true;
    expect(await readAndRecordSheet(db.client(), scope, "raw-img", "img", { readBase })).toEqual([MISSING_REVIEW_BASE_REPLY]);
    expect(db.turns()).toEqual([]);
  });
  it("a write failure is not displayed either", async () => {
    const db = new ReviewDatabase(); db.failTurnInserts = true;
    await expect(readAndRecordSheet(db.client(), scope, "raw-img", "img", { readBase })).rejects.toThrow();
  });
  it("a racing writer wins: the stored base is rendered, not the fresh read", async () => {
    const db = new ReviewDatabase(); const client = db.client();
    const stored = parseWhiteSheetPreview({ ...VISION, salesAmountBaht: 1234 });
    const replies = await readAndRecordSheet(client, scope, "raw-img", "img", { readBase: async () => {
      await recordTurn(client, { ...scope, sheetImageRawId: "raw-img" }, { rawMessageId: "raw-img", kind: "base", outcome: "applied", snapshot: stored });
      return readBase();
    } });
    expect(replies).toEqual(renderWhiteSheetPreview(stored, "review"));
    expect(replies.join("\n")).toContain("1,234");
    expect(replies).not.toContain("FRESH PREVIEW");
    expect(db.turns()).toHaveLength(1);
  });
  it("a racing writer whose row is unreadable fails closed", async () => {
    const db = new ReviewDatabase(); const client = db.client();
    const replies = await readAndRecordSheet(client, scope, "raw-img", "img", { readBase: async () => {
      await recordTurn(client, { ...scope, sheetImageRawId: "raw-img" }, { rawMessageId: "raw-img", kind: "base", outcome: "applied", snapshot: fresh });
      db.turns()[0].snapshot = { broken: true };
      return readBase();
    } });
    expect(replies).toEqual([MISSING_REVIEW_BASE_REPLY]);
  });
});

// ── one branch guard for corrections AND approvals ──────────────────────────────────────
describe("an applied correction and an accepted approval share one branch guard", () => {
  const scope = { destination: "Ubot", sourceId: "G1", userId: "U1" };
  const snapshot = parseWhiteSheetPreview(VISION);
  async function withBase() {
    const db = new ReviewDatabase(); const client = db.client();
    await readAndRecordSheet(client, scope, "raw-img", "img", { readBase: async () => ({ outcome: "applied", snapshot, replies: ["base"] }) });
    let modelCalls = 0;
    const applyCorrection: typeof applyWhiteSheetCorrection = (base, text) => {
      modelCalls++; return applyWhiteSheetCorrection(base, text, async () => labor(300));
    };
    return { db, client, applyCorrection, modelCalls: () => modelCalls };
  }
  const appliedTransitions = (db: ReviewDatabase) => db.turns()
    .filter((row) => row.outcome === "applied" && (row.kind === "turn" || row.kind === "approval"));
  const isLinear = (db: ReviewDatabase) => {
    const parents = appliedTransitions(db).map((row) => row.parent_raw_message_id);
    return new Set(parents).size === parents.length;
  };

  it("A. the correction wins the parent: the stale approval is not accepted and never says ผ่านแล้ว", async () => {
    const t = await withBase();
    // The approval read the base as latest; a concurrent worker applies a correction before it writes.
    t.db.beforeTurnInsert = async (payload) => {
      if (payload.raw_message_id !== "raw-ok") return;
      t.db.beforeTurnInsert = null;
      await reviewCorrectionTurn(t.client, scope, "raw-img", "raw-fix", "ค่าแรงจริง 300", { applyCorrection: t.applyCorrection });
    };
    const reply = await reviewApproval(t.client, scope, "raw-img", "raw-ok");
    expect(reply).toEqual([APPROVAL_RETRY_REPLY]);
    expect(reply).not.toContain(PREVIEW_APPROVED_REPLY);
    expect(t.db.turns().find((row) => row.raw_message_id === "raw-ok")).toMatchObject({ kind: "approval", outcome: "unavailable", snapshot: null });
    expect(t.db.turns().find((row) => row.raw_message_id === "raw-fix")).toMatchObject({ kind: "turn", outcome: "applied", parent_raw_message_id: "raw-img" });
    expect(isLinear(t.db)).toBe(true);
    // Replay never treats it as accepted, and a redelivery replies the same way.
    expect((await loadAcceptedApprovals(t.client, scope, ["raw-ok"])).size).toBe(0);
    expect(await reviewApproval(t.client, scope, "raw-img", "raw-ok")).toEqual([APPROVAL_RETRY_REPLY]);
    // A fresh approval accepts the corrected snapshot, continuing the single chain.
    expect(await reviewApproval(t.client, scope, "raw-img", "raw-ok2")).toEqual([PREVIEW_APPROVED_REPLY]);
    const accepted = t.db.turns().find((row) => row.raw_message_id === "raw-ok2")!;
    expect(accepted.parent_raw_message_id).toBe("raw-fix");
    expect((accepted.snapshot as WhiteSheetPreview).laborAmountBaht).toBe(300);
    expect(isLinear(t.db)).toBe(true);
  });

  it("B. the approval wins the parent: the stale correction is recorded as not applied", async () => {
    const t = await withBase();
    t.db.beforeTurnInsert = async (payload) => {
      if (payload.raw_message_id !== "raw-fix") return;
      t.db.beforeTurnInsert = null;
      expect(await reviewApproval(t.client, scope, "raw-img", "raw-ok")).toEqual([PREVIEW_APPROVED_REPLY]);
    };
    const reply = await reviewCorrectionTurn(t.client, scope, "raw-img", "raw-fix", "ค่าแรงจริง 300", { applyCorrection: t.applyCorrection });
    expect(reply).toEqual([CORRECTION_RETRY_REPLY]);
    expect(t.db.turns().find((row) => row.raw_message_id === "raw-fix")).toMatchObject({ kind: "turn", outcome: "unavailable", snapshot: null });
    const approval = t.db.turns().find((row) => row.raw_message_id === "raw-ok")!;
    expect(approval).toMatchObject({ kind: "approval", outcome: "applied", parent_raw_message_id: "raw-img" });
    expect((approval.snapshot as WhiteSheetPreview).laborAmountBaht).toBeNull(); // the approved snapshot is the base
    expect(appliedTransitions(t.db).map((row) => row.raw_message_id)).toEqual(["raw-ok"]);
    expect(isLinear(t.db)).toBe(true);
    // The correction stays not applied forever and is never re-sent to the model.
    const calls = t.modelCalls();
    expect(await reviewCorrectionTurn(t.client, scope, "raw-img", "raw-fix", "ค่าแรงจริง 300", { applyCorrection: t.applyCorrection }))
      .toEqual([CORRECTION_RETRY_REPLY]);
    expect(t.modelCalls()).toBe(calls);
  });

  it("an approval can never be accepted from a parent another approval already consumed", async () => {
    const t = await withBase();
    t.db.beforeTurnInsert = async (payload) => {
      if (payload.raw_message_id !== "raw-ok1") return;
      t.db.beforeTurnInsert = null;
      expect(await reviewApproval(t.client, scope, "raw-img", "raw-ok2")).toEqual([PREVIEW_APPROVED_REPLY]);
    };
    expect(await reviewApproval(t.client, scope, "raw-img", "raw-ok1")).toEqual([APPROVAL_RETRY_REPLY]);
    expect(appliedTransitions(t.db).map((row) => row.raw_message_id)).toEqual(["raw-ok2"]);
  });
});

// ── no clock-skew assumption; the 3-hour cap is semantic ────────────────────────────────
describe("session replay has no clock-skew assumption and keeps the 3-hour hard cap", () => {
  const MIN = 60_000;
  /** One ledger row + queue row with explicit LINE time, ledger time and receive order. */
  function seed(db: ReviewDatabase, id: string, order: number, lineTs: number, deliveredAt: number, text?: string) {
    db.rows("raw_messages").push({ id: `raw-${id}`, line_event_id: `event-${id}`, destination: "Ubot", source_type: "group",
      source_id: "G1", user_id: "U1", message_id: id, message_type: text === undefined ? "image" : "text", raw_text: text ?? null,
      payload: event(id, text, "U1", lineTs), is_processed: true, created_at: new Date(deliveredAt).toISOString() });
    db.rows("line_webhook_event_queue").push({ raw_message_id: `raw-${id}`, source_id: "G1", receive_order: order,
      received_at: new Date(deliveredAt).toISOString(), status: "processed" });
  }
  const resolve = (db: ReviewDatabase, id: string) => {
    const row = db.rows("raw_messages").find((r) => r.id === `raw-${id}`)!;
    return resolveWhiteSheetSession(db.client(), row.payload as LineMessageEvent, `raw-${id}`, "Ubot");
  };

  it("a row stored minutes BEFORE its LINE time (skewed clock) is still placed by its LINE time", async () => {
    const db = new ReviewDatabase(); const now = Date.now();
    seed(db, "cmd", 1, now - 8 * MIN, now - 8 * MIN, START);
    seed(db, "img", 2, now - 4 * MIN, now - 12 * MIN);         // ledger says 8 minutes earlier than LINE
    seed(db, "fix", 3, now - 3 * MIN, now - 3 * MIN, "fix");
    // A start-relative "- 60 s" retrieval bound would have dropped the image and left the session awaiting an image.
    expect(await resolve(db, "fix")).toEqual({ state: "reviewing", sheet: { imageRawId: "raw-img" } });
  });
  it("a start delivered many minutes late still precedes the events LINE stamped after it", async () => {
    const db = new ReviewDatabase(); const now = Date.now();
    seed(db, "img", 3, now - 7 * MIN, now - 7 * MIN);          // arrives first
    seed(db, "cmd", 5, now - 8 * MIN, now - MIN, START);       // stamped earlier, delivered 7 minutes late
    seed(db, "fix", 6, now - 30_000, now - 30_000, "fix");
    expect(await resolve(db, "img")).toEqual({ state: "awaiting_image", sheet: null });
    expect(await resolve(db, "fix")).toEqual({ state: "reviewing", sheet: { imageRawId: "raw-img" } });
  });
  it("an image delivered many minutes late after an accepted approval is ordered by its LINE time", async () => {
    const db = new ReviewDatabase(); const now = Date.now();
    seed(db, "cmd", 1, now - 9 * MIN, now - 9 * MIN, START);
    seed(db, "img1", 2, now - 8 * MIN, now - 8 * MIN);
    seed(db, "ok", 3, now - 6 * MIN, now - 6 * MIN, "ผ่าน");
    seed(db, "img2", 9, now - 5 * MIN, now - 10_000);            // stamped before fix, delivered last
    seed(db, "fix", 4, now - 2 * MIN, now - 2 * MIN, "fix");
    db.turns().push({ raw_message_id: "raw-ok", destination: "Ubot", source_id: "G1", user_id: "U1", sheet_image_raw_id: "raw-img1",
      parent_raw_message_id: "raw-img1", kind: "approval", outcome: "applied", snapshot: parseWhiteSheetPreview(VISION), turn_seq: 1 });
    expect(await resolve(db, "fix")).toEqual({ state: "reviewing", sheet: { imageRawId: "raw-img2" } });
  });
  it("the 3-hour cap ends a session even while the user never stops acting", async () => {
    const db = new ReviewDatabase(); const now = Date.now();
    // Start stamped 3 h 1 min ago, everything delivered late but inside the retrieval window, activity every 5 minutes:
    // the sliding TTL never lapses, only the hard cap can end it.
    const start = now - SESSION_MAX_AGE_MS - MIN;
    seed(db, "cmd", 1, start, now - 60 * MIN, START);
    seed(db, "img", 2, start + 9 * MIN, now - 60 * MIN);
    let order = 3;
    for (let at = start + 14 * MIN; at < now - 2 * MIN; at += 5 * MIN) seed(db, `t${order}`, order++, at, Math.max(at, now - 59 * MIN), "fix");
    seed(db, "late", order, now - 10_000, now - 10_000, "fix");
    expect(await resolve(db, "late")).toEqual({ state: "none", sheet: null });
  });
  it("just under the 3-hour cap a continuously active session is still reviewing", async () => {
    const db = new ReviewDatabase(); const now = Date.now();
    const start = now - SESSION_MAX_AGE_MS + 10 * MIN;
    seed(db, "cmd", 1, start, start, START);
    seed(db, "img", 2, start + 9 * MIN, start + 9 * MIN);
    let order = 3;
    for (let at = start + 14 * MIN; at < now - 2 * MIN; at += 5 * MIN) seed(db, `t${order}`, order++, at, at, "fix");
    seed(db, "late", order, now - 10_000, now - 10_000, "fix");
    expect(await resolve(db, "late")).toEqual({ state: "reviewing", sheet: { imageRawId: "raw-img" } });
  });
  it("a start stored before the 3-hour window is never retrieved", async () => {
    const db = new ReviewDatabase(); const now = Date.now();
    seed(db, "cmd", 1, now - SESSION_MAX_AGE_MS - 5 * MIN, now - SESSION_MAX_AGE_MS - 5 * MIN, START);
    seed(db, "img", 2, now - 10_000, now - 10_000);
    expect(await resolve(db, "img")).toEqual({ state: "none", sheet: null });
  });
  it("more than the row cap in the window fails closed instead of guessing", async () => {
    const db = new ReviewDatabase(); const now = Date.now();
    seed(db, "cmd", 1, now - 50 * MIN, now - 50 * MIN, START);
    for (let i = 0; i < 300; i++) seed(db, `chat${i}`, 2 + i, now - 40 * MIN + i * 1000, now - 40 * MIN + i * 1000, `chat ${i}`);
    seed(db, "img", 400, now - 10_000, now - 10_000);
    await expect(resolve(db, "img")).rejects.toThrow();
  });
});
