import { describe, expect, test } from "bun:test";
import { sequenceBatchImages, type LedgerImage } from "@/lib/slips/image-sequence";
import {
  buildBatchSummaryMessage,
  orderByLineSequence,
  type EvidenceWithCheck,
} from "@/lib/slips/batch-finalizer";

const T0 = 1_760_000_000_000;
const img = (n: number, state = "attached", extra: Partial<LedgerImage> = {}): LedgerImage => ({
  lineMessageId: `5900000000000${String(n).padStart(5, "0")}`,
  eventTsMs: T0 + n * 1000,
  state,
  lineTimestamp: true,
  ...extra,
});

/** Evidence for LINE image n whose attach finished at position `attachedAs`. */
const ev = (n: number, attachedAs: number, check: Partial<EvidenceWithCheck> = {}): EvidenceWithCheck => ({
  id: `ev-${n}`,
  lineMessageId: img(n).lineMessageId,
  batchIndex: attachedAs,
  checkStatus: "EXTRACTED",
  slipType: "BANK_SLIP_QR",
  transferAmount: 100 + n,
  paidAmount: null,
  transactionTime: "2026-10-16T12:00:00+07:00",
  failureReason: null,
  ...check,
});

const shuffle = <T>(items: T[], seed: number): T[] => {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

describe("sequenceBatchImages: #N is the LINE send position", () => {
  test("30 images attached in a scrambled order are numbered by LINE time", () => {
    const images = Array.from({ length: 30 }, (_, i) => img(i + 1));
    const seq = sequenceBatchImages(shuffle(images, 7), new Set(images.map((i) => i.lineMessageId)));
    expect(seq.uncertain).toBe(false);
    expect(seq.missing).toEqual([]);
    for (let n = 1; n <= 30; n++) expect(seq.positions.get(img(n).lineMessageId)).toBe(n);
  });

  test("a failed image between successes keeps its number; later ones do not shift", () => {
    const images = [img(1), img(2), img(3, "failed_permanent"), img(4), img(5, "retry_pending")];
    const attached = new Set([1, 2, 4].map((n) => img(n).lineMessageId));
    const seq = sequenceBatchImages(images, attached);
    expect(seq.positions.get(img(4).lineMessageId)).toBe(4);
    expect(seq.missing).toEqual([
      { sequence: 3, state: "failed_permanent" },
      { sequence: 5, state: "retry_pending" },
    ]);
  });

  test("images after the close command or consumed by another flow take no number", () => {
    const images = [img(1), img(2, "excluded_not_slip"), img(3), img(4, "excluded_after_close")];
    const seq = sequenceBatchImages(images, new Set([img(1).lineMessageId, img(3).lineMessageId]));
    expect(seq.positions.get(img(3).lineMessageId)).toBe(2);
    expect(seq.positions.has(img(4).lineMessageId)).toBe(false);
    expect(seq.missing).toEqual([]);
  });

  test("message ids compare numerically, never as text", () => {
    const a = img(1, "attached", { lineMessageId: "999", eventTsMs: T0, imageSet: { id: "S", index: 1 } });
    const b = img(2, "attached", { lineMessageId: "1000", eventTsMs: T0, imageSet: { id: "S", index: 2 } });
    const seq = sequenceBatchImages([b, a], new Set(["999", "1000"]));
    expect(seq.positions.get("999")).toBe(1);
    expect(seq.positions.get("1000")).toBe(2);
    expect(seq.uncertain).toBe(false);
  });

  test("same millisecond inside one LINE image set orders by the set index", () => {
    const a = img(1, "attached", { eventTsMs: T0, imageSet: { id: "S", index: 2 } });
    const b = img(2, "attached", { eventTsMs: T0, imageSet: { id: "S", index: 1 } });
    const seq = sequenceBatchImages([a, b], new Set([a.lineMessageId, b.lineMessageId]));
    expect(seq.positions.get(b.lineMessageId)).toBe(1);
    expect(seq.uncertain).toBe(false);
  });

  describe("marks uncertain instead of inventing an order", () => {
    test("ledger time is a receipt-time fallback", () => {
      const seq = sequenceBatchImages([img(1), img(2, "attached", { lineTimestamp: false })], new Set());
      expect(seq.uncertain).toBe(true);
    });
    test("LINE image-set index contradicts the timestamps", () => {
      const seq = sequenceBatchImages([
        img(1, "attached", { imageSet: { id: "S", index: 2 } }),
        img(2, "attached", { imageSet: { id: "S", index: 1 } }),
      ], new Set());
      expect(seq.uncertain).toBe(true);
    });
    test("two separate sends in the same millisecond", () => {
      const seq = sequenceBatchImages([img(1, "attached", { eventTsMs: T0 }), img(2, "attached", { eventTsMs: T0 })], new Set());
      expect(seq.uncertain).toBe(true);
    });
    test("an evidence attached without a ledger row", () => {
      const seq = sequenceBatchImages([img(1)], new Set([img(1).lineMessageId, "legacy-id"]));
      expect(seq.uncertain).toBe(true);
    });
  });
});

describe("summary #N, amount and reason come from the same evidence", () => {
  const slipDate = "16/10/2569";
  // LINE order 1..6; download retries made 2 and 5 attach last.
  const images = [1, 2, 3, 4, 5, 6, 7].map((n) => img(n, n === 7 ? "failed_permanent" : "attached"));
  const evidences = [
    ev(1, 1),
    ev(3, 2, { transactionTime: null }),                       // missing date
    ev(4, 3, { transactionTime: "2026-10-10T12:00:00+07:00" }), // outside the period
    ev(6, 4, { checkStatus: "NEED_REVIEW", transferAmount: null }),
    ev(2, 5),
    ev(5, 6),
  ];
  const attached = new Set(evidences.map((e) => e.lineMessageId!));

  const render = (input: EvidenceWithCheck[]) => {
    const seq = sequenceBatchImages(shuffle(images, input.length), attached);
    return buildBatchSummaryMessage(orderByLineSequence(input, seq), {
      slipDate,
      missingImages: seq.missing,
      sequenceUncertain: seq.uncertain,
    });
  };

  test("every #N line carries its own image's amount and reason", () => {
    const text = render(evidences);
    expect(text).toContain("#1 เช็คได้ 101 บาท");
    expect(text).toContain("#2 เช็คได้ 102 บาท");
    expect(text).toContain("#3 ไม่พบวันที่รายการ");
    expect(text).toContain("#4 วันที่รายการไม่ตรงกับรอบ");
    expect(text).toContain("#5 เช็คได้ 105 บาท");
    expect(text).toContain("#6 ไม่พบข้อมูลครบถ้วน");
    expect(text).toContain("#7 รูปเข้าระบบไม่สำเร็จ");
    expect(text).toContain("รับทั้งหมด: 7 รูป");
    expect(text).toContain("อ่านครบ: 3 รูป");
    expect(text).toContain("รอตรวจมือ: 4 รูป");
    expect(text).toContain("ยอดรวมที่อ่านได้: 308 บาท");
    expect(text).not.toContain("ยืนยันลำดับจาก LINE ไม่ได้");
    // Review lines are listed in #N order.
    const review = text.split("รูปที่ต้องตรวจมือ:")[1];
    expect(review.match(/#\d+/g)).toEqual(["#3", "#4", "#6", "#7"]);
  });

  test("rendering is identical whatever order the evidences were loaded or attached in", () => {
    const first = render(evidences);
    for (let seed = 1; seed <= 10; seed++) expect(render(shuffle(evidences, seed))).toBe(first);
  });

  test("an in-batch duplicate keeps the image sent FIRST in LINE, not the one attached first", () => {
    const dupImages = [img(1), img(2)];
    const dup = [
      ev(2, 1, { referenceId: "REF-1" }), // sent second, attached first
      ev(1, 2, { referenceId: "REF-1" }),
    ];
    const seq = sequenceBatchImages(dupImages, new Set(dup.map((e) => e.lineMessageId!)));
    const text = buildBatchSummaryMessage(orderByLineSequence(dup, seq), { slipDate });
    expect(text).toContain("#1 เช็คได้ 101 บาท");
    expect(text).toContain("#2 สลิปซ้ำ");
  });

  test("evidence the ledger cannot place is shown as #? with a warning, never a guessed number", () => {
    const seq = sequenceBatchImages([img(1)], new Set([img(1).lineMessageId, "legacy-id"]));
    const text = buildBatchSummaryMessage(
      orderByLineSequence([ev(1, 1), { ...ev(9, 2), lineMessageId: "legacy-id" }], seq),
      { slipDate, missingImages: seq.missing, sequenceUncertain: seq.uncertain },
    );
    expect(text).toContain("#1 เช็คได้ 101 บาท");
    expect(text).toContain("#? เช็คได้ 109 บาท");
    expect(text).toContain("ยืนยันลำดับจาก LINE ไม่ได้");
  });
});
