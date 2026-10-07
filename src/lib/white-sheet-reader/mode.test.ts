import { describe, expect, it } from "bun:test";
import {
  compareSemantic, isWhiteSheetApproval, PREVIEW_TTL_MS, replayWhiteSheetSession, semanticKey, whiteSheetReadCommand,
  type ReplayEvent,
} from "./mode";
import { renderWhiteSheetPreview, PREVIEW_REVIEW_PROMPT, PREVIEW_CORRECTED_PROMPT, PREVIEW_DISCLAIMER } from "./reader";
import type { LineTextMessage } from "@/lib/line/types";

const MIN = 60_000;
const NOW = Date.parse("2026-10-07T03:00:00Z");
const ev = (id: string, kind: ReplayEvent["kind"], minutes: number): ReplayEvent => ({
  rawId: id, kind, timestamp: NOW + minutes * MIN,
});
/** An approval that was ACCEPTED for the given sheet. */
const ok = (minutes: number, sheet: string): ReplayEvent => ({ rawId: "ok", kind: "approval", timestamp: NOW + minutes * MIN, acceptedSheet: sheet });
const replay = (events: ReplayEvent[], atMinutes: number) =>
  replayWhiteSheetSession(events, NOW + atMinutes * MIN, NOW + atMinutes * MIN + 1000);

describe("white-sheet session state machine", () => {
  it("walks idle -> awaiting -> reviewing -> approved -> reviewing", () => {
    expect(replay([], 0).state).toBe("none");
    expect(replay([ev("s", "start", 0)], 1).state).toBe("awaiting_image");
    const reviewing = replay([ev("s", "start", 0), ev("i1", "image", 1)], 2);
    expect(reviewing.state).toBe("reviewing");
    expect(reviewing.sheet).toEqual({ imageRawId: "i1" });
    expect(replay([ev("s", "start", 0), ev("i1", "image", 1), ok(2, "i1")], 3))
      .toEqual({ state: "approved_waiting_next_image", sheet: null });
    const second = replay([ev("s", "start", 0), ev("i1", "image", 1), ok(2, "i1"), ev("i2", "image", 3)], 4);
    expect(second.state).toBe("reviewing"); expect(second.sheet?.imageRawId).toBe("i2");
  });
  it("a sheet is identified by its image event; corrections and approvals of an earlier sheet never carry over", () => {
    const session = replay([ev("s", "start", 0), ev("i1", "image", 1), ev("c1", "text", 2), ok(3, "i1"),
      ev("i2", "image", 4), ev("c2", "text", 5)], 6);
    expect(session).toEqual({ state: "reviewing", sheet: { imageRawId: "i2" } });
  });
  it("ignores text while awaiting an image and approvals outside a review", () => {
    expect(replay([ev("s", "start", 0), ev("t", "text", 1), ev("ok", "approval", 2)], 3).state).toBe("awaiting_image");
    expect(replay([ev("t", "text", 0), ev("i", "image", 1)], 2).state).toBe("none");
  });
  it("a second image does not replace the sheet under review", () => {
    const session = replay([ev("s", "start", 0), ev("i1", "image", 1), ev("i2", "image", 2)], 3);
    expect(session.sheet?.imageRawId).toBe("i1");
  });
  it("end closes only when nothing is under review; cancel always closes; start restarts", () => {
    expect(replay([ev("s", "start", 0), ev("end", "end", 1)], 2).state).toBe("none");
    expect(replay([ev("s", "start", 0), ev("i", "image", 1), ev("end", "end", 2)], 3).state).toBe("reviewing");
    expect(replay([ev("s", "start", 0), ev("i", "image", 1), ev("x", "cancel", 2)], 3).state).toBe("none");
    expect(replay([ev("s", "start", 0), ev("i", "image", 1), ev("c", "text", 2), ev("s2", "start", 3)], 4))
      .toEqual({ state: "awaiting_image", sheet: null });
    expect(replay([ev("s", "start", 0), ev("i", "image", 1), ok(2, "i"), ev("end", "end", 3)], 4).state).toBe("none");
  });
  it("expires TTL after the last action, but every action slides the window", () => {
    const slide = [ev("s", "start", 0), ev("i1", "image", 6), ev("c", "text", 12), ok(18, "i1"), ev("i2", "image", 24)];
    expect(replay(slide, 30).state).toBe("reviewing"); // 30 minutes in, never idle for 10
    expect(replay(slide, 24 + PREVIEW_TTL_MS / MIN).state).toBe("none");
    expect(replay([ev("s", "start", 0), ev("i", "image", 11)], 12).state).toBe("none"); // gap before the image
    expect(replay([ev("s", "start", 0), ev("i", "image", 5), ev("c", "text", 16)], 17).sheet).toBeNull();
  });
  it("an approval advances the session only when it was accepted for THIS sheet", () => {
    const base = [ev("s", "start", 0), ev("i1", "image", 1)];
    const refused: ReplayEvent = { rawId: "no", kind: "approval", timestamp: NOW + 2 * MIN, acceptedSheet: null };
    expect(replay([...base, refused], 3)).toEqual({ state: "reviewing", sheet: { imageRawId: "i1" } });
    expect(replay([...base, { ...refused, acceptedSheet: "another-sheet" }], 3).state).toBe("reviewing");
    expect(replay([...base, { ...refused }, ev("i2", "image", 3)], 4).sheet?.imageRawId).toBe("i1"); // next image is not read
    expect(replay([...base, ok(2, "i1")], 3).state).toBe("approved_waiting_next_image");
    expect(replay([...base, { ...refused, acceptedSheet: undefined }], 3).state).toBe("reviewing"); // never recorded
  });
  it("the 3-hour hard cap ends a session the sliding TTL would keep alive, measured on claim-order time", () => {
    const active = (until: number) => [ev("s", "start", 0), ev("i", "image", 5),
      ...Array.from({ length: Math.floor((until - 10) / 5) }, (_, k) => ev(`t${k}`, "text", 10 + 5 * k))];
    expect(replay(active(170), 172).state).toBe("reviewing");
    expect(replay(active(185), 186).state).toBe("none"); // TTL never lapsed; the cap did
    expect(replay(active(178), 179).state).toBe("reviewing");
    // A new start command opens a fresh 3 hours.
    expect(replay([...active(185), ev("s2", "start", 185), ev("i2", "image", 186)], 187).state).toBe("reviewing");
  });
  it("a refused approval still counts as activity, so it keeps a review alive", () => {
    const base = [ev("s", "start", 0), ev("i1", "image", 1), { rawId: "no", kind: "approval" as const, timestamp: NOW + 9 * MIN, acceptedSheet: null }];
    expect(replay(base, 15).state).toBe("reviewing");
  });
  it("fails closed on an event without a usable time", () => {
    expect(() => replayWhiteSheetSession([{ ...ev("s", "start", 0), timestamp: NaN }], NOW, NOW)).toThrow();
  });
});

describe("white-sheet commands and rendering modes", () => {
  const message = (text: string): LineTextMessage => ({ id: "m", type: "text", quoteToken: "q", text });
  it("recognises start, cancel and end, and exact approval only", () => {
    expect(whiteSheetReadCommand(message("@Botsummary อ่านใบขาว"), "Ubot")).toBe("start");
    expect(whiteSheetReadCommand(message("@Botsummary ยกเลิกอ่านใบขาว"), "Ubot")).toBe("cancel");
    expect(whiteSheetReadCommand(message("@Botsummary จบใบขาว"), "Ubot")).toBe("end");
    expect(whiteSheetReadCommand(message("จบใบขาว"), "Ubot")).toBeNull(); // needs the mention
    expect(whiteSheetReadCommand(message("@Botsummary ยอดขายใบขาว"), "Ubot")).toBeNull();
    expect(isWhiteSheetApproval("ผ่าน")).toBe(true); expect(isWhiteSheetApproval("  ผ่าน \n")).toBe(true);
    expect(isWhiteSheetApproval("ผ่านแล้ว")).toBe(false); expect(isWhiteSheetApproval("ไม่ผ่าน")).toBe(false);
  });
  it("adds the approval prompt before the disclaimer in review modes only", () => {
    const sheet = { documentType: "white_sheet", market: "พาซิโอ้ผัก", dateRaw: null, dateIso: null, sellerNames: [],
      salesAmountBaht: 1, transferAmountBaht: null, cashSentAmountBaht: null, laborAmountBaht: null,
      remainingCashAmountBaht: null, expenses: [], lowConfidenceFields: [], overallConfidence: 0.9, notes: [] };
    expect(renderWhiteSheetPreview(sheet).join("\n")).not.toContain("ผ่าน");
    expect(renderWhiteSheetPreview(sheet, "review").join("\n").endsWith(`${PREVIEW_REVIEW_PROMPT}\n\n${PREVIEW_DISCLAIMER}`)).toBe(true);
    const corrected = renderWhiteSheetPreview(sheet, "corrected").join("\n");
    expect(corrected.startsWith("แก้ผลอ่านใบขาวแล้ว (รอตรวจ)")).toBe(true);
    expect(corrected.endsWith(`${PREVIEW_CORRECTED_PROMPT}\n\n${PREVIEW_DISCLAIMER}`)).toBe(true);
  });
});

describe("claim-order semantics (claim_line_webhook_event)", () => {
  const key = (ts: unknown, receivedAt: string | null, order: number) => semanticKey(ts, receivedAt, order);
  it("orders by numeric LINE payload timestamp first, receive_order only as the tie-breaker", () => {
    expect(compareSemantic(key(2000, null, 1), key(1000, null, 99))).toBeGreaterThan(0); // later LINE time wins over earlier receipt
    expect(compareSemantic(key(1000, null, 11), key(1000, null, 10))).toBeGreaterThan(0);
    expect(compareSemantic(key(1000, null, 10), key(1000, null, 10))).toBe(0);
  });
  it("accepts digit strings, and falls back to received_at exactly like the SQL when the timestamp is not digits", () => {
    expect(key("1700000000000", null, 1).ms).toBe(1700000000000);
    const received = "2026-10-07T03:00:00.123456+00:00";
    const expected = Math.floor(Date.parse("2026-10-07T03:00:00.123Z"));
    for (const bad of [undefined, null, "", "abc", "1.5", -5, 1.5, NaN, {}]) expect(key(bad, received, 4).ms).toBe(expected);
    expect(() => key(undefined, null, 1)).toThrow();
    expect(() => key(1000, null, NaN)).toThrow();
  });
  it("the critical case: correction received first but stamped later, approval received after but stamped earlier", () => {
    // receive_order: correction = 10, approval = 11.  LINE time: approval T+3, correction T+5.
    const correction = { ms: NOW + 5 * MIN, order: 10 }, approval = { ms: NOW + 3 * MIN, order: 11 };
    expect(compareSemantic(approval, correction)).toBeLessThan(0); // the worker claims the approval FIRST
    // So when the correction is processed, the approval is already part of its history: not reviewing.
    const history: ReplayEvent[] = [ev("s", "start", 0), ev("i1", "image", 1), ok(3, "i1")];
    expect(replayWhiteSheetSession(history, correction.ms, correction.ms + 1000).state).toBe("approved_waiting_next_image");
    // And the approval, processed first, sees only the image: still reviewing.
    expect(replayWhiteSheetSession(history.slice(0, 2), approval.ms, approval.ms + 1000).state).toBe("reviewing");
  });
});
